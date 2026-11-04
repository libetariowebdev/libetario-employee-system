BEGIN;
-- Callers use one statement snapshot and a single as_of for all intersections.
CREATE FUNCTION private.time_intervals(who uuid, lo timestamptz, hi timestamptz, as_of timestamptz)
RETURNS TABLE(source_id uuid,employee_id uuid,shift_id uuid,task_id uuid,project_id uuid,assignment_id uuid,
 task_label text,project_label text,kind text,review_id uuid,status text,duty_date date,start_at timestamptz,end_at timestamptz,version integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT seg.id,seg.employee_id,seg.shift_id,seg.task_id,t.project_id,seg.assignment_id,seg.task_label,seg.project_label,
  seg.kind,seg.revision_review_id,
  CASE WHEN a.access_revoked_at IS NULL OR private.is_admin() THEN a.status ELSE 'WITHDRAWN' END,
  s.duty_date,seg.started_at,coalesce(seg.ended_at,least(as_of,s.grant_until)),seg.version
 FROM task_time_segments seg JOIN attendance_shifts s ON s.id=seg.shift_id
 JOIN tasks t ON t.id=seg.task_id JOIN task_assignments a ON a.id=seg.assignment_id
 WHERE (who IS NULL OR seg.employee_id=who) AND seg.started_at<hi AND coalesce(seg.ended_at,least(as_of,s.grant_until))>lo
 UNION ALL
 SELECT s.id,s.employee_id,s.id,NULL,NULL,NULL,NULL,NULL,'ATTENDANCE',NULL,s.approval_status,s.duty_date,s.clocked_in_at,
  coalesce(s.clocked_out_at,least(as_of,s.grant_until)),s.version
 FROM attendance_shifts s
 WHERE (who IS NULL OR s.employee_id=who) AND s.clocked_in_at<hi AND coalesce(s.clocked_out_at,least(as_of,s.grant_until))>lo
 UNION ALL
 SELECT b.id,b.employee_id,b.shift_id,NULL,NULL,NULL,NULL,NULL,CASE WHEN b.paid THEN 'PAID_BREAK' ELSE 'UNPAID_BREAK' END,
  NULL,s.approval_status,s.duty_date,b.started_at,coalesce(b.ended_at,least(as_of,s.grant_until)),b.version
 FROM attendance_breaks b JOIN attendance_shifts s ON s.id=b.shift_id
 WHERE NOT b.is_voided AND (who IS NULL OR b.employee_id=who) AND b.started_at<hi AND coalesce(b.ended_at,least(as_of,s.grant_until))>lo
$$;

CREATE FUNCTION private.time_report(filters jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
 actor uuid=private.work_actor(); who uuid=(filters->>'employeeId')::uuid; administrator boolean=private.is_admin();
 instant timestamptz=private.security_now(); today date=(instant AT TIME ZONE 'Asia/Manila')::date;
 first_day date=coalesce((filters->>'from')::date,today); last_day date=coalesce((filters->>'to')::date,first_day);
 project_filter uuid=(filters->>'projectId')::uuid; status_filter text=nullif(filters->>'status','');
 view_name text=coalesce(filters->>'view','summary'); grain text=coalesce(filters->>'grain','day');
 cfg jsonb=private.time_configuration()->'reports'; weekday integer=(cfg->>'weekStartsOn')::integer; max_rows integer=(cfg->>'maxRows')::integer;
 rows jsonb;
BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION 'Current work access required' USING ERRCODE='42501'; END IF;
 IF NOT administrator THEN
  IF who IS NOT NULL AND who<>actor THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
  who=actor;
 END IF;
 IF NOT isfinite(first_day) OR NOT isfinite(last_day) OR last_day<first_day OR last_day-first_day+1>(cfg->>'maxDays')::integer
   OR grain NOT IN ('day','week') OR view_name NOT IN ('summary','tasks','segments','attendance','approvals') THEN
  RAISE EXCEPTION 'Report date range or view exceeds policy' USING ERRCODE='22023';
 END IF;
 IF project_filter IS NOT NULL AND NOT (
  (administrator AND EXISTS(SELECT 1 FROM projects WHERE id=project_filter))
  OR (NOT administrator AND (
    private.can_project(project_filter) OR EXISTS(SELECT 1 FROM task_time_segments seg JOIN tasks t ON t.id=seg.task_id WHERE seg.employee_id=actor AND t.project_id=project_filter)
  ))
 ) THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;

 IF view_name='approvals' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(q)),'[]') INTO rows FROM (
   SELECT s.id AS shift_id,s.employee_id,p.display_name AS employee,s.duty_date,s.clocked_in_at,s.clocked_out_at,
    s.version,s.approval_status,s.approved_payable_seconds::text AS approved_seconds,private.attendance_flags(s.id,instant) AS flags
   FROM attendance_shifts s JOIN employee_profiles p ON p.user_id=s.employee_id
   WHERE (who IS NULL OR s.employee_id=who) AND s.duty_date BETWEEN first_day AND last_day
    AND (status_filter IS NULL OR s.approval_status=status_filter)
   ORDER BY s.duty_date,s.employee_id,s.shift_number LIMIT max_rows+1
  ) q;
 ELSE
  WITH dates AS (
   SELECT first_day+n AS day FROM generate_series(0,last_day-first_day) n
  ), periods AS (
   SELECT CASE WHEN grain='day' THEN day ELSE day-mod(extract(isodow FROM day)::int-weekday+7,7) END AS period,
    min(day)::timestamp AT TIME ZONE 'Asia/Manila' AS lo,
    (max(day)+1)::timestamp AT TIME ZONE 'Asia/Manila' AS hi
   FROM dates GROUP BY 1
  ), source AS (
   SELECT i.*,p.period, greatest(i.start_at,p.lo) AS slice_start,least(i.end_at,p.hi) AS slice_end,
    extract(epoch FROM least(i.end_at,p.hi)-greatest(i.start_at,p.lo)) AS seconds
   FROM private.time_intervals(who,first_day::timestamp AT TIME ZONE 'Asia/Manila',(last_day+1)::timestamp AT TIME ZONE 'Asia/Manila',instant) i
   JOIN periods p ON i.start_at<p.hi AND i.end_at>greatest(i.start_at,p.lo)
  ), selected AS (
   SELECT * FROM source WHERE (project_filter IS NULL OR project_id=project_filter) AND (status_filter IS NULL OR status=status_filter)
  ), totals AS (
   SELECT period,employee_id,
    coalesce(sum(seconds) FILTER(WHERE kind='ATTENDANCE'),0) AS gross,
    coalesce(sum(seconds) FILTER(WHERE kind='PAID_BREAK'),0) AS paid,
    coalesce(sum(seconds) FILTER(WHERE kind='UNPAID_BREAK'),0) AS unpaid,
    coalesce(sum(seconds) FILTER(WHERE kind='ORIGINAL'),0) AS original,
    coalesce(sum(seconds) FILTER(WHERE kind='REVISION'),0) AS revision
   FROM source WHERE view_name='summary'
   GROUP BY period,employee_id
  ), task_groups AS (
   SELECT period,employee_id,task_id,project_id,assignment_id,task_label,project_label,
    coalesce(sum(seconds) FILTER(WHERE kind='ORIGINAL'),0)::text AS original_seconds,
    coalesce(sum(seconds) FILTER(WHERE kind='REVISION'),0)::text AS revision_seconds,
    sum(seconds)::text AS task_seconds
   FROM selected WHERE view_name='tasks' AND task_id IS NOT NULL
   GROUP BY period,employee_id,task_id,project_id,assignment_id,task_label,project_label
  ), report_rows AS (
   SELECT x.period,x.employee_id,'' AS key,jsonb_build_object('period',x.period,'employee_id',x.employee_id,'employee',p.display_name,
    'attendance_seconds',gross::text,'paid_break_seconds',paid::text,'unpaid_break_seconds',unpaid::text,
    'original_seconds',original::text,'revision_seconds',revision::text,'task_seconds',(original+revision)::text,
    'gap_seconds',greatest(0,gross-original-revision)::text) AS data
   FROM totals x JOIN employee_profiles p ON p.user_id=x.employee_id
   WHERE (project_filter IS NULL AND status_filter IS NULL) OR EXISTS(SELECT 1 FROM selected y WHERE y.period=x.period AND y.employee_id=x.employee_id)
   UNION ALL
   SELECT g.period,g.employee_id,g.task_id::text,to_jsonb(g)||jsonb_build_object('employee',p.display_name)
   FROM task_groups g JOIN employee_profiles p ON p.user_id=g.employee_id
   UNION ALL
   SELECT y.period,y.employee_id,y.source_id::text,(to_jsonb(y)-ARRAY['seconds','start_at','end_at'])||
    jsonb_build_object('employee',p.display_name,'seconds',y.seconds::text,'source_start',y.start_at,'source_end',y.end_at)||
    CASE WHEN view_name='attendance' THEN jsonb_build_object('flags',private.attendance_flags(y.shift_id,instant)) ELSE '{}' END
   FROM selected y JOIN employee_profiles p ON p.user_id=y.employee_id
   WHERE (view_name='segments' AND y.task_id IS NOT NULL) OR (view_name='attendance' AND y.task_id IS NULL)
  )
  SELECT coalesce(jsonb_agg(data),'[]') INTO rows FROM (
   SELECT data FROM report_rows ORDER BY period,employee_id,key LIMIT max_rows+1
  ) bounded;
 END IF;
 IF jsonb_array_length(rows)>max_rows THEN RAISE EXCEPTION 'Report row limit exceeded; narrow the filters' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object('asOf',instant,'from',first_day,'to',last_day,'grain',grain,'view',view_name,'rows',rows);
