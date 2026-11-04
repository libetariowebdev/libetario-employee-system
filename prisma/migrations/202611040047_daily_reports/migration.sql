BEGIN;
CREATE FUNCTION private.daily_candidates(owner_id uuid, day date)
RETURNS TABLE(assignment_id uuid,task_id uuid,project_id uuid,task_label text,project_label text,captured_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 WITH bounds AS (SELECT day::timestamp AT TIME ZONE 'Asia/Manila' AS lo,(day+1)::timestamp AT TIME ZONE 'Asia/Manila' AS hi),
 options AS (
  SELECT a.id,a.task_id,t.project_id,t.title,p.name,a.status,0 AS rank
  FROM task_assignments a JOIN tasks t ON t.id=a.task_id JOIN projects p ON p.id=t.project_id CROSS JOIN bounds
  WHERE a.employee_id=owner_id AND a.access_revoked_at IS NULL AND a.assigned_at<bounds.hi
   AND a.status<>'CANCELLED' AND p.status='ACTIVE' AND t.status<>'CANCELLED'
  UNION ALL
  SELECT seg.assignment_id,seg.task_id,t.project_id,seg.task_label,seg.project_label,'RECORDED_TIME',1
  FROM task_time_segments seg JOIN tasks t ON t.id=seg.task_id JOIN attendance_shifts s ON s.id=seg.shift_id CROSS JOIN bounds
  WHERE seg.employee_id=owner_id AND seg.started_at<bounds.hi
   AND least(coalesce(seg.ended_at,private.security_now()),s.grant_until)>greatest(bounds.lo,seg.started_at)
 )
 SELECT DISTINCT ON (id) id,options.task_id,options.project_id,title,name,status FROM options
 ORDER BY id,rank,title,name
$$;

CREATE FUNCTION private.daily_write_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_TABLE_NAME='daily_reports' THEN
  IF NEW.report_date>(private.security_now() AT TIME ZONE 'Asia/Manila')::date THEN
   RAISE EXCEPTION 'Future reports are unavailable' USING ERRCODE='22023';
  END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM daily_reports WHERE id=NEW.report_id AND state='DRAFT') THEN
   RAISE EXCEPTION 'Report is frozen' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER daily_date_guard BEFORE INSERT ON daily_reports FOR EACH ROW EXECUTE FUNCTION private.daily_write_guard();
CREATE TRIGGER daily_entry_guard BEFORE INSERT ON daily_report_entries FOR EACH ROW EXECUTE FUNCTION private.daily_write_guard();

