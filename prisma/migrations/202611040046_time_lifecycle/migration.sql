BEGIN;
CREATE FUNCTION private.time_on_lifecycle() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE root_id uuid; instant timestamptz; cause text;
BEGIN
 IF TG_TABLE_NAME='attendance_shifts' THEN
  IF OLD.clocked_out_at IS NULL AND NEW.clocked_out_at IS NOT NULL THEN
   SELECT id INTO root_id FROM task_time_segments WHERE shift_id=NEW.id AND timer_state IN ('RUNNING','PAUSED');
   IF root_id IS NOT NULL THEN
    PERFORM private.time_transition(root_id,'STOPPED',NEW.clocked_out_at,NEW.close_reason,NEW.close_source='SYSTEM');
   END IF;
  END IF;
 ELSIF TG_TABLE_NAME='attendance_breaks' THEN
  IF NEW.ended_at IS NULL AND NOT NEW.is_voided THEN
   SELECT id INTO root_id FROM task_time_segments WHERE shift_id=NEW.shift_id AND timer_state='RUNNING';
   IF root_id IS NOT NULL THEN PERFORM private.time_transition(root_id,'PAUSED',NEW.started_at,'BREAK_START'); END IF;
  END IF;
 ELSIF TG_TABLE_NAME='projects' THEN
  IF OLD.status='ACTIVE' AND NEW.status<>'ACTIVE' THEN
   FOR root_id IN SELECT seg.id FROM task_time_segments seg JOIN tasks t ON t.id=seg.task_id
     WHERE t.project_id=NEW.id AND seg.timer_state IN ('RUNNING','PAUSED') ORDER BY seg.employee_id
   LOOP
    PERFORM private.time_transition(root_id,'STOPPED',NEW.status_changed_at,'PROJECT_LEFT_ACTIVE',true);
   END LOOP;
  END IF;
 ELSE
  IF OLD.access_revoked_at IS NULL AND NEW.access_revoked_at IS NOT NULL THEN
   cause='ASSIGNMENT_WITHDRAWN';instant=NEW.access_revoked_at;
  ELSIF OLD.status<>NEW.status AND NEW.status IN ('CANCELLED','SUBMITTED','APPROVED') THEN
   cause=CASE NEW.status WHEN 'CANCELLED' THEN 'TASK_CANCELLED' ELSE NEW.status END;
   instant=NEW.status_changed_at;
  END IF;
  IF cause IS NOT NULL THEN
   SELECT id INTO root_id FROM task_time_segments WHERE assignment_id=NEW.id AND timer_state IN ('RUNNING','PAUSED');
   IF root_id IS NOT NULL THEN PERFORM private.time_transition(root_id,'STOPPED',instant,cause,true); END IF;
  END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER time_close_with_shift AFTER UPDATE OF clocked_out_at ON attendance_shifts FOR EACH ROW EXECUTE FUNCTION private.time_on_lifecycle();
CREATE TRIGGER time_pause_with_break AFTER INSERT ON attendance_breaks FOR EACH ROW EXECUTE FUNCTION private.time_on_lifecycle();
CREATE TRIGGER time_stop_with_assignment AFTER UPDATE OF status,access_revoked_at ON task_assignments FOR EACH ROW EXECUTE FUNCTION private.time_on_lifecycle();
CREATE TRIGGER time_stop_with_project AFTER UPDATE OF status ON projects FOR EACH ROW EXECUTE FUNCTION private.time_on_lifecycle();

