BEGIN;
ALTER TABLE task_assignments ADD UNIQUE (id,task_id);
ALTER TABLE tasks ADD UNIQUE (id,project_id);

CREATE TABLE task_time_segments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 employee_id uuid NOT NULL,
 assignment_id uuid NOT NULL,
 task_id uuid NOT NULL,
 shift_id uuid NOT NULL,
 timer_id uuid NOT NULL,
 segment_sequence integer NOT NULL CHECK (segment_sequence>0),
 timer_state text CHECK (timer_state IN ('RUNNING','PAUSED','STOPPED')),
 timer_version integer CHECK (timer_version>0),
 timer_closed_at timestamptz,
 timer_close_reason text,
 operation_receipts jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(operation_receipts)='object'),
 kind text NOT NULL CHECK (kind IN ('ORIGINAL','REVISION')),
 revision_review_id uuid REFERENCES task_reviews(id) ON DELETE RESTRICT,
 policy_id uuid NOT NULL REFERENCES policy_versions(id) ON DELETE RESTRICT,
 task_label text NOT NULL,
 project_label text NOT NULL,
 recorded_start timestamptz NOT NULL,
 recorded_end timestamptz,
 started_at timestamptz NOT NULL,
 ended_at timestamptz,
 ended_by uuid REFERENCES users(id) ON DELETE RESTRICT,
 end_reason text,
 observed_end timestamptz,
 version integer NOT NULL DEFAULT 1 CHECK (version>0),
 UNIQUE(id,employee_id), UNIQUE(id,employee_id,assignment_id,shift_id), UNIQUE(timer_id,segment_sequence),
 FOREIGN KEY(assignment_id,employee_id) REFERENCES task_assignments(id,employee_id) ON DELETE RESTRICT,
 FOREIGN KEY(assignment_id,task_id) REFERENCES task_assignments(id,task_id) ON DELETE RESTRICT,
 FOREIGN KEY(shift_id,employee_id) REFERENCES attendance_shifts(id,employee_id) ON DELETE RESTRICT,
 FOREIGN KEY(timer_id,employee_id,assignment_id,shift_id) REFERENCES task_time_segments(id,employee_id,assignment_id,shift_id) ON DELETE RESTRICT,
 CHECK ((kind='REVISION')=(revision_review_id IS NOT NULL)),
 CHECK ((id=timer_id AND segment_sequence=1 AND timer_state IS NOT NULL AND timer_version IS NOT NULL) OR
        (id<>timer_id AND segment_sequence>1 AND timer_state IS NULL AND timer_version IS NULL AND operation_receipts='{}')),
 CHECK ((timer_state IS NOT DISTINCT FROM 'STOPPED')=(timer_closed_at IS NOT NULL AND timer_close_reason IS NOT NULL)),
 CHECK (timer_closed_at IS NULL OR timer_closed_at>=recorded_start),
 CHECK (ended_at>=started_at AND recorded_end>=recorded_start OR (ended_at IS NULL AND recorded_end IS NULL)),
 CHECK ((ended_at IS NULL AND recorded_end IS NULL AND end_reason IS NULL AND observed_end IS NULL AND ended_by IS NULL) OR
        (ended_at IS NOT NULL AND recorded_end IS NOT NULL AND end_reason IS NOT NULL AND observed_end IS NOT NULL)),
 EXCLUDE USING gist(employee_id WITH =, tstzrange(started_at,ended_at,'[)') WITH &&) DEFERRABLE INITIALLY IMMEDIATE
);
CREATE UNIQUE INDEX time_one_open_segment ON task_time_segments(employee_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX time_one_live_root ON task_time_segments(employee_id) WHERE timer_state IN ('RUNNING','PAUSED');
CREATE INDEX time_by_shift ON task_time_segments(shift_id,started_at);
CREATE INDEX time_by_assignment ON task_time_segments(assignment_id,started_at);
CREATE INDEX time_by_task ON task_time_segments(task_id) WHERE timer_state IN ('RUNNING','PAUSED');
CREATE INDEX time_by_start ON task_time_segments(started_at);

CREATE TABLE task_segment_adjustments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 segment_id uuid NOT NULL,
 employee_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 2000),
 before_start timestamptz NOT NULL, before_end timestamptz NOT NULL,
 after_start timestamptz NOT NULL, after_end timestamptz NOT NULL,
 before_version integer NOT NULL, after_version integer NOT NULL,
 created_at timestamptz NOT NULL,
 operation_key uuid NOT NULL, fingerprint text NOT NULL,
 attendance_adjustment_id uuid REFERENCES attendance_adjustments(id) ON DELETE RESTRICT,
 FOREIGN KEY(segment_id,employee_id) REFERENCES task_time_segments(id,employee_id) ON DELETE RESTRICT,
 UNIQUE(actor_id,operation_key), UNIQUE(segment_id,after_version),
 CHECK(before_start<=before_end AND after_start<=after_end AND after_version=before_version+1)
);

