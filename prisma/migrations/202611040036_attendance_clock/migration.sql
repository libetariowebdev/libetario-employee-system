BEGIN;
CREATE FUNCTION private.attendance_snapshot(target uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('shift',to_jsonb(s)-'review_receipts','breaks',coalesce((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.started_at,b.id) FROM attendance_breaks b WHERE b.shift_id=s.id),'[]')) FROM attendance_shifts s WHERE id=target
$$;
CREATE FUNCTION private.attendance_force_close(target uuid,observed timestamptz,cause text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.attendance_shifts%ROWTYPE;ending timestamptz;before_values jsonb;who uuid;actor uuid=private.work_actor();
BEGIN
 SELECT employee_id INTO who FROM attendance_shifts WHERE id=target;
 PERFORM 1 FROM users WHERE id=who FOR UPDATE;
 PERFORM 1 FROM duty_authorizations WHERE id=(SELECT duty_id FROM attendance_shifts WHERE id=target) FOR UPDATE;
 SELECT * INTO s FROM attendance_shifts WHERE id=target FOR UPDATE;
 IF s.id IS NULL OR s.clocked_out_at IS NOT NULL THEN RETURN;END IF;
 PERFORM 1 FROM attendance_breaks WHERE shift_id=target ORDER BY id FOR UPDATE;
 before_values=private.attendance_snapshot(target);
 ending=greatest(s.clocked_in_at,least(observed,s.grant_until),(SELECT max(greatest(started_at,ended_at)) FROM attendance_breaks WHERE shift_id=target AND NOT is_voided));
 UPDATE attendance_breaks SET ended_at=ending,system_end_at=observed,end_reason=cause,ended_by=actor,version=version+1,updated_at=observed WHERE shift_id=target AND ended_at IS NULL AND NOT is_voided;
 UPDATE attendance_shifts SET clocked_out_at=ending,system_closed_at=observed,close_source='SYSTEM',close_reason=cause,closed_by=actor,
 flags=flags||ARRAY[cause,'SYSTEM_CLOSED','MISSING_CLOCK_OUT']||CASE WHEN ending>observed THEN ARRAY['CLOCK_ANOMALY'] ELSE '{}'::text[] END,version=version+1,updated_at=observed WHERE id=target;
 UPDATE attendance_shifts SET flags=array_remove(private.attendance_flags(target,observed),'CORRECTION_PENDING') WHERE id=target;
 PERFORM private.attendance_audit('attendance.system_closed',jsonb_build_object('shift_id',target,'employee_id',s.employee_id,'reason',cause,'observed_at',observed,'effective_end',ending,'before',before_values,'after',private.attendance_snapshot(target)));
END $$;
CREATE FUNCTION private.attendance_reconcile_employee(who uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.attendance_shifts%ROWTYPE;d public.duty_authorizations%ROWTYPE;t timestamptz;f text[];n integer=0;u public.users%ROWTYPE;active boolean;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(72426820::bigint);
 SELECT * INTO u FROM users WHERE id=who FOR UPDATE;
 SELECT employment_status='ACTIVE' INTO active FROM employee_profiles WHERE user_id=who;
 FOR s IN SELECT * FROM attendance_shifts WHERE employee_id=who AND clocked_out_at IS NULL ORDER BY id LOOP
  SELECT * INTO d FROM duty_authorizations WHERE id=s.duty_id FOR UPDATE;t=private.security_now();
  IF d.status<>'ACTIVATED' OR d.authorization_version<>s.duty_authorization_version THEN PERFORM private.attendance_force_close(s.id,coalesce(d.revoked_at,t),'DUTY_REVOKED');n=n+1;
  ELSIF u.disabled_at IS NOT NULL OR NOT active THEN PERFORM private.attendance_force_close(s.id,t,'ACCOUNT_OR_EMPLOYMENT_DISABLED');n=n+1;
  ELSIF t>=s.grant_until THEN PERFORM private.attendance_force_close(s.id,s.grant_until,'DUTY_WINDOW_EXPIRED');n=n+1;
  ELSE
   f=array_remove(private.attendance_flags(s.id,t),'CORRECTION_PENDING');
   IF NOT f<@s.flags THEN
    UPDATE attendance_shifts SET flags=f,updated_at=t WHERE id=s.id;
    PERFORM private.attendance_audit('attendance.flags_detected',jsonb_build_object('shift_id',s.id,'employee_id',who,'flags',f));n=n+1;
   END IF;
  END IF;
 END LOOP;RETURN n;
END $$;
-- Narrow monotonic reconciliation: no caller-chosen employee, boundary or data result.
-- Shared policy lock + sorted SKIP LOCKED employee rows, never a global time gate.
CREATE FUNCTION private.attendance_reconcile_due() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE who uuid;n integer=0;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(72426820::bigint);
 FOR who IN SELECT u.id FROM users u WHERE EXISTS(SELECT 1 FROM attendance_shifts s WHERE s.employee_id=u.id AND s.clocked_out_at IS NULL AND (s.grant_until<=private.security_now() OR (extract(epoch FROM private.security_now()-s.clocked_in_at)>(s.policy_snapshot->>'longShiftReviewSeconds')::int AND NOT 'LONG_SHIFT'=ANY(s.flags)))) ORDER BY u.id LIMIT 100 FOR UPDATE OF u SKIP LOCKED LOOP
  n=n+private.attendance_reconcile_employee(who);
 END LOOP;RETURN n;
END $$;
CREATE FUNCTION private.attendance_command(action text,target uuid,key uuid,expected integer,break_code text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
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
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.attendance_command(text,uuid,uuid,integer,text),private.attendance_reconcile_due() TO libetario_runtime;
COMMIT;
