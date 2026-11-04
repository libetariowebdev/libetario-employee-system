BEGIN;
CREATE FUNCTION private.time_configuration() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('policyId',p.id,
 'timers','{"switchMode":"ATOMIC_STOP_AND_START"}'::jsonb||coalesce(p.configuration->'timers','{}'),
 'reports','{"weekStartsOn":1,"pollSeconds":15,"maxDays":31,"maxRows":50000,"maxEntries":100}'::jsonb||coalesce(p.configuration->'reports','{}'))
 FROM company_settings c JOIN policy_versions p ON p.id=c.work_policy_id WHERE c.id=1
$$;

CREATE FUNCTION private.time_policy_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE rules jsonb; field text; bounds integer[];
BEGIN
 IF NEW.policy_key<>'WORK' THEN RETURN NEW; END IF;
 IF NEW.configuration ? 'timers' AND (jsonb_typeof(NEW.configuration->'timers')<>'object'
    OR NEW.configuration->'timers' NOT IN ('{"switchMode":"ATOMIC_STOP_AND_START"}','{"switchMode":"EXPLICIT_STOP_REQUIRED"}')) THEN
  RAISE EXCEPTION 'Invalid timer rules' USING ERRCODE='22023';
 END IF;
 IF NEW.configuration ? 'reports' THEN
  rules=NEW.configuration->'reports';
  IF jsonb_typeof(rules)<>'object' THEN RAISE EXCEPTION 'Invalid report rules' USING ERRCODE='22023'; END IF;
  FOR field,bounds IN SELECT * FROM (VALUES ('weekStartsOn',ARRAY[1,7]),('pollSeconds',ARRAY[10,60]),('maxDays',ARRAY[1,31]),('maxRows',ARRAY[1,50000]),('maxEntries',ARRAY[1,100])) AS v LOOP
   IF jsonb_typeof(rules->field) IS DISTINCT FROM 'number' OR NOT coalesce((rules->>field)~'^[0-9]{1,5}$',false) THEN
    RAISE EXCEPTION 'Invalid report rules' USING ERRCODE='22023';
   END IF;
   IF (rules->>field)::integer NOT BETWEEN bounds[1] AND bounds[2] THEN RAISE EXCEPTION 'Invalid report bounds' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF rules-ARRAY['weekStartsOn','pollSeconds','maxDays','maxRows','maxEntries']<>'{}' THEN RAISE EXCEPTION 'Unknown report rule' USING ERRCODE='22023'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER time_policy_check BEFORE INSERT ON policy_versions FOR EACH ROW EXECUTE FUNCTION private.time_policy_check();