CREATE TABLE daily_reports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 employee_id uuid NOT NULL REFERENCES employee_profiles(user_id) ON DELETE RESTRICT,
 report_date date NOT NULL,
 work_in_progress text NOT NULL DEFAULT '' CHECK(length(work_in_progress)<=5000),
 issues text NOT NULL DEFAULT '' CHECK(length(issues)<=5000),
 notes text NOT NULL DEFAULT '' CHECK(length(notes)<=5000),
 next_steps text NOT NULL DEFAULT '' CHECK(length(next_steps)<=5000),
 state text NOT NULL DEFAULT 'DRAFT' CHECK(state IN ('DRAFT','SUBMITTED')),
 submitted_at timestamptz,
 created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 updated_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 operation_receipts jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(operation_receipts)='object'),
 UNIQUE(employee_id,report_date), UNIQUE(id,employee_id),
 CHECK((state='SUBMITTED')=(submitted_at IS NOT NULL)),
 CHECK(created_by=employee_id AND updated_by=employee_id)
);
CREATE INDEX daily_reports_by_date ON daily_reports(report_date,employee_id);
CREATE TABLE daily_report_entries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 report_id uuid NOT NULL, employee_id uuid NOT NULL,
 assignment_id uuid NOT NULL, task_id uuid NOT NULL, project_id uuid NOT NULL,
 description text NOT NULL CHECK(length(description)<=2000),
 reported_complete boolean NOT NULL DEFAULT false,
 included boolean NOT NULL DEFAULT true,
 task_label text NOT NULL, project_label text NOT NULL, captured_status text NOT NULL,
 created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 UNIQUE(report_id,assignment_id),
 FOREIGN KEY(report_id,employee_id) REFERENCES daily_reports(id,employee_id) ON DELETE RESTRICT,
 FOREIGN KEY(assignment_id,employee_id) REFERENCES task_assignments(id,employee_id) ON DELETE RESTRICT,
 FOREIGN KEY(assignment_id,task_id) REFERENCES task_assignments(id,task_id) ON DELETE RESTRICT,
 FOREIGN KEY(task_id,project_id) REFERENCES tasks(id,project_id) ON DELETE RESTRICT
);

DO $$
DECLARE relation text;
BEGIN
 FOREACH relation IN ARRAY ARRAY['task_time_segments','task_segment_adjustments','daily_reports','daily_report_entries'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, libetario_auth, libetario_runtime',relation);
  EXECUTE format('CREATE POLICY time_own_read ON public.%I FOR SELECT TO libetario_runtime USING (private.attendance_visible(employee_id))',relation);
  EXECUTE format('GRANT SELECT ON public.%I TO libetario_runtime',relation);
 END LOOP;
END $$;

CREATE FUNCTION private.time_preserve() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP<>'UPDATE' OR TG_TABLE_NAME='task_segment_adjustments' THEN
  RAISE EXCEPTION 'Time evidence is retained' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME='task_time_segments' THEN
  IF (NEW.id,NEW.employee_id,NEW.assignment_id,NEW.task_id,NEW.shift_id,NEW.timer_id,NEW.segment_sequence,NEW.kind,NEW.revision_review_id,NEW.policy_id,NEW.task_label,NEW.project_label,NEW.recorded_start)
    IS DISTINCT FROM (OLD.id,OLD.employee_id,OLD.assignment_id,OLD.task_id,OLD.shift_id,OLD.timer_id,OLD.segment_sequence,OLD.kind,OLD.revision_review_id,OLD.policy_id,OLD.task_label,OLD.project_label,OLD.recorded_start)
    OR (OLD.recorded_end IS NOT NULL AND (NEW.recorded_end,NEW.ended_by,NEW.end_reason,NEW.observed_end) IS DISTINCT FROM (OLD.recorded_end,OLD.ended_by,OLD.end_reason,OLD.observed_end))
    OR (OLD.timer_state='STOPPED' AND (NEW.timer_state,NEW.timer_closed_at,NEW.timer_close_reason,NEW.timer_version) IS DISTINCT FROM (OLD.timer_state,OLD.timer_closed_at,OLD.timer_close_reason,OLD.timer_version)) THEN
   RAISE EXCEPTION 'Original timer evidence is immutable' USING ERRCODE='23514';
  END IF;
 ELSIF TG_TABLE_NAME='daily_reports' THEN
  IF OLD.state='SUBMITTED' OR (NEW.id,NEW.employee_id,NEW.report_date,NEW.created_at,NEW.created_by) IS DISTINCT FROM (OLD.id,OLD.employee_id,OLD.report_date,OLD.created_at,OLD.created_by) THEN
   RAISE EXCEPTION 'Report is frozen' USING ERRCODE='23514';
  END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM daily_reports WHERE id=OLD.report_id AND state='SUBMITTED') OR
   (NEW.id,NEW.report_id,NEW.employee_id,NEW.assignment_id,NEW.task_id,NEW.project_id,NEW.created_at) IS DISTINCT FROM
   (OLD.id,OLD.report_id,OLD.employee_id,OLD.assignment_id,OLD.task_id,OLD.project_id,OLD.created_at) THEN
   RAISE EXCEPTION 'Report entry is frozen' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