CREATE FUNCTION private.correct_task_segment(target uuid, data jsonb, linked_adjustment uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
 actor uuid; employee uuid; seg task_time_segments%ROWTYPE; root task_time_segments%ROWTYPE; shift attendance_shifts%ROWTYPE;
 start_at timestamptz; end_at timestamptz; instant timestamptz; note text=btrim(data->>'reason');
 operation uuid=(data->>'operationKey')::uuid; fp text; previous task_segment_adjustments%ROWTYPE; result uuid;
BEGIN
 IF NOT private.is_admin() THEN RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501'; END IF;
 SELECT employee_id INTO employee FROM task_time_segments WHERE id=target;
 IF employee IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
 IF linked_adjustment IS NULL THEN
  actor=private.attendance_lock(employee,true,true);
  PERFORM 1 FROM duty_authorizations WHERE id=(SELECT s.duty_id FROM attendance_shifts s JOIN task_time_segments t ON t.shift_id=s.id WHERE t.id=target) FOR UPDATE;
 ELSE
  -- The only internal caller already holds the employee, duty, shift, and break locks.
  actor=private.work_actor();
 END IF;
 SELECT * INTO shift FROM attendance_shifts WHERE id=(SELECT shift_id FROM task_time_segments WHERE id=target) FOR UPDATE;
 PERFORM 1 FROM attendance_breaks WHERE shift_id=shift.id ORDER BY id FOR UPDATE;
 SELECT * INTO root FROM task_time_segments WHERE id=(SELECT timer_id FROM task_time_segments WHERE id=target) FOR UPDATE;
 SELECT * INTO seg FROM task_time_segments WHERE id=target FOR UPDATE;
 PERFORM private.attendance_note(note);
 IF NOT private.admin_recent() THEN RAISE EXCEPTION 'Recent MFA required' USING ERRCODE='42501'; END IF;
 IF operation IS NULL OR (data->>'startedAt') !~ '(Z|[+-][0-9]{2}:[0-9]{2})$' OR (data->>'endedAt') !~ '(Z|[+-][0-9]{2}:[0-9]{2})$' THEN
  RAISE EXCEPTION 'Timestamp offsets and operation key required' USING ERRCODE='22023';
 END IF;
 start_at=(data->>'startedAt')::timestamptz;end_at=(data->>'endedAt')::timestamptz;
 fp=private.work_fingerprint(jsonb_build_array(target,start_at,end_at,note,data->'expectedVersion',data->'expectedTimerVersion',data->'expectedShiftVersion',linked_adjustment));
 SELECT * INTO previous FROM task_segment_adjustments WHERE actor_id=actor AND operation_key=operation;
 IF previous.id IS NOT NULL THEN
  IF previous.fingerprint<>fp THEN RAISE EXCEPTION 'Retry key conflict' USING ERRCODE='40001'; END IF;
  RETURN previous.id;
 END IF;
 IF seg.ended_at IS NULL OR root.timer_state<>'STOPPED' OR shift.clocked_out_at IS NULL OR
   seg.version IS DISTINCT FROM (data->>'expectedVersion')::integer OR
   root.timer_version IS DISTINCT FROM (data->>'expectedTimerVersion')::integer OR
   (linked_adjustment IS NULL AND shift.version IS DISTINCT FROM (data->>'expectedShiftVersion')::integer) THEN
  RAISE EXCEPTION 'Stopped timer and unchanged closed shift required' USING ERRCODE='P0409';
 END IF;
 IF linked_adjustment IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM attendance_adjustments WHERE id=linked_adjustment AND employee_id=employee AND applied_shift_id=shift.id AND status='APPROVED'
 ) THEN RAISE EXCEPTION 'Segment must belong to the corrected shift' USING ERRCODE='P0409'; END IF;
 instant=private.security_now();
 IF start_at IS NULL OR end_at IS NULL OR start_at<shift.clocked_in_at OR end_at<start_at OR end_at>shift.clocked_out_at OR end_at>instant THEN
  RAISE EXCEPTION 'Corrected interval is outside the shift' USING ERRCODE='P0409';
 END IF;
 INSERT INTO task_segment_adjustments(segment_id,employee_id,actor_id,reason,before_start,before_end,after_start,after_end,before_version,after_version,created_at,operation_key,fingerprint,attendance_adjustment_id)
 VALUES(target,employee,actor,note,seg.started_at,seg.ended_at,start_at,end_at,seg.version,seg.version+1,instant,operation,fp,linked_adjustment) RETURNING id INTO result;
 UPDATE task_time_segments SET started_at=start_at,ended_at=end_at,version=version+1 WHERE id=target;
 IF linked_adjustment IS NULL THEN
  UPDATE attendance_shifts SET approval_status='PENDING',approved_payable_seconds=NULL,suggested_at_review=NULL,review_mode=NULL,
   reviewed_by=NULL,reviewed_at=NULL,review_reason=NULL,acknowledged_flags='{}',flags=array_append(array_remove(flags,'TASK_TIME_CORRECTED'),'TASK_TIME_CORRECTED'),
   version=version+1,updated_at=instant WHERE id=shift.id;
 END IF;
 PERFORM private.attendance_audit('timer.corrected',jsonb_build_object('adjustment_id',result,'segment_id',target,'employee_id',employee,'shift_id',shift.id,'reason',note,
  'before',jsonb_build_array(seg.started_at,seg.ended_at),'after',jsonb_build_array(start_at,end_at),'prior_attendance_approval',shift.approval_status,
  'prior_approved_seconds',shift.approved_payable_seconds,'attendance_adjustment_id',linked_adjustment));
 RETURN result;
END $$;
CREATE FUNCTION private.review_task_segment(target uuid,data jsonb) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT private.correct_task_segment(target,data,NULL)
$$;

-- Replacements for the existing guarded commands are installed below.