CREATE FUNCTION private.daily_command(day date, action text, data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
 actor uuid; report daily_reports%ROWTYPE; entry daily_report_entries%ROWTYPE; candidate record; instant timestamptz;
 operation uuid=(data->>'operationKey')::uuid; expected integer=(data->>'expectedVersion')::int;
 assignment uuid=(data->>'assignmentId')::uuid; fingerprint text; prior daily_reports%ROWTYPE; cap integer;
BEGIN
 actor=private.lock_work();
 IF private.is_admin() THEN RAISE EXCEPTION 'Employee duty required' USING ERRCODE='42501'; END IF;
 IF day IS NULL OR NOT isfinite(day) OR day>(private.security_now() AT TIME ZONE 'Asia/Manila')::date
   OR action IS NULL OR action NOT IN ('SAVE','ENTRY','SUBMIT') OR operation IS NULL OR expected IS NULL THEN
  RAISE EXCEPTION 'Invalid daily report command' USING ERRCODE='22023';
 END IF;
 IF jsonb_typeof(data) IS DISTINCT FROM 'object' OR (CASE action
   WHEN 'SAVE' THEN data-ARRAY['operationKey','expectedVersion','workInProgress','issues','notes','nextSteps']
   WHEN 'ENTRY' THEN data-ARRAY['operationKey','expectedVersion','assignmentId','description','reportedComplete','included']
   ELSE data-ARRAY['operationKey','expectedVersion'] END) <> '{}' THEN
  RAISE EXCEPTION 'Unknown daily report fields' USING ERRCODE='22023';
 END IF;
 fingerprint=private.work_fingerprint(jsonb_build_array(day,action,data-'operationKey'));
 SELECT * INTO prior FROM daily_reports WHERE employee_id=actor AND operation_receipts ? operation::text;
 IF prior.id IS NOT NULL THEN
  IF prior.operation_receipts->>operation::text<>fingerprint THEN RAISE EXCEPTION 'Retry key conflict' USING ERRCODE='40001'; END IF;
  RETURN prior.id;
 END IF;
 IF action='ENTRY' THEN
  IF assignment IS NULL OR jsonb_typeof(data->'included') IS DISTINCT FROM 'boolean'
   OR jsonb_typeof(data->'reportedComplete') IS DISTINCT FROM 'boolean' OR jsonb_typeof(data->'description') IS DISTINCT FROM 'string' THEN
   RAISE EXCEPTION 'Invalid entry' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM task_assignments WHERE id=assignment AND employee_id=actor) THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
  PERFORM 1 FROM projects WHERE id=(SELECT t.project_id FROM tasks t JOIN task_assignments a ON a.task_id=t.id WHERE a.id=assignment) FOR UPDATE;
  PERFORM 1 FROM tasks WHERE id=(SELECT task_id FROM task_assignments WHERE id=assignment) FOR UPDATE;
  PERFORM 1 FROM task_assignments WHERE id=assignment FOR UPDATE;
 ELSIF action='SUBMIT' THEN
  PERFORM 1 FROM projects WHERE id IN (
   SELECT e.project_id FROM daily_report_entries e JOIN daily_reports d ON d.id=e.report_id
   WHERE d.employee_id=actor AND d.report_date=day AND e.included
  ) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM tasks WHERE id IN (
   SELECT e.task_id FROM daily_report_entries e JOIN daily_reports d ON d.id=e.report_id
   WHERE d.employee_id=actor AND d.report_date=day AND e.included
  ) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM task_assignments WHERE id IN (
   SELECT e.assignment_id FROM daily_report_entries e JOIN daily_reports d ON d.id=e.report_id
   WHERE d.employee_id=actor AND d.report_date=day AND e.included
  ) ORDER BY id FOR UPDATE;
 END IF;
 SELECT * INTO report FROM daily_reports WHERE employee_id=actor AND report_date=day FOR UPDATE;
 instant=private.security_now();
 IF private.work_actor() IS DISTINCT FROM actor THEN RAISE EXCEPTION 'Current duty required' USING ERRCODE='42501'; END IF;
 IF report.id IS NULL THEN
  IF action<>'SAVE' OR expected<>0 THEN RAISE EXCEPTION 'Start the report first' USING ERRCODE='P0409'; END IF;
  INSERT INTO daily_reports(employee_id,report_date,work_in_progress,issues,notes,next_steps,created_by,updated_by,created_at,updated_at,operation_receipts)
   VALUES(actor,day,coalesce(data->>'workInProgress',''),coalesce(data->>'issues',''),coalesce(data->>'notes',''),coalesce(data->>'nextSteps',''),actor,actor,instant,instant,jsonb_build_object(operation::text,fingerprint))
   RETURNING * INTO report;
 ELSE
  IF report.state<>'DRAFT' OR report.version<>expected THEN RAISE EXCEPTION 'Report changed or frozen' USING ERRCODE='40001'; END IF;
  IF action='ENTRY' THEN
   SELECT * INTO entry FROM daily_report_entries WHERE report_id=report.id AND assignment_id=assignment FOR UPDATE;
   IF (data->>'included')::boolean THEN
    SELECT * INTO candidate FROM private.daily_candidates(actor,day) c WHERE c.assignment_id=assignment;
    IF candidate.assignment_id IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
    cap=(private.time_configuration()->'reports'->>'maxEntries')::int;
    IF entry.id IS NULL AND (SELECT count(*) FROM daily_report_entries WHERE report_id=report.id)>=cap THEN
     RAISE EXCEPTION 'Daily report entry limit reached' USING ERRCODE='22023';
    END IF;
   ELSIF entry.id IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
   IF entry.id IS NULL THEN
    INSERT INTO daily_report_entries(report_id,employee_id,assignment_id,task_id,project_id,description,reported_complete,task_label,project_label,captured_status,created_at,updated_at)
     VALUES(report.id,actor,assignment,candidate.task_id,candidate.project_id,data->>'description',(data->>'reportedComplete')::boolean,candidate.task_label,candidate.project_label,candidate.captured_status,instant,instant);
   ELSE
    UPDATE daily_report_entries SET description=data->>'description',reported_complete=(data->>'reportedComplete')::boolean,
     included=(data->>'included')::boolean,updated_at=instant,version=version+1 WHERE id=entry.id;
   END IF;
  ELSIF action='SUBMIT' THEN
   IF NOT EXISTS(SELECT 1 FROM daily_report_entries WHERE report_id=report.id AND included)
    AND greatest(length(btrim(report.issues)),length(btrim(report.notes)))<10 THEN
    RAISE EXCEPTION 'Add an entry or a meaningful issue or non-work note' USING ERRCODE='22023';
   END IF;
   IF EXISTS(SELECT 1 FROM daily_report_entries e WHERE e.report_id=report.id AND e.included
     AND NOT EXISTS(SELECT 1 FROM private.daily_candidates(actor,day) c WHERE c.assignment_id=e.assignment_id)) THEN
    RAISE EXCEPTION 'Exclude entries no longer eligible for this day' USING ERRCODE='40001';
   END IF;
  END IF;
  UPDATE daily_reports SET
   work_in_progress=CASE WHEN action='SAVE' THEN coalesce(data->>'workInProgress','') ELSE work_in_progress END,
   issues=CASE WHEN action='SAVE' THEN coalesce(data->>'issues','') ELSE issues END,
   notes=CASE WHEN action='SAVE' THEN coalesce(data->>'notes','') ELSE notes END,
   next_steps=CASE WHEN action='SAVE' THEN coalesce(data->>'nextSteps','') ELSE next_steps END,
   state=CASE WHEN action='SUBMIT' THEN 'SUBMITTED' ELSE state END,
   submitted_at=CASE WHEN action='SUBMIT' THEN instant END,
   version=version+1,updated_at=instant,updated_by=actor,operation_receipts=operation_receipts||jsonb_build_object(operation::text,fingerprint)
   WHERE id=report.id;
 END IF;
 PERFORM private.attendance_audit('daily.'||lower(action),jsonb_build_object('report_id',report.id,'employee_id',actor,'report_date',day,'assignment_id',assignment,'included',data->'included'));
 RETURN report.id;