END $$;

CREATE FUNCTION private.time_live(skip integer DEFAULT 0) RETURNS jsonb
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
  'alerts',coalesce(alerts.flags,'{}')||
   CASE WHEN r.id IS NOT NULL AND task.deadline_at<instant THEN ARRAY['TASK_OVERDUE'] ELSE '{}'::text[] END
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
 ) alerts ON true;
 RETURN jsonb_build_object('asOf',instant,'date',today,'pollSeconds',(private.time_configuration()->'reports'->>'pollSeconds')::integer,'items',items);
END $$;

CREATE FUNCTION private.time_ledger(who uuid DEFAULT NULL, skip integer DEFAULT 0, target uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid=private.work_actor(); owner_id uuid=coalesce(who,actor); instant timestamptz=private.security_now(); root_id uuid;
BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION 'Current work access required' USING ERRCODE='42501'; END IF;
 IF target IS NOT NULL THEN
  SELECT timer_id,employee_id INTO root_id,owner_id FROM task_time_segments WHERE id=target;
  IF root_id IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
 END IF;
 IF NOT private.attendance_visible(owner_id) THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
 IF skip<0 OR skip>50000 THEN RAISE EXCEPTION 'Invalid page offset' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object('asOf',instant,
  'active', (SELECT (to_jsonb(seg)-'operation_receipts')||jsonb_build_object('seconds',(
    SELECT coalesce(sum(greatest(0,extract(epoch FROM coalesce(x.ended_at,least(instant,s.grant_until))-x.started_at))),0)::text
    FROM task_time_segments x WHERE x.timer_id=seg.id))
   FROM task_time_segments seg JOIN attendance_shifts s ON s.id=seg.shift_id
   WHERE seg.employee_id=owner_id AND seg.timer_state IN ('RUNNING','PAUSED') AND instant<s.grant_until),
  'items',coalesce((SELECT jsonb_agg(to_jsonb(v)-'operation_receipts' ORDER BY v.started_at DESC,v.id) FROM (
   SELECT seg.*,r.timer_version AS root_version,r.timer_state AS root_state,s.version AS shift_version,s.duty_date,
    s.clocked_out_at AS shift_closed_at,greatest(0,extract(epoch FROM coalesce(seg.ended_at,least(instant,s.grant_until))-seg.started_at))::text AS seconds
   FROM task_time_segments seg JOIN task_time_segments r ON r.id=seg.timer_id JOIN attendance_shifts s ON s.id=seg.shift_id
   WHERE seg.employee_id=owner_id AND (root_id IS NULL OR seg.timer_id=root_id)
   ORDER BY seg.started_at DESC,seg.id OFFSET skip LIMIT 51
  ) v),'[]'),
  'adjustments',CASE WHEN target IS NOT NULL THEN coalesce((
   SELECT jsonb_agg(to_jsonb(a)-ARRAY['operation_key','fingerprint'] ORDER BY a.created_at,a.id) FROM task_segment_adjustments a WHERE a.segment_id=target
  ),'[]') ELSE '[]'::jsonb END,
  'configuration',private.time_configuration());
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.time_report(jsonb),private.time_live(integer),private.time_ledger(uuid,integer,uuid) TO libetario_runtime;
COMMIT;
