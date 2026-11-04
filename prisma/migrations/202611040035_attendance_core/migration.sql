BEGIN;
ALTER TABLE attendance_breaks ADD COLUMN system_end_at timestamptz;
ALTER TABLE attendance_adjustments ADD COLUMN review_key uuid,ADD COLUMN review_fingerprint text;
CREATE UNIQUE INDEX attendance_decision_retry ON attendance_adjustments(reviewed_by,review_key) WHERE review_key IS NOT NULL;
CREATE FUNCTION private.attendance_defaults() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT '{"longShiftReviewSeconds":57600,"maxShiftsPerDutyDate":null,"latenessGraceSeconds":0,"breakCodes":[{"code":"MEAL","label":"Meal break","paid":false,"allowanceSeconds":null},{"code":"SHORT","label":"Short break","paid":true,"allowanceSeconds":null}],"reconcileBatchSize":100,"bulkMaxShifts":500,"bulkMaxDays":31}'::jsonb
$$;
CREATE FUNCTION private.attendance_policy_valid(cfg jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE v jsonb;k text;lim jsonb='{"longShiftReviewSeconds":[3600,86400],"latenessGraceSeconds":[0,3600],"reconcileBatchSize":[1,100],"bulkMaxShifts":[1,500],"bulkMaxDays":[1,31]}';n numeric;
BEGIN
 IF cfg IS NULL OR jsonb_typeof(cfg)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(cfg))<>7 THEN RETURN false;END IF;
 FOR k IN SELECT jsonb_object_keys(lim) LOOP
  IF jsonb_typeof(cfg->k) IS DISTINCT FROM 'number' THEN RETURN false;END IF;n=(cfg->>k)::numeric;
  IF n<>trunc(n) OR n<(lim->k->>0)::int OR n>(lim->k->>1)::int THEN RETURN false;END IF;
 END LOOP;
 IF NOT cfg ? 'maxShiftsPerDutyDate' OR (cfg->'maxShiftsPerDutyDate'<>'null'::jsonb AND (jsonb_typeof(cfg->'maxShiftsPerDutyDate')<>'number' OR (cfg->>'maxShiftsPerDutyDate')::numeric<>trunc((cfg->>'maxShiftsPerDutyDate')::numeric) OR (cfg->>'maxShiftsPerDutyDate')::numeric NOT BETWEEN 1 AND 20)) THEN RETURN false;END IF;
 IF jsonb_typeof(cfg->'breakCodes') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 IF jsonb_array_length(cfg->'breakCodes') NOT BETWEEN 1 AND 20 THEN RETURN false;END IF;
 IF (SELECT count(DISTINCT x->>'code') FROM jsonb_array_elements(cfg->'breakCodes')x)<>jsonb_array_length(cfg->'breakCodes') THEN RETURN false;END IF;
 FOR v IN SELECT * FROM jsonb_array_elements(cfg->'breakCodes') LOOP
  IF jsonb_typeof(v)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(v))<>4 OR coalesce(v->>'code','') !~ '^[A-Z][A-Z0-9_]{0,15}$' OR jsonb_typeof(v->'label') IS DISTINCT FROM 'string' OR length(btrim(v->>'label')) NOT BETWEEN 1 AND 80 OR jsonb_typeof(v->'paid') IS DISTINCT FROM 'boolean' OR NOT v ? 'allowanceSeconds' THEN RETURN false;END IF;
  IF v->'allowanceSeconds'<>'null'::jsonb AND (jsonb_typeof(v->'allowanceSeconds')<>'number' OR (v->>'allowanceSeconds')::numeric<>trunc((v->>'allowanceSeconds')::numeric) OR (v->>'allowanceSeconds')::numeric NOT BETWEEN 0 AND 86400) THEN RETURN false;END IF;
 END LOOP;RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