END $$;

CREATE FUNCTION private.daily_read(day date, who uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid=private.work_actor(); owner_id uuid=coalesce(who,actor); report daily_reports%ROWTYPE;
BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION 'Current work access required' USING ERRCODE='42501'; END IF;
 IF NOT private.attendance_visible(owner_id) THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
 SELECT * INTO report FROM daily_reports WHERE employee_id=owner_id AND report_date=day;
 RETURN jsonb_build_object('date',day,
  'report',CASE WHEN report.id IS NOT NULL THEN to_jsonb(report)-'operation_receipts' END,
  'entries',coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.project_label,e.task_label,e.id) FROM daily_report_entries e WHERE e.report_id=report.id),'[]'),
  'options',CASE WHEN NOT private.is_admin() AND coalesce(report.state,'DRAFT')='DRAFT' THEN
    coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.project_label,c.task_label,c.assignment_id) FROM private.daily_candidates(owner_id,day) c),'[]') ELSE '[]'::jsonb END);
END $$;
CREATE FUNCTION private.daily_catalog(day date, skip integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT private.is_admin() THEN RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501'; END IF;
 IF skip<0 OR skip>50000 THEN RAISE EXCEPTION 'Invalid report offset' USING ERRCODE='22023'; END IF;
 RETURN coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.employee_name,r.employee_id) FROM (
  SELECT d.id,d.employee_id,p.display_name AS employee_name,d.report_date,d.state,d.submitted_at FROM daily_reports d
  JOIN employee_profiles p ON p.user_id=d.employee_id WHERE d.report_date=day
  ORDER BY p.display_name,d.employee_id OFFSET skip LIMIT 51
 ) r),'[]');
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.daily_command(date,text,jsonb),private.daily_read(date,uuid),private.daily_catalog(date,integer) TO libetario_runtime;
COMMIT;