DO $$
DECLARE relation text;
BEGIN
 FOREACH relation IN ARRAY ARRAY['task_time_segments','task_segment_adjustments','daily_reports','daily_report_entries'] LOOP
  EXECUTE format('CREATE TRIGGER preserve_time BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION private.time_preserve()',relation);
  EXECUTE format('CREATE TRIGGER no_truncate_time BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION private.time_preserve()',relation);
 END LOOP;
END $$;

CREATE FUNCTION private.time_check_shift(target uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS (
  SELECT 1 FROM task_time_segments seg JOIN attendance_shifts s ON s.id=seg.shift_id
  WHERE s.id=target AND (
   seg.started_at<s.clocked_in_at OR seg.started_at>s.grant_until OR seg.ended_at>s.grant_until
   OR (s.clocked_out_at IS NOT NULL AND (seg.ended_at IS NULL OR seg.ended_at>s.clocked_out_at OR seg.timer_state IN ('RUNNING','PAUSED')))
   OR EXISTS(SELECT 1 FROM attendance_breaks b WHERE b.shift_id=s.id AND NOT b.is_voided
       AND tstzrange(b.started_at,b.ended_at,'[)') && tstzrange(seg.started_at,seg.ended_at,'[)'))
  )
 ) THEN RAISE EXCEPTION 'Segment conflicts with shift or break' USING ERRCODE='P0409'; END IF;
END $$;

CREATE FUNCTION private.time_check_integrity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE seg task_time_segments%ROWTYPE; root task_time_segments%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='attendance_shifts' THEN
  PERFORM private.time_check_shift(NEW.id);
 ELSIF TG_TABLE_NAME='attendance_breaks' THEN
  PERFORM private.time_check_shift(NEW.shift_id);
 ELSE
  SELECT * INTO seg FROM task_time_segments WHERE id=NEW.id;
  SELECT * INTO root FROM task_time_segments WHERE id=seg.timer_id;
  IF root.id<>root.timer_id OR root.kind<>seg.kind OR root.revision_review_id IS DISTINCT FROM seg.revision_review_id
    OR root.policy_id<>seg.policy_id
    OR NOT EXISTS(SELECT 1 FROM policy_versions WHERE id=seg.policy_id AND policy_key='WORK')
    OR (seg.kind='REVISION' AND NOT EXISTS(
      SELECT 1 FROM task_reviews r JOIN task_submissions sub ON sub.id=r.submission_id
      WHERE r.id=seg.revision_review_id AND r.decision='REVISION_REQUIRED' AND sub.assignment_id=seg.assignment_id
    ))
    OR (root.timer_state='RUNNING')<>(EXISTS(SELECT 1 FROM task_time_segments WHERE timer_id=root.id AND ended_at IS NULL)) THEN
   RAISE EXCEPTION 'Invalid logical timer or revision' USING ERRCODE='23514';
  END IF;
  PERFORM private.time_check_shift(seg.shift_id);
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER time_segment_integrity AFTER INSERT OR UPDATE ON task_time_segments
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.time_check_integrity();
CREATE CONSTRAINT TRIGGER time_shift_integrity AFTER UPDATE OF clocked_in_at,clocked_out_at ON attendance_shifts
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.time_check_integrity();
CREATE CONSTRAINT TRIGGER time_break_integrity AFTER INSERT OR UPDATE OF started_at,ended_at,is_voided ON attendance_breaks
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.time_check_integrity();
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC;
COMMIT;