CREATE FUNCTION private.attendance_policy_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN IF NEW.policy_key='WORK' AND NEW.configuration ? 'attendance' AND NOT private.attendance_policy_valid(NEW.configuration->'attendance') THEN RAISE EXCEPTION 'Invalid attendance policy' USING ERRCODE='22023';END IF;RETURN NEW;END $$;
CREATE TRIGGER attendance_policy_check BEFORE INSERT ON policy_versions FOR EACH ROW EXECUTE FUNCTION private.attendance_policy_check();
CREATE FUNCTION private.attendance_policy() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT private.attendance_defaults()||coalesce(p.configuration->'attendance','{}')||jsonb_build_object('policyId',p.id) FROM company_settings c JOIN policy_versions p ON p.id=c.work_policy_id WHERE c.id=1
$$;
CREATE FUNCTION private.attendance_audit(name text,payload jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid=private.work_actor();sid uuid;
BEGIN
 IF actor IS NOT NULL THEN SELECT id INTO sid FROM sessions WHERE token_hash=current_setting('app.session_hash',true) AND user_id=actor;END IF;
 INSERT INTO audit_log(actor_user_id,session_id,action,occurred_at,request_id,payload) VALUES(actor,sid,name,private.security_now(),coalesce(nullif(current_setting('app.request_id',true),''),gen_random_uuid()::text),payload);
END $$;
CREATE FUNCTION private.attendance_note(note text) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN IF note IS NULL OR length(btrim(note)) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'Reason requires 10-2000 characters' USING ERRCODE='22023';END IF;END $$;
CREATE FUNCTION private.attendance_lock(employee uuid,admin_only boolean DEFAULT false,recent boolean DEFAULT false) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid;
BEGIN
 IF NOT private.attendance_visible(employee) OR (admin_only AND NOT private.is_admin()) THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
 actor=private.lock_work(admin_only,ARRAY[employee]);
 IF NOT private.attendance_visible(employee) OR (recent AND NOT private.admin_recent()) THEN RAISE EXCEPTION 'Current permission and recent MFA required' USING ERRCODE='42501';END IF;RETURN actor;
END $$;
CREATE FUNCTION private.attendance_flags(target uuid,at_time timestamptz) RETURNS text[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.attendance_shifts%ROWTYPE;ending timestamptz;flags text[];b record;
BEGIN
 SELECT * INTO s FROM attendance_shifts WHERE id=target;IF s.id IS NULL THEN RETURN '{}';END IF;
 ending=coalesce(s.clocked_out_at,least(at_time,s.grant_until));flags=s.flags;
 IF s.schedule_snapshot IS NULL THEN flags=array_append(flags,'SCHEDULE_UNCONFIGURED');ELSE
  IF NOT (s.schedule_snapshot->>'working_day')::boolean THEN flags=array_append(flags,'NON_WORKING_DAY');END IF;
  IF s.schedule_snapshot->>'scheduled_start' IS NOT NULL AND s.clocked_in_at>(s.schedule_snapshot->>'scheduled_start')::timestamptz+make_interval(secs=>(s.policy_snapshot->>'latenessGraceSeconds')::int) THEN flags=array_append(flags,'LATE');END IF;
  IF s.schedule_snapshot->>'scheduled_end' IS NOT NULL AND ending>(s.schedule_snapshot->>'scheduled_end')::timestamptz THEN flags=array_append(flags,'AFTER_SCHEDULE');END IF;
 END IF;
 IF s.clocked_out_at IS NOT NULL AND ending=s.clocked_in_at THEN flags=array_append(flags,'ZERO_DURATION');END IF;
 IF ending<s.clocked_in_at THEN flags=array_append(flags,'CLOCK_ANOMALY');END IF;
 IF extract(epoch FROM ending-s.clocked_in_at)>(s.policy_snapshot->>'longShiftReviewSeconds')::int THEN flags=array_append(flags,'LONG_SHIFT');END IF;
 IF s.clocked_out_at IS NULL AND at_time>=s.grant_until THEN flags=flags||ARRAY['DUTY_WINDOW_EXPIRED','MISSING_CLOCK_OUT'];END IF;
 IF EXISTS(SELECT 1 FROM attendance_adjustments WHERE target_shift_id=target AND status='PENDING') THEN flags=array_append(flags,'CORRECTION_PENDING');END IF;
 FOR b IN SELECT code,paid,min(allowance_seconds) allowance,sum(extract(epoch FROM greatest(started_at,coalesce(ended_at,ending))-started_at)) elapsed FROM attendance_breaks WHERE shift_id=target AND NOT is_voided GROUP BY code,paid LOOP
  IF b.allowance IS NULL THEN flags=array_append(flags,'BREAK_ALLOWANCE_UNCONFIGURED');ELSIF b.elapsed>b.allowance THEN flags=array_append(flags,'BREAK_OVER_ALLOWANCE');END IF;
 END LOOP;
 IF s.schedule_snapshot IS NOT NULL AND EXISTS(SELECT 1 FROM attendance_breaks WHERE shift_id=target AND NOT is_voided GROUP BY paid HAVING sum(extract(epoch FROM greatest(started_at,coalesce(ended_at,ending))-started_at))>CASE WHEN paid THEN (s.schedule_snapshot->>'paid_break_seconds')::int ELSE (s.schedule_snapshot->>'unpaid_break_seconds')::int END) THEN flags=array_append(flags,'BREAK_OVER_ALLOWANCE');END IF;
 RETURN ARRAY(SELECT DISTINCT x FROM unnest(flags)x ORDER BY x);
END $$;
CREATE FUNCTION private.attendance_gross(s public.attendance_shifts,at_time timestamptz) RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT greatest(0,extract(epoch FROM coalesce(s.clocked_out_at,least(at_time,s.grant_until))-s.clocked_in_at))
$$;
CREATE FUNCTION private.attendance_suggested(target uuid) RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT greatest(0,extract(epoch FROM s.clocked_out_at-s.clocked_in_at)-coalesce((SELECT sum(extract(epoch FROM b.ended_at-b.started_at)) FROM attendance_breaks b WHERE b.shift_id=s.id AND NOT b.paid AND NOT b.is_voided),0)) FROM attendance_shifts s WHERE id=target AND clocked_out_at IS NOT NULL
$$;
CREATE FUNCTION private.attendance_preserve() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_TABLE_NAME='attendance_shifts' THEN
  IF (NEW.id,NEW.employee_id,NEW.duty_id,NEW.duty_authorization_version,NEW.duty_date,NEW.grant_from,NEW.grant_until,NEW.shift_number,NEW.recorded_in_at,NEW.source,NEW.origin_adjustment_id,NEW.policy_id,NEW.policy_snapshot,NEW.schedule_id,NEW.weekday,NEW.schedule_snapshot,NEW.clock_in_key,NEW.clock_in_fingerprint,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.employee_id,OLD.duty_id,OLD.duty_authorization_version,OLD.duty_date,OLD.grant_from,OLD.grant_until,OLD.shift_number,OLD.recorded_in_at,OLD.source,OLD.origin_adjustment_id,OLD.policy_id,OLD.policy_snapshot,OLD.schedule_id,OLD.weekday,OLD.schedule_snapshot,OLD.clock_in_key,OLD.clock_in_fingerprint,OLD.created_at) OR (OLD.recorded_out_at IS NOT NULL AND NEW.recorded_out_at IS DISTINCT FROM OLD.recorded_out_at) OR (OLD.system_closed_at IS NOT NULL AND NEW.system_closed_at IS DISTINCT FROM OLD.system_closed_at) THEN RAISE EXCEPTION 'Immutable attendance evidence' USING ERRCODE='22023';END IF;
 ELSIF TG_TABLE_NAME='attendance_breaks' THEN
  IF (NEW.id,NEW.shift_id,NEW.employee_id,NEW.recorded_start,NEW.recorded_code,NEW.recorded_paid,NEW.policy_id,NEW.source,NEW.origin_adjustment_id,NEW.start_key,NEW.start_fingerprint,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.shift_id,OLD.employee_id,OLD.recorded_start,OLD.recorded_code,OLD.recorded_paid,OLD.policy_id,OLD.source,OLD.origin_adjustment_id,OLD.start_key,OLD.start_fingerprint,OLD.created_at) OR (OLD.recorded_end IS NOT NULL AND NEW.recorded_end IS DISTINCT FROM OLD.recorded_end) OR (OLD.system_end_at IS NOT NULL AND NEW.system_end_at IS DISTINCT FROM OLD.system_end_at) THEN RAISE EXCEPTION 'Immutable break evidence' USING ERRCODE='22023';END IF;
 ELSE
  IF OLD.status<>'PENDING' OR NEW.status='PENDING' OR (NEW.id,NEW.employee_id,NEW.duty_id,NEW.kind,NEW.target_shift_id,NEW.requested_by,NEW.reason,NEW.target_version,NEW.original_values,NEW.proposed_values,NEW.grant_snapshot,NEW.request_key,NEW.fingerprint,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.employee_id,OLD.duty_id,OLD.kind,OLD.target_shift_id,OLD.requested_by,OLD.reason,OLD.target_version,OLD.original_values,OLD.proposed_values,OLD.grant_snapshot,OLD.request_key,OLD.fingerprint,OLD.created_at) THEN RAISE EXCEPTION 'Immutable correction request/decision' USING ERRCODE='22023';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER attendance_preserve BEFORE UPDATE ON attendance_shifts FOR EACH ROW EXECUTE FUNCTION private.attendance_preserve();
CREATE TRIGGER attendance_preserve BEFORE UPDATE ON attendance_breaks FOR EACH ROW EXECUTE FUNCTION private.attendance_preserve();
CREATE TRIGGER attendance_preserve BEFORE UPDATE ON attendance_adjustments FOR EACH ROW EXECUTE FUNCTION private.attendance_preserve();
CREATE FUNCTION private.attendance_integrity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE target uuid;s public.attendance_shifts%ROWTYPE;a public.attendance_adjustments%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='attendance_shifts' THEN target=NEW.id;ELSIF TG_TABLE_NAME='attendance_breaks' THEN target=NEW.shift_id;ELSE target=NEW.applied_shift_id;END IF;
 IF target IS NULL THEN RETURN NULL;END IF;SELECT * INTO s FROM attendance_shifts WHERE id=target;
 IF EXISTS(SELECT 1 FROM attendance_breaks b WHERE shift_id=target AND NOT is_voided AND (b.started_at<s.clocked_in_at OR (s.clocked_out_at IS NOT NULL AND (b.ended_at IS NULL OR b.ended_at>s.clocked_out_at)))) THEN RAISE EXCEPTION 'Break outside shift' USING ERRCODE='23514';END IF;
 IF (SELECT policy_key FROM policy_versions WHERE id=s.policy_id)<>'WORK' OR (s.schedule_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM employee_schedule_history WHERE id=s.schedule_id AND employee_id=s.employee_id AND effective_from<=s.duty_date AND (effective_to IS NULL OR effective_to>s.duty_date))) THEN RAISE EXCEPTION 'Invalid policy/schedule capture' USING ERRCODE='23514';END IF;
 IF s.source='CORRECTION' THEN SELECT * INTO a FROM attendance_adjustments WHERE id=s.origin_adjustment_id;IF a.status<>'APPROVED' OR a.applied_shift_id IS DISTINCT FROM target OR a.employee_id<>s.employee_id OR a.duty_id<>s.duty_id THEN RAISE EXCEPTION 'Approved correction required' USING ERRCODE='23514';END IF;END IF;
 IF EXISTS(SELECT 1 FROM attendance_breaks b LEFT JOIN attendance_adjustments x ON x.id=coalesce(b.last_adjustment_id,b.origin_adjustment_id) WHERE b.shift_id=target AND (b.origin_adjustment_id IS NOT NULL OR b.last_adjustment_id IS NOT NULL) AND (x.status IS DISTINCT FROM 'APPROVED' OR x.applied_shift_id IS DISTINCT FROM target)) THEN RAISE EXCEPTION 'Approved break correction required' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER attendance_consistency AFTER INSERT OR UPDATE ON attendance_shifts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.attendance_integrity();
CREATE CONSTRAINT TRIGGER attendance_consistency AFTER INSERT OR UPDATE ON attendance_breaks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.attendance_integrity();
CREATE CONSTRAINT TRIGGER attendance_consistency AFTER INSERT OR UPDATE ON attendance_adjustments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.attendance_integrity();
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC;
COMMIT;
