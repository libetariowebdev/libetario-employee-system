BEGIN;
-- The original assignment/task composite key already supports the new FKs.
ALTER TABLE task_assignments DROP CONSTRAINT task_assignments_id_task_id_key1;

CREATE FUNCTION private.time_segment_change_proof() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF OLD.recorded_end IS NOT NULL AND (NEW.started_at,NEW.ended_at) IS DISTINCT FROM (OLD.started_at,OLD.ended_at)
 AND NOT EXISTS (
  SELECT 1 FROM task_segment_adjustments a
  WHERE a.segment_id=OLD.id AND a.before_version=OLD.version AND a.after_version=NEW.version
   AND (a.before_start,a.before_end,a.after_start,a.after_end)=(OLD.started_at,OLD.ended_at,NEW.started_at,NEW.ended_at)
 ) THEN RAISE EXCEPTION 'Effective segment changes require an immutable correction' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER time_segment_change_proof BEFORE UPDATE ON task_time_segments
 FOR EACH ROW EXECUTE FUNCTION private.time_segment_change_proof();

CREATE FUNCTION private.time_shift_segments(target uuid, skip integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE owner_id uuid;
BEGIN
 SELECT employee_id INTO owner_id FROM attendance_shifts WHERE id=target;
 IF owner_id IS NULL OR NOT private.attendance_visible(owner_id) THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
 IF skip<0 OR skip>50000 THEN RAISE EXCEPTION 'Invalid offset' USING ERRCODE='22023'; END IF;
 RETURN coalesce((SELECT jsonb_agg(to_jsonb(q)-'operation_receipts' ORDER BY q.started_at,q.id) FROM (
  SELECT s.*,r.timer_version AS root_version,r.timer_state AS root_state,a.version AS shift_version,a.clocked_out_at AS shift_closed_at,a.duty_date,
   greatest(0,extract(epoch FROM coalesce(s.ended_at,least(private.security_now(),a.grant_until))-s.started_at))::text AS seconds
  FROM task_time_segments s JOIN task_time_segments r ON r.id=s.timer_id JOIN attendance_shifts a ON a.id=s.shift_id
  WHERE s.shift_id=target ORDER BY s.started_at,s.id OFFSET skip LIMIT 101
 ) q),'[]');
END $$;
GRANT EXECUTE ON FUNCTION private.time_shift_segments(uuid,integer) TO libetario_runtime;
-- The live query uses the task due date and includes today's interruption.
CREATE OR REPLACE FUNCTION private.time_live(skip integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE instant timestamptz=private.security_now(); today date=(instant AT TIME ZONE 'Asia/Manila')::date; lo timestamptz; hi timestamptz; items jsonb;
BEGIN
 IF NOT private.is_admin() THEN RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501'; END IF;
 IF skip<0 OR skip>50000 THEN RAISE EXCEPTION 'Invalid page offset' USING ERRCODE='22023'; END IF;
 lo=today::timestamp AT TIME ZONE 'Asia/Manila';hi=(today+1)::timestamp AT TIME ZONE 'Asia/Manila';
 WITH staff AS (
  SELECT p.user_id,p.display_name,p.employment_status,u.disabled_at
  FROM employee_profiles p JOIN users u ON u.id=p.user_id
  WHERE p.employment_status='ACTIVE' OR EXISTS(SELECT 1 FROM attendance_shifts s WHERE s.employee_id=p.user_id AND s.clocked_in_at<hi AND coalesce(s.clocked_out_at,s.grant_until)>lo)
  ORDER BY p.display_name,p.user_id OFFSET skip LIMIT 101
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object(
  'employee_id',p.user_id,'employee',p.display_name,
  'duty_status',CASE WHEN p.disabled_at IS NOT NULL OR p.employment_status<>'ACTIVE' THEN 'INACTIVE'
   WHEN d.id IS NULL THEN 'NO_GRANT' WHEN d.status='REVOKED' THEN 'REVOKED'
   WHEN instant>=d.valid_until THEN 'EXPIRED' WHEN instant<d.valid_from THEN 'UPCOMING' ELSE 'ACTIVATED' END,
  'duty_date',d.duty_date,'current_task',r.task_label,'current_project',r.project_label,'timer_state',r.timer_state,
  'current_seconds',CASE WHEN r.id IS NOT NULL THEN session_time.seconds END,
  'original_seconds',totals.original,'revision_seconds',totals.revision,'attendance_seconds',totals.gross,
  'paid_break_seconds',totals.paid,'unpaid_break_seconds',totals.unpaid,
  'alerts',coalesce(alerts.flags,'{}')||coalesce(interrupted.flags,'{}')||
   CASE WHEN r.id IS NOT NULL AND task.due_at<instant THEN ARRAY['TASK_OVERDUE'] ELSE '{}'::text[] END
 ) ORDER BY p.display_name,p.user_id),'[]') INTO items
 FROM staff p
 LEFT JOIN LATERAL (
  SELECT * FROM duty_authorizations x WHERE x.employee_id=p.user_id AND (x.duty_date=today OR (instant>=x.valid_from AND instant<x.valid_until))
  ORDER BY (x.status='ACTIVATED' AND instant>=x.valid_from AND instant<x.valid_until) DESC,x.duty_date DESC LIMIT 1
 ) d ON true
 LEFT JOIN LATERAL (
  SELECT seg.* FROM task_time_segments seg JOIN attendance_shifts s ON s.id=seg.shift_id
  WHERE seg.employee_id=p.user_id AND seg.timer_state IN ('RUNNING','PAUSED') AND instant<s.grant_until
 ) r ON true
 LEFT JOIN tasks task ON task.id=r.task_id
 LEFT JOIN LATERAL (
  SELECT coalesce(sum(greatest(0,extract(epoch FROM coalesce(s.ended_at,instant)-s.started_at))),0)::text AS seconds
  FROM task_time_segments s WHERE s.timer_id=r.id
 ) session_time ON true
 CROSS JOIN LATERAL (
  SELECT
   coalesce(sum(duration) FILTER(WHERE kind='ATTENDANCE'),0)::text AS gross,
   coalesce(sum(duration) FILTER(WHERE kind='ORIGINAL'),0)::text AS original,
   coalesce(sum(duration) FILTER(WHERE kind='REVISION'),0)::text AS revision,
   coalesce(sum(duration) FILTER(WHERE kind='PAID_BREAK'),0)::text AS paid,
   coalesce(sum(duration) FILTER(WHERE kind='UNPAID_BREAK'),0)::text AS unpaid
  FROM (SELECT i.kind,greatest(0,extract(epoch FROM least(i.end_at,hi)-greatest(i.start_at,lo))) AS duration
        FROM private.time_intervals(p.user_id,lo,hi,instant) i) t
 ) totals
 LEFT JOIN LATERAL (
  SELECT array_agg(DISTINCT flag ORDER BY flag) AS flags FROM attendance_shifts s
  CROSS JOIN LATERAL unnest(private.attendance_flags(s.id,instant)) flag
  WHERE s.employee_id=p.user_id AND s.clocked_in_at<hi AND coalesce(s.clocked_out_at,s.grant_until)>lo
 ) alerts ON true
 LEFT JOIN LATERAL (
  SELECT array_agg(DISTINCT seg.timer_close_reason ORDER BY seg.timer_close_reason) AS flags
  FROM task_time_segments seg WHERE seg.employee_id=p.user_id AND seg.timer_closed_at>=lo AND seg.timer_closed_at<hi
   AND seg.timer_close_reason IN ('ASSIGNMENT_WITHDRAWN','TASK_CANCELLED','PROJECT_LEFT_ACTIVE','DUTY_REVOKED','DUTY_WINDOW_EXPIRED','ACCOUNT_DISABLED','EMPLOYMENT_INACTIVE')
 ) interrupted ON true;
 RETURN jsonb_build_object('asOf',instant,'date',today,'pollSeconds',(private.time_configuration()->'reports'->>'pollSeconds')::integer,'items',items);
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC;
COMMIT;