CREATE OR REPLACE FUNCTION private.edit_project(target uuid,expected integer,data jsonb,note text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid;oldrow public.projects%ROWTYPE;newrow public.projects%ROWTYPE; affected uuid[];
BEGIN
 IF NOT private.is_admin() THEN RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501';END IF;
 SELECT coalesce(array_agg(seg.employee_id),'{}') INTO affected FROM task_time_segments seg JOIN tasks t ON t.id=seg.task_id
 WHERE t.project_id=target AND seg.timer_state IN ('RUNNING','PAUSED') AND data->>'status'<>'ACTIVE';
 actor=private.lock_work(true,affected);PERFORM private.work_note(note);
 SELECT * INTO oldrow FROM public.projects WHERE id=target FOR UPDATE;
 IF oldrow.id IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
 IF expected IS DISTINCT FROM oldrow.version THEN RAISE EXCEPTION 'Version conflict' USING ERRCODE='40001';END IF;
 IF oldrow.status='ACTIVE' AND data->>'status'<>'ACTIVE' AND EXISTS(
  SELECT 1 FROM task_time_segments seg JOIN tasks t ON t.id=seg.task_id WHERE t.project_id=target
  AND seg.timer_state IN ('RUNNING','PAUSED') AND NOT seg.employee_id=ANY(affected)
 ) THEN RAISE EXCEPTION 'Timer roster changed; retry project edit' USING ERRCODE='40001'; END IF;
 UPDATE public.projects SET code=coalesce(data->>'code',code),name=coalesce(data->>'name',name),
 client_label=CASE WHEN data ? 'clientLabel' THEN data->>'clientLabel' ELSE client_label END,website_url=CASE WHEN data ? 'websiteUrl' THEN data->>'websiteUrl' ELSE website_url END,
 description=coalesce(data->>'description',description),reference_links=coalesce(data->'references',reference_links),start_date=CASE WHEN data ? 'startDate' THEN (data->>'startDate')::date ELSE start_date END,
 deadline_at=CASE WHEN data ? 'deadlineAt' THEN (data->>'deadlineAt')::timestamptz ELSE deadline_at END,priority=coalesce(data->>'priority',priority),status=coalesce(data->>'status',status),
 status_changed_by=CASE WHEN data ? 'status' AND data->>'status'<>status THEN actor ELSE status_changed_by END,status_changed_at=CASE WHEN data ? 'status' AND data->>'status'<>status THEN private.security_now() ELSE status_changed_at END,
 updated_at=private.security_now(),version=version+1 WHERE id=target RETURNING * INTO newrow;
 PERFORM private.work_audit('project.updated',jsonb_build_object('project_id',target,'before',to_jsonb(oldrow)-'creation_fingerprint','after',to_jsonb(newrow)-'creation_fingerprint','reason',note));
END $$;

CREATE OR REPLACE FUNCTION private.task_progress(target uuid,expected integer,next_state text,note text DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid;t public.tasks%ROWTYPE;a public.task_assignments%ROWTYPE;admin boolean;affected uuid[];
BEGIN
 admin=private.is_admin();
 SELECT coalesce(array_agg(employee_id),'{}') INTO affected FROM task_time_segments
 WHERE admin AND next_state='CANCELLED' AND task_id=target AND timer_state IN ('RUNNING','PAUSED');
 actor=private.lock_work(false,affected);t=private.lock_task(target);
 IF admin AND next_state='CANCELLED' AND EXISTS(SELECT 1 FROM task_time_segments WHERE task_id=target
 AND timer_state IN ('RUNNING','PAUSED') AND NOT employee_id=ANY(affected)) THEN
  RAISE EXCEPTION 'Timer roster changed; retry task update' USING ERRCODE='40001';
 END IF;
 IF next_state IS NULL OR next_state NOT IN ('PENDING','IN_PROGRESS','CANCELLED') THEN RAISE EXCEPTION 'Review workflow is unavailable in 3a' USING ERRCODE='22023';END IF;
 IF admin THEN
  PERFORM private.work_note(note);
  IF expected IS DISTINCT FROM t.version THEN RAISE EXCEPTION 'Version conflict' USING ERRCODE='40001';END IF;
  IF NOT ((t.status IN ('PENDING','IN_PROGRESS','SUBMITTED','REVISION_REQUIRED') AND next_state='CANCELLED') OR (t.status='CANCELLED' AND next_state='PENDING')) THEN RAISE EXCEPTION 'Invalid administrator transition' USING ERRCODE='22023';END IF;
  IF next_state='PENDING' AND ((SELECT status FROM public.projects WHERE id=t.project_id)<>'ACTIVE' OR NOT EXISTS(SELECT 1 FROM public.task_assignments WHERE task_id=target AND access_revoked_at IS NULL)) THEN RAISE EXCEPTION 'Active project and recipients required' USING ERRCODE='22023';END IF;
  FOR a IN SELECT * FROM public.task_assignments WHERE task_id=target AND access_revoked_at IS NULL AND status<>'APPROVED' ORDER BY id FOR UPDATE LOOP
   IF a.status=next_state THEN CONTINUE;END IF;
   UPDATE public.task_assignments SET current_submission_id=NULL,status=next_state,counts_for_completion=next_state<>'CANCELLED',status_changed_by=actor,status_changed_at=private.security_now(),updated_at=private.security_now(),version=version+1 WHERE id=a.id;
   PERFORM private.work_audit('assignment.status',jsonb_build_object('task_id',target,'assignment_id',a.id,'employee_id',a.employee_id,'from',a.status,'to',next_state,'reason',note,'version',a.version+1));
  END LOOP;
  UPDATE public.task_submissions SET state='ABANDONED',version=version+1,updated_at=private.security_now() WHERE state='DRAFT' AND assignment_id IN (SELECT id FROM public.task_assignments WHERE task_id=target AND status='CANCELLED');
  UPDATE public.tasks SET status=next_state,status_changed_by=actor,status_changed_at=private.security_now(),updated_at=private.security_now(),version=version+1 WHERE id=target;
  PERFORM private.work_audit('task.status',jsonb_build_object('task_id',target,'from',t.status,'to',next_state,'reason',note,'version',t.version+1));
  IF next_state='PENDING' THEN PERFORM private.refresh_task(target,note);END IF;
 ELSE
  SELECT * INTO a FROM public.task_assignments WHERE task_id=target AND employee_id=actor AND access_revoked_at IS NULL FOR UPDATE;
  IF a.id IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
  IF expected IS DISTINCT FROM a.version THEN RAISE EXCEPTION 'Version conflict' USING ERRCODE='40001';END IF;
  IF (SELECT status FROM public.projects WHERE id=t.project_id)<>'ACTIVE' OR t.status='CANCELLED' OR a.status NOT IN ('PENDING','REVISION_REQUIRED') OR next_state<>'IN_PROGRESS' THEN RAISE EXCEPTION 'Progress is read-only or transition invalid' USING ERRCODE='22023';END IF;
  UPDATE public.task_assignments SET status='IN_PROGRESS',status_changed_by=actor,status_changed_at=private.security_now(),updated_at=private.security_now(),version=version+1 WHERE id=a.id;
  PERFORM private.work_audit('assignment.status',jsonb_build_object('task_id',target,'assignment_id',a.id,'employee_id',actor,'from',a.status,'to','IN_PROGRESS','version',a.version+1));
  PERFORM private.refresh_task(target);
 END IF;
END $$;

CREATE OR REPLACE FUNCTION private.review_submission(target uuid,expected integer,decision text,note text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid;s public.task_submissions%ROWTYPE;a public.task_assignments%ROWTYPE;r public.task_reviews%ROWTYPE;result uuid;
BEGIN
 actor=private.lock_work(true,ARRAY[(SELECT created_by FROM task_submissions WHERE id=target)]);s=private.lock_submission(target);PERFORM private.assert_submission_open(s);
 SELECT * INTO a FROM public.task_assignments WHERE id=s.assignment_id;
 IF s.state<>'SUBMITTED' OR a.current_submission_id IS DISTINCT FROM target OR expected IS DISTINCT FROM s.version OR decision IS NULL OR decision NOT IN ('APPROVED','REVISION_REQUIRED') OR note IS NULL OR length(note)>2000 OR (decision='REVISION_REQUIRED' AND length(btrim(note)) NOT BETWEEN 10 AND 2000) THEN RAISE EXCEPTION 'Current submission and valid review required' USING ERRCODE='22023';END IF;
 SELECT * INTO r FROM public.task_reviews WHERE submission_id=target;
 IF r.id IS NOT NULL THEN IF r.decision=decision AND r.reason=note THEN RETURN r.id;END IF;RAISE EXCEPTION 'Review already recorded' USING ERRCODE='40001';END IF;
 IF a.status<>'SUBMITTED' THEN RAISE EXCEPTION 'Submission is no longer awaiting review' USING ERRCODE='40001';END IF;
 INSERT INTO public.task_reviews(submission_id,reviewer_id,decision,reason) VALUES(target,actor,decision,note) RETURNING id INTO result;
 UPDATE public.task_assignments SET status=decision,status_changed_by=actor,status_changed_at=private.security_now(),updated_at=private.security_now(),version=version+1 WHERE id=a.id;
 PERFORM private.work_audit('assignment.status',jsonb_build_object('task_id',a.task_id,'assignment_id',a.id,'employee_id',a.employee_id,'submission_id',target,'review_id',result,'from','SUBMITTED','to',decision,'reason',note));
 PERFORM private.refresh_task(a.task_id);RETURN result;
END $$;

CREATE OR REPLACE FUNCTION private.submit_submission(target uuid,expected integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid;s public.task_submissions%ROWTYPE;a public.task_assignments%ROWTYPE;instant timestamptz;
BEGIN
 actor=private.lock_work();IF private.is_admin() THEN RAISE EXCEPTION 'Employee submits own work' USING ERRCODE='42501';END IF;
 s=private.lock_submission(target);PERFORM private.assert_submission_open(s);
 SELECT * INTO a FROM public.task_assignments WHERE id=s.assignment_id;
 IF s.state<>'DRAFT' OR expected IS DISTINCT FROM s.version OR a.status NOT IN ('IN_PROGRESS','REVISION_REQUIRED') THEN RAISE EXCEPTION 'Current draft required' USING ERRCODE='40001';END IF;
 PERFORM 1 FROM public.file_objects f JOIN public.submission_files x ON x.file_id=f.id WHERE x.submission_id=target AND x.excluded_at IS NULL ORDER BY f.id FOR UPDATE OF f;
 IF EXISTS(SELECT 1 FROM public.file_objects f JOIN public.submission_files x ON x.file_id=f.id WHERE x.submission_id=target AND x.excluded_at IS NULL AND f.state<>'AVAILABLE') OR (length(btrim(s.notes))=0 AND jsonb_array_length(s.urls)=0 AND NOT EXISTS(SELECT 1 FROM public.submission_files WHERE submission_id=target AND excluded_at IS NULL)) THEN RAISE EXCEPTION 'Complete content and available attachments required' USING ERRCODE='22023';END IF;
 IF private.work_actor() IS DISTINCT FROM actor THEN RAISE EXCEPTION 'Current duty required' USING ERRCODE='42501'; END IF;
 instant=private.security_now();
 UPDATE public.task_submissions SET state='SUBMITTED',submitted_at=instant,updated_at=instant,version=version+1 WHERE id=target;
 UPDATE public.task_assignments SET current_submission_id=target,status='SUBMITTED',status_changed_by=actor,status_changed_at=instant,updated_at=instant,version=version+1 WHERE id=a.id;
 PERFORM private.work_audit('assignment.status',jsonb_build_object('task_id',a.task_id,'assignment_id',a.id,'employee_id',actor,'submission_id',target,'from',a.status,'to','SUBMITTED'));
 PERFORM private.refresh_task(a.task_id);
END $$;

CREATE OR REPLACE FUNCTION private.attendance_force_close(target uuid,observed timestamptz,cause text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.attendance_shifts%ROWTYPE;ending timestamptz;before_values jsonb;who uuid;actor uuid=private.work_actor();
BEGIN
 SELECT employee_id INTO who FROM attendance_shifts WHERE id=target;
 PERFORM 1 FROM users WHERE id=who FOR UPDATE;
 PERFORM 1 FROM duty_authorizations WHERE id=(SELECT duty_id FROM attendance_shifts WHERE id=target) FOR UPDATE;
 SELECT * INTO s FROM attendance_shifts WHERE id=target FOR UPDATE;
 IF s.id IS NULL OR s.clocked_out_at IS NOT NULL THEN RETURN;END IF;
 PERFORM 1 FROM attendance_breaks WHERE shift_id=target ORDER BY id FOR UPDATE;
 before_values=private.attendance_snapshot(target);
 ending=greatest(s.clocked_in_at,least(observed,s.grant_until),(SELECT max(greatest(started_at,ended_at)) FROM attendance_breaks WHERE shift_id=target AND NOT is_voided),(SELECT max(greatest(recorded_start,recorded_end)) FROM task_time_segments WHERE shift_id=target));
 UPDATE attendance_breaks SET ended_at=ending,system_end_at=observed,end_reason=cause,ended_by=actor,version=version+1,updated_at=observed WHERE shift_id=target AND ended_at IS NULL AND NOT is_voided;
 UPDATE attendance_shifts SET clocked_out_at=ending,system_closed_at=observed,close_source='SYSTEM',close_reason=cause,closed_by=actor,
 flags=flags||ARRAY[cause,'SYSTEM_CLOSED','MISSING_CLOCK_OUT']||CASE WHEN ending>observed THEN ARRAY['CLOCK_ANOMALY'] ELSE '{}'::text[] END,version=version+1,updated_at=observed WHERE id=target;
 UPDATE attendance_shifts SET flags=array_remove(private.attendance_flags(target,observed),'CORRECTION_PENDING') WHERE id=target;
 PERFORM private.attendance_audit('attendance.system_closed',jsonb_build_object('shift_id',target,'employee_id',s.employee_id,'reason',cause,'observed_at',observed,'effective_end',ending,'before',before_values,'after',private.attendance_snapshot(target)));
END $$;

CREATE OR REPLACE FUNCTION private.attendance_command(action text,target uuid,key uuid,expected integer,break_code text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid;s public.attendance_shifts%ROWTYPE;b public.attendance_breaks%ROWTYPE;d record;t timestamptz;cfg jsonb;fp text;result uuid;rule jsonb;sched record;snap jsonb;allowance integer;before_values jsonb;
BEGIN
 actor=private.work_actor();IF actor IS NULL OR private.is_admin() THEN RAISE EXCEPTION 'Employee duty required' USING ERRCODE='42501';END IF;
 IF key IS NULL OR action IS NULL OR action NOT IN('CLOCK_IN','CLOCK_OUT','BREAK_START','BREAK_END') THEN RAISE EXCEPTION 'Invalid attendance command' USING ERRCODE='22023';END IF;
 PERFORM private.attendance_lock(actor);PERFORM private.attendance_reconcile_employee(actor);
 SELECT * INTO d FROM private.duty_context();IF d.user_id IS DISTINCT FROM actor THEN RAISE EXCEPTION 'Current duty required' USING ERRCODE='42501';END IF;
 t=private.security_now();fp=private.work_fingerprint(jsonb_build_object('action',action,'target',target,'expected',expected,'code',break_code));
 IF action='CLOCK_IN' THEN
  SELECT * INTO s FROM attendance_shifts WHERE employee_id=actor AND clock_in_key=key;
  IF s.id IS NOT NULL THEN IF s.clock_in_fingerprint<>fp THEN RAISE EXCEPTION 'Retry key conflict' USING ERRCODE='40001';END IF;RETURN s.id;END IF;
  IF target IS NOT NULL OR expected IS NOT NULL OR break_code IS NOT NULL THEN RAISE EXCEPTION 'Invalid Clock In' USING ERRCODE='22023';END IF;
  IF EXISTS(SELECT 1 FROM attendance_shifts WHERE employee_id=actor AND clocked_out_at IS NULL) THEN RAISE EXCEPTION 'Already clocked in' USING ERRCODE='40001';END IF;
  cfg=private.attendance_policy();
  IF cfg IS NULL THEN RAISE EXCEPTION 'Attendance policy missing' USING ERRCODE='22023';END IF;
  IF cfg->>'maxShiftsPerDutyDate' IS NOT NULL AND (SELECT count(*) FROM attendance_shifts WHERE duty_id=d.duty_id)>=(cfg->>'maxShiftsPerDutyDate')::int THEN RAISE EXCEPTION 'Shift limit reached' USING ERRCODE='22023';END IF;
  SELECT h.id,sd.*,h.expected_daily_seconds INTO sched FROM employee_schedule_history h JOIN employee_schedule_days sd ON sd.schedule_id=h.id WHERE h.employee_id=actor AND h.effective_from<=d.duty_date AND (h.effective_to IS NULL OR h.effective_to>d.duty_date) AND sd.weekday=extract(isodow FROM d.duty_date)::int;
  IF sched.id IS NOT NULL THEN snap=to_jsonb(sched)||jsonb_build_object('scheduled_start',CASE WHEN sched.start_local IS NULL THEN NULL ELSE (d.duty_date+sched.start_local) AT TIME ZONE 'Asia/Manila' END,'scheduled_end',CASE WHEN sched.end_local IS NULL THEN NULL ELSE (d.duty_date+CASE WHEN sched.ends_next_day THEN 1 ELSE 0 END+sched.end_local) AT TIME ZONE 'Asia/Manila' END);END IF;
  INSERT INTO attendance_shifts(employee_id,duty_id,duty_authorization_version,duty_date,grant_from,grant_until,shift_number,recorded_in_at,clocked_in_at,source,policy_id,policy_snapshot,schedule_id,weekday,schedule_snapshot,clock_in_key,clock_in_fingerprint)
  SELECT actor,x.id,x.authorization_version,x.duty_date,x.valid_from,x.valid_until,(SELECT coalesce(max(shift_number),0)+1 FROM attendance_shifts WHERE duty_id=x.id),t,t,'EMPLOYEE',(cfg->>'policyId')::uuid,cfg,sched.id,CASE WHEN sched.id IS NOT NULL THEN sched.weekday END,snap,key,fp FROM duty_authorizations x WHERE x.id=d.duty_id RETURNING id INTO result;
  UPDATE attendance_shifts SET flags=array_remove(private.attendance_flags(result,t),'ZERO_DURATION') WHERE id=result;
  PERFORM private.attendance_audit('attendance.clock_in',jsonb_build_object('shift_id',result,'employee_id',actor,'at',t,'duty_id',d.duty_id));RETURN result;
 END IF;
 IF action='BREAK_END' THEN
  SELECT * INTO b FROM attendance_breaks WHERE id=target AND employee_id=actor;
  IF b.id IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
  SELECT * INTO s FROM attendance_shifts WHERE id=b.shift_id FOR UPDATE;
 ELSE SELECT * INTO s FROM attendance_shifts WHERE id=target AND employee_id=actor FOR UPDATE;END IF;
 IF s.id IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
 IF s.duty_id<>d.duty_id OR s.duty_authorization_version<>d.authorization_version THEN RAISE EXCEPTION 'Same duty grant required' USING ERRCODE='42501';END IF;
 IF action='CLOCK_OUT' AND s.clock_out_key=key THEN IF s.clock_out_fingerprint<>fp THEN RAISE EXCEPTION 'Retry conflict' USING ERRCODE='40001';END IF;RETURN s.id;END IF;
 IF action='BREAK_START' THEN
  SELECT * INTO b FROM attendance_breaks WHERE employee_id=actor AND start_key=key;
  IF b.id IS NOT NULL THEN IF b.start_fingerprint<>fp THEN RAISE EXCEPTION 'Retry conflict' USING ERRCODE='40001';END IF;RETURN b.id;END IF;
 ELSIF action='BREAK_END' THEN
  SELECT * INTO b FROM attendance_breaks WHERE id=target FOR UPDATE;
  IF b.end_key=key THEN IF b.end_fingerprint<>fp THEN RAISE EXCEPTION 'Retry conflict' USING ERRCODE='40001';END IF;RETURN b.id;END IF;
 END IF;
 t=private.security_now();IF private.work_actor() IS DISTINCT FROM actor THEN RAISE EXCEPTION 'Duty expired' USING ERRCODE='42501';END IF;
 IF s.clocked_out_at IS NOT NULL OR t<s.clocked_in_at THEN RAISE EXCEPTION 'Shift closed or clock anomaly' USING ERRCODE='40001';END IF;
 IF (action='BREAK_END' AND (b.version IS DISTINCT FROM expected OR b.ended_at IS NOT NULL OR b.is_voided OR t<b.started_at)) OR (action<>'BREAK_END' AND s.version IS DISTINCT FROM expected) THEN RAISE EXCEPTION 'Version conflict' USING ERRCODE='40001';END IF;
 IF action IN ('CLOCK_OUT','BREAK_START') AND EXISTS(SELECT 1 FROM task_time_segments WHERE shift_id=s.id AND greatest(recorded_start,recorded_end)>t) THEN
  RAISE EXCEPTION 'Timer clock anomaly' USING ERRCODE='P0409';
 END IF;
 before_values=private.attendance_snapshot(s.id);
 IF action='CLOCK_OUT' THEN
  PERFORM 1 FROM attendance_breaks WHERE shift_id=s.id ORDER BY id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM attendance_breaks WHERE shift_id=s.id AND NOT is_voided AND greatest(started_at,ended_at)>t) THEN RAISE EXCEPTION 'Clock anomaly' USING ERRCODE='40001';END IF;
  UPDATE attendance_breaks SET ended_at=t,recorded_end=t,end_reason='CLOCK_OUT',ended_by=actor,version=version+1,updated_at=t WHERE shift_id=s.id AND ended_at IS NULL AND NOT is_voided;
  UPDATE attendance_shifts SET clocked_out_at=t,recorded_out_at=t,close_source='EMPLOYEE',close_reason='CLOCK_OUT',closed_by=actor,clock_out_key=key,clock_out_fingerprint=fp,version=version+1,updated_at=t WHERE id=s.id;result=s.id;
 ELSIF action='BREAK_START' THEN
  rule=(SELECT x FROM jsonb_array_elements(s.policy_snapshot->'breakCodes')x WHERE x->>'code'=break_code);
  IF rule IS NULL THEN RAISE EXCEPTION 'Break code unavailable' USING ERRCODE='22023';END IF;
  allowance=coalesce((rule->>'allowanceSeconds')::int,CASE WHEN (rule->>'paid')::boolean THEN (s.schedule_snapshot->>'paid_break_seconds')::int ELSE (s.schedule_snapshot->>'unpaid_break_seconds')::int END);
  INSERT INTO attendance_breaks(shift_id,employee_id,recorded_start,started_at,code,paid,recorded_code,recorded_paid,allowance_seconds,policy_id,source,start_key,start_fingerprint) VALUES(s.id,actor,t,t,break_code,(rule->>'paid')::boolean,break_code,(rule->>'paid')::boolean,allowance,s.policy_id,'EMPLOYEE',key,fp) RETURNING id INTO result;
  UPDATE attendance_shifts SET version=version+1,updated_at=t WHERE id=s.id;
 ELSE
  UPDATE attendance_breaks SET ended_at=t,recorded_end=t,end_reason='BREAK_END',ended_by=actor,end_key=key,end_fingerprint=fp,version=version+1,updated_at=t WHERE id=b.id;result=b.id;
  UPDATE attendance_shifts SET version=version+1,updated_at=t WHERE id=s.id;
 END IF;
 UPDATE attendance_shifts SET flags=array_remove(private.attendance_flags(s.id,t),'CORRECTION_PENDING') WHERE id=s.id;
 PERFORM private.attendance_audit('attendance.'||lower(action),jsonb_build_object('shift_id',s.id,'employee_id',actor,'result_id',result,'at',t,'before',before_values,'after',private.attendance_snapshot(s.id)));RETURN result;
END $$;

CREATE OR REPLACE FUNCTION private.attendance_decide(target uuid,data jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.attendance_adjustments%ROWTYPE;s public.attendance_shifts%ROWTYPE;who uuid;actor uuid;d public.duty_authorizations%ROWTYPE;start_at timestamptz;end_at timestamptz;t timestamptz;sid uuid;before_values jsonb;cfg jsonb;item jsonb;bid uuid;allowance integer;note text=btrim(data->>'reason');decision text=data->>'decision';key uuid=(data->>'operationKey')::uuid;fp text;
BEGIN
 IF NOT private.is_admin() THEN RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501';END IF;
 SELECT employee_id INTO who FROM attendance_adjustments WHERE id=target;IF who IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
 actor=private.attendance_lock(who,true,true);
 SELECT * INTO a FROM attendance_adjustments WHERE id=target;
 SELECT * INTO d FROM duty_authorizations WHERE id=a.duty_id FOR UPDATE;
 IF a.target_shift_id IS NOT NULL THEN SELECT * INTO s FROM attendance_shifts WHERE id=a.target_shift_id FOR UPDATE;PERFORM 1 FROM attendance_breaks WHERE shift_id=s.id ORDER BY id FOR UPDATE;END IF;
 SELECT * INTO a FROM attendance_adjustments WHERE id=target FOR UPDATE;
 PERFORM private.attendance_note(note);
 IF NOT private.admin_recent() OR key IS NULL THEN RAISE EXCEPTION 'Recent MFA required' USING ERRCODE='42501';END IF;
 fp=private.work_fingerprint(data||jsonb_build_object('reason',note));
 IF a.status<>'PENDING' THEN IF a.review_key=key AND a.review_fingerprint=fp THEN RETURN coalesce(a.applied_shift_id,a.target_shift_id,a.id);END IF;RAISE EXCEPTION 'Already decided' USING ERRCODE='40001';END IF;
 IF a.version IS DISTINCT FROM (data->>'expectedVersion')::int OR decision IS NULL OR decision NOT IN('APPROVED','REJECTED') THEN RAISE EXCEPTION 'Invalid or stale decision' USING ERRCODE='40001';END IF;
 t=private.security_now();
 IF decision='REJECTED' THEN
  UPDATE attendance_adjustments SET status='REJECTED',reviewed_by=actor,reviewed_at=t,review_reason=note,review_key=key,review_fingerprint=fp,version=version+1 WHERE id=target;
  PERFORM private.attendance_audit('attendance.correction_rejected',jsonb_build_object('adjustment_id',target,'employee_id',who,'reason',note));RETURN coalesce(a.target_shift_id,a.id);
 END IF;
 IF a.kind='AMEND_SHIFT' AND s.version IS DISTINCT FROM a.target_version THEN RAISE EXCEPTION 'Punch changed since request; reject or replace proposal' USING ERRCODE='40001';END IF;
 IF a.kind='ADD_MISSING_SHIFT' AND (d.authorization_version IS DISTINCT FROM (a.grant_snapshot->>'version')::int OR d.valid_from IS DISTINCT FROM (a.grant_snapshot->>'from')::timestamptz OR d.valid_until IS DISTINCT FROM (a.grant_snapshot->>'until')::timestamptz) THEN RAISE EXCEPTION 'Historical grant changed; verification and replacement required' USING ERRCODE='40001';END IF;
 start_at=(a.proposed_values->>'clockedInAt')::timestamptz;end_at=(a.proposed_values->>'clockedOutAt')::timestamptz;
 IF start_at<(a.grant_snapshot->>'from')::timestamptz OR start_at>=(a.grant_snapshot->>'until')::timestamptz OR end_at>(a.grant_snapshot->>'until')::timestamptz OR end_at>t THEN RAISE EXCEPTION 'Proposal outside verified window; claim retained for review' USING ERRCODE='22023';END IF;
 SET CONSTRAINTS ALL DEFERRED;
 cfg=a.grant_snapshot->'policy';
 IF a.kind='ADD_MISSING_SHIFT' THEN
  sid=gen_random_uuid();before_values=jsonb_build_object('shiftExists',false);
  INSERT INTO attendance_shifts(id,employee_id,duty_id,duty_authorization_version,duty_date,grant_from,grant_until,shift_number,clocked_in_at,clocked_out_at,source,close_source,close_reason,closed_by,origin_adjustment_id,policy_id,policy_snapshot,schedule_id,weekday,schedule_snapshot,flags)
  VALUES(sid,who,a.duty_id,(a.grant_snapshot->>'version')::int,(a.grant_snapshot->>'date')::date,(a.grant_snapshot->>'from')::timestamptz,(a.grant_snapshot->>'until')::timestamptz,(SELECT coalesce(max(shift_number),0)+1 FROM attendance_shifts WHERE duty_id=a.duty_id),start_at,end_at,'CORRECTION','CORRECTION','APPROVED_CORRECTION',actor,a.id,(cfg->>'policyId')::uuid,cfg,(a.grant_snapshot->'schedule'->>'id')::uuid,(a.grant_snapshot->'schedule'->>'weekday')::int,nullif(a.grant_snapshot->'schedule','null'::jsonb),ARRAY['MISSING_PUNCH','CORRECTED']);
 ELSE
  sid=s.id;before_values=private.attendance_snapshot(sid);
  IF s.clocked_out_at IS NULL THEN PERFORM private.attendance_force_close(sid,t,'ADMIN_CORRECTION_REVIEW');END IF;
  UPDATE attendance_shifts SET clocked_in_at=start_at,clocked_out_at=end_at,close_source='CORRECTION',close_reason='APPROVED_CORRECTION',closed_by=actor,approval_status='PENDING',approved_payable_seconds=NULL,suggested_at_review=NULL,review_mode=NULL,reviewed_by=NULL,reviewed_at=NULL,review_reason=NULL,acknowledged_flags='{}',flags=flags||ARRAY['CORRECTED'],version=version+1,updated_at=t WHERE id=sid;
 END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(a.proposed_values->'breaks') LOOP
  bid=(item->>'id')::uuid;
  allowance=coalesce((item->>'allowanceSeconds')::int,CASE WHEN (item->>'paid')::boolean THEN (coalesce(s.schedule_snapshot,a.grant_snapshot->'schedule')->>'paid_break_seconds')::int ELSE (coalesce(s.schedule_snapshot,a.grant_snapshot->'schedule')->>'unpaid_break_seconds')::int END);
  IF (item->>'new')::boolean THEN
   INSERT INTO attendance_breaks(id,shift_id,employee_id,started_at,ended_at,code,paid,recorded_code,recorded_paid,allowance_seconds,policy_id,source,origin_adjustment_id,last_adjustment_id,end_reason,ended_by)
   VALUES(bid,sid,who,(item->>'startedAt')::timestamptz,(item->>'endedAt')::timestamptz,item->>'code',(item->>'paid')::boolean,item->>'code',(item->>'paid')::boolean,allowance,(cfg->>'policyId')::uuid,'CORRECTION',a.id,a.id,'APPROVED_CORRECTION',actor);
  ELSE
   UPDATE attendance_breaks SET started_at=(item->>'startedAt')::timestamptz,ended_at=(item->>'endedAt')::timestamptz,code=item->>'code',paid=(item->>'paid')::boolean,allowance_seconds=allowance,is_voided=(item->>'voided')::boolean,last_adjustment_id=a.id,end_reason='APPROVED_CORRECTION',ended_by=actor,version=version+1,updated_at=t WHERE id=bid AND shift_id=sid;
   IF NOT FOUND THEN RAISE EXCEPTION 'Break ownership changed' USING ERRCODE='P0002';END IF;
  END IF;
 END LOOP;
 UPDATE attendance_shifts SET flags=array_remove(private.attendance_flags(sid,t),'CORRECTION_PENDING') WHERE id=sid;
 UPDATE attendance_adjustments SET status='APPROVED',reviewed_by=actor,reviewed_at=t,review_reason=note,applied_shift_id=sid,applied_before=before_values,applied_after=private.attendance_snapshot(sid),review_key=key,review_fingerprint=fp,version=version+1 WHERE id=target;
 IF data ? 'segments' THEN
  IF a.kind<>'AMEND_SHIFT' OR jsonb_typeof(data->'segments')<>'array' OR jsonb_array_length(data->'segments')>100 THEN
   RAISE EXCEPTION 'Invalid combined segment changes' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(data->'segments') x GROUP BY x->>'segmentId' HAVING count(*)>1) THEN
   RAISE EXCEPTION 'Duplicate segment correction' USING ERRCODE='22023';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(data->'segments') ORDER BY value->>'segmentId' LOOP
   PERFORM private.correct_task_segment((item->>'segmentId')::uuid,item,a.id);
  END LOOP;
 END IF;
 PERFORM private.attendance_audit('attendance.correction_approved',jsonb_build_object('adjustment_id',target,'shift_id',sid,'employee_id',who,'reason',note,'before',before_values,'after',private.attendance_snapshot(sid)));RETURN sid;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.review_task_segment(uuid,jsonb) TO libetario_runtime;
COMMIT;