CREATE FUNCTION private.time_settings(expected uuid,rules jsonb,reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid; previous policy_versions%ROWTYPE; next_id uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(72426820::bigint);
 actor=private.lock_work(true);
 PERFORM private.attendance_note(reason);
 IF NOT private.admin_recent() THEN RAISE EXCEPTION 'Recent MFA required' USING ERRCODE='42501'; END IF;
 SELECT p.* INTO previous FROM company_settings c JOIN policy_versions p ON p.id=c.work_policy_id WHERE c.id=1;
 IF previous.id IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Policy changed' USING ERRCODE='40001'; END IF;
 IF jsonb_typeof(rules) IS DISTINCT FROM 'object' OR NOT rules ?& ARRAY['timers','reports'] OR rules-ARRAY['timers','reports']<>'{}' THEN
  RAISE EXCEPTION 'Expected time settings' USING ERRCODE='22023';
 END IF;
 INSERT INTO policy_versions(policy_key,revision,configuration,created_by)
 SELECT 'WORK',coalesce(max(revision),0)+1,previous.configuration||rules,actor FROM policy_versions WHERE policy_key='WORK'
 RETURNING id INTO next_id;
 UPDATE company_settings SET work_policy_id=next_id WHERE id=1;
 PERFORM private.attendance_audit('time.policy_changed',jsonb_build_object('old',previous.id,'new',next_id,'reason',reason));
 RETURN private.time_configuration();
END $$;

-- Call only with the employee write lock already held. Lifecycle transitions
-- use the same instant as the change that made the timer ineligible.
CREATE FUNCTION private.time_transition(root_id uuid, next_state text, instant timestamptz, cause text, forced boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE root task_time_segments%ROWTYPE; boundary timestamptz; earliest_end timestamptz; actor uuid=private.work_actor();
BEGIN
 PERFORM 1 FROM attendance_shifts WHERE id=(SELECT shift_id FROM task_time_segments WHERE id=root_id) FOR UPDATE;
 PERFORM 1 FROM attendance_breaks WHERE shift_id=(SELECT shift_id FROM task_time_segments WHERE id=root_id) ORDER BY id FOR UPDATE;
 SELECT * INTO root FROM task_time_segments WHERE id=root_id AND timer_state IN ('RUNNING','PAUSED') FOR UPDATE;
 IF root.id IS NULL THEN RETURN; END IF;
 SELECT least(instant,grant_until) INTO boundary FROM attendance_shifts WHERE id=root.shift_id;
 SELECT max(greatest(recorded_start,recorded_end)) INTO earliest_end FROM task_time_segments WHERE timer_id=root_id;
 IF NOT forced AND (boundary<earliest_end OR instant<>boundary) THEN RAISE EXCEPTION 'Timer clock boundary changed' USING ERRCODE='P0409'; END IF;
 boundary=greatest(boundary,earliest_end);
 UPDATE task_time_segments SET recorded_end=boundary,ended_at=boundary,ended_by=actor,end_reason=cause,observed_end=instant,version=version+1
 WHERE timer_id=root_id AND ended_at IS NULL;
 UPDATE task_time_segments SET timer_state=next_state,timer_version=timer_version+1,
   timer_closed_at=CASE WHEN next_state='STOPPED' THEN boundary END,timer_close_reason=CASE WHEN next_state='STOPPED' THEN cause END
 WHERE id=root_id;
 PERFORM private.attendance_audit('timer.'||lower(next_state),jsonb_build_object('timer_id',root_id,'employee_id',root.employee_id,'shift_id',root.shift_id,'reason',cause,'at',boundary,'observed_at',instant,'clock_anomaly',boundary>instant));
END $$;

CREATE FUNCTION private.timer_command(command text, assignment uuid, expected_assignment integer, root_id uuid, expected_timer integer, operation uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
 actor uuid; duty record; active_shift attendance_shifts%ROWTYPE; root task_time_segments%ROWTYPE;
 target_assignment task_assignments%ROWTYPE; target_task tasks%ROWTYPE; target_project projects%ROWTYPE;
 task_ids uuid[]; assignment_ids uuid[]; instant timestamptz; config jsonb; review_id uuid;
 retry_root task_time_segments%ROWTYPE; fingerprint text; result uuid; seq integer;
BEGIN
 actor=private.lock_work();
 IF private.is_admin() THEN RAISE EXCEPTION 'Employee duty required' USING ERRCODE='42501'; END IF;
 IF operation IS NULL OR command IS NULL OR command NOT IN ('START','SWITCH','PAUSE','RESUME','STOP')
   OR ((command IN ('START','SWITCH')) IS DISTINCT FROM (assignment IS NOT NULL AND expected_assignment IS NOT NULL))
   OR ((command<>'START') IS DISTINCT FROM (root_id IS NOT NULL AND expected_timer IS NOT NULL))
   OR (command='START' AND (root_id IS NOT NULL OR expected_timer IS NOT NULL))
   OR (command NOT IN ('START','SWITCH') AND (assignment IS NOT NULL OR expected_assignment IS NOT NULL)) THEN
  RAISE EXCEPTION 'Invalid timer command' USING ERRCODE='22023';
 END IF;
 SELECT * INTO duty FROM private.duty_context();
 fingerprint=private.work_fingerprint(jsonb_build_array(command,assignment,expected_assignment,root_id,expected_timer));
 IF assignment IS NOT NULL AND NOT EXISTS(SELECT 1 FROM task_assignments WHERE id=assignment AND employee_id=actor AND access_revoked_at IS NULL) THEN
  RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';
 END IF;
 IF root_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM task_time_segments WHERE id=root_id AND timer_id=root_id AND employee_id=actor) THEN
  RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';
 END IF;
 SELECT * INTO retry_root FROM task_time_segments WHERE employee_id=actor AND id=timer_id AND operation_receipts ? operation::text;
 IF retry_root.id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM attendance_shifts WHERE id=retry_root.shift_id AND duty_id=duty.duty_id AND duty_authorization_version=duty.authorization_version) THEN
   RAISE EXCEPTION 'Receipt belongs to another duty grant' USING ERRCODE='P0409';
  END IF;
  IF retry_root.operation_receipts->>operation::text<>fingerprint THEN RAISE EXCEPTION 'Retry key conflict' USING ERRCODE='40001'; END IF;
  RETURN retry_root.id;
 END IF;
 SELECT * INTO root FROM task_time_segments WHERE employee_id=actor AND timer_state IN ('RUNNING','PAUSED');
 IF (command='START' AND root.id IS NOT NULL) OR (command<>'START' AND (root.id IS DISTINCT FROM root_id OR root.timer_version IS DISTINCT FROM expected_timer)) THEN
  RAISE EXCEPTION 'Active timer changed' USING ERRCODE='40001';
 END IF;
 assignment_ids=ARRAY[root.assignment_id,assignment];
 SELECT array_agg(task_id) INTO task_ids FROM task_assignments WHERE id=ANY(assignment_ids);
 PERFORM 1 FROM projects WHERE id IN (SELECT project_id FROM tasks WHERE id=ANY(task_ids)) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM tasks WHERE id=ANY(task_ids) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM task_assignments WHERE id=ANY(assignment_ids) ORDER BY id FOR UPDATE;
 SELECT * INTO active_shift FROM attendance_shifts WHERE employee_id=actor AND clocked_out_at IS NULL AND duty_id=duty.duty_id AND duty_authorization_version=duty.authorization_version FOR UPDATE;
 IF active_shift.id IS NULL OR (root.id IS NOT NULL AND root.shift_id<>active_shift.id) THEN RAISE EXCEPTION 'Open shift required' USING ERRCODE='P0409'; END IF;
 PERFORM 1 FROM attendance_breaks WHERE shift_id=active_shift.id ORDER BY id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM attendance_breaks WHERE shift_id=active_shift.id AND ended_at IS NULL AND NOT is_voided) THEN RAISE EXCEPTION 'End the break first' USING ERRCODE='P0409'; END IF;
 instant=private.security_now();
 IF private.work_actor() IS DISTINCT FROM actor OR instant>=active_shift.grant_until THEN RAISE EXCEPTION 'Current duty required' USING ERRCODE='42501'; END IF;
 IF instant<active_shift.clocked_in_at OR EXISTS(
   SELECT 1 FROM task_time_segments WHERE shift_id=active_shift.id AND greatest(recorded_start,recorded_end)>instant
 ) OR EXISTS(SELECT 1 FROM attendance_breaks WHERE shift_id=active_shift.id AND NOT is_voided AND greatest(started_at,ended_at)>instant) THEN
  RAISE EXCEPTION 'Timer clock moved backwards' USING ERRCODE='P0409';
 END IF;
 config=private.time_configuration();
 IF command='SWITCH' AND (assignment=root.assignment_id OR config->'timers'->>'switchMode'='EXPLICIT_STOP_REQUIRED') THEN
  RAISE EXCEPTION 'Stop the current timer before starting' USING ERRCODE='P0409';
 END IF;
 IF command IN ('START','SWITCH','RESUME') THEN
  SELECT * INTO target_assignment FROM task_assignments WHERE id=coalesce(assignment,root.assignment_id) AND employee_id=actor AND access_revoked_at IS NULL;
  IF target_assignment.id IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
  SELECT * INTO target_task FROM tasks WHERE id=target_assignment.task_id;
  SELECT * INTO target_project FROM projects WHERE id=target_task.project_id;
  IF target_project.status<>'ACTIVE' OR target_task.status IN ('APPROVED','CANCELLED') OR target_assignment.status NOT IN ('PENDING','IN_PROGRESS','REVISION_REQUIRED')
    OR (assignment IS NOT NULL AND target_assignment.version IS DISTINCT FROM expected_assignment) THEN
   RAISE EXCEPTION 'Assignment changed or cannot record time' USING ERRCODE='P0409';
  END IF;
 END IF;
 IF command='PAUSE' THEN
  IF root.timer_state<>'RUNNING' THEN RAISE EXCEPTION 'Timer is not running' USING ERRCODE='P0409'; END IF;
  PERFORM private.time_transition(root.id,'PAUSED',instant,'EMPLOYEE_PAUSE');
  result=root.id;
 ELSIF command='STOP' THEN
  PERFORM private.time_transition(root.id,'STOPPED',instant,'EMPLOYEE_STOP');
  result=root.id;
 ELSIF command='RESUME' THEN
  IF root.timer_state<>'PAUSED' THEN RAISE EXCEPTION 'Timer is not paused' USING ERRCODE='P0409'; END IF;
  SELECT max(segment_sequence)+1 INTO seq FROM task_time_segments WHERE timer_id=root.id;
  INSERT INTO task_time_segments(employee_id,assignment_id,task_id,shift_id,timer_id,segment_sequence,kind,revision_review_id,policy_id,task_label,project_label,recorded_start,started_at)
  VALUES(actor,root.assignment_id,root.task_id,root.shift_id,root.id,seq,root.kind,root.revision_review_id,root.policy_id,root.task_label,root.project_label,instant,instant);
  UPDATE task_time_segments SET timer_state='RUNNING',timer_version=timer_version+1 WHERE id=root.id;
  result=root.id;
 ELSE
  SELECT id INTO review_id FROM task_reviews WHERE submission_id=target_assignment.current_submission_id AND decision='REVISION_REQUIRED';
  IF target_assignment.status IN ('PENDING','REVISION_REQUIRED') THEN
   PERFORM private.task_progress(target_task.id,target_assignment.version,'IN_PROGRESS');
  END IF;
  IF command='SWITCH' THEN PERFORM private.time_transition(root.id,'STOPPED',instant,'SWITCH'); END IF;
  result=gen_random_uuid();
  INSERT INTO task_time_segments(id,employee_id,assignment_id,task_id,shift_id,timer_id,segment_sequence,timer_state,timer_version,kind,revision_review_id,policy_id,task_label,project_label,recorded_start,started_at)
  VALUES(result,actor,target_assignment.id,target_task.id,active_shift.id,result,1,'RUNNING',1,
   CASE WHEN review_id IS NULL THEN 'ORIGINAL' ELSE 'REVISION' END,review_id,(config->>'policyId')::uuid,target_task.title,target_project.name,instant,instant);
 END IF;
 UPDATE task_time_segments SET operation_receipts=operation_receipts||jsonb_build_object(operation::text,fingerprint) WHERE id=result;
 PERFORM private.attendance_audit('timer.command',jsonb_build_object('timer_id',result,'previous_timer_id',root.id,'employee_id',actor,'command',command,'at',instant,'operation_key',operation));
 RETURN result;
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.timer_command(text,uuid,integer,uuid,integer,uuid),private.time_settings(uuid,jsonb,text) TO libetario_runtime;
COMMIT;
