BEGIN;
CREATE FUNCTION private.attendance_schedule(who uuid,day date) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT to_jsonb(x) FROM (SELECT h.id,sd.*,h.expected_daily_seconds,
 CASE WHEN sd.start_local IS NULL THEN NULL ELSE (day+sd.start_local) AT TIME ZONE 'Asia/Manila' END scheduled_start,
 CASE WHEN sd.end_local IS NULL THEN NULL ELSE (day+CASE WHEN sd.ends_next_day THEN 1 ELSE 0 END+sd.end_local) AT TIME ZONE 'Asia/Manila' END scheduled_end
 FROM employee_schedule_history h JOIN employee_schedule_days sd ON sd.schedule_id=h.id WHERE h.employee_id=who AND h.effective_from<=day AND (h.effective_to IS NULL OR h.effective_to>day) AND sd.weekday=extract(isodow FROM day)::int)x
$$;
CREATE FUNCTION private.attendance_invalidate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE who uuid;target uuid;t timestamptz;cause text;
BEGIN
 IF TG_TABLE_NAME='duty_authorizations' THEN
  IF NEW.authorization_version=OLD.authorization_version AND NEW.status=OLD.status THEN RETURN NEW;END IF;
  who=NEW.employee_id;cause='DUTY_REVOKED';t=coalesce(NEW.revoked_at,private.security_now());
 ELSIF TG_TABLE_NAME='users' THEN
  IF NEW.disabled_at IS NULL OR OLD.disabled_at IS NOT NULL THEN RETURN NEW;END IF;who=NEW.id;cause='ACCOUNT_DISABLED';t=private.security_now();
 ELSE
  IF NEW.employment_status='ACTIVE' OR NEW.employment_status=OLD.employment_status THEN RETURN NEW;END IF;who=NEW.user_id;cause='EMPLOYMENT_INACTIVE';t=private.security_now();
 END IF;
 PERFORM 1 FROM users WHERE id=who FOR UPDATE;
 FOR target IN SELECT id FROM attendance_shifts WHERE employee_id=who AND clocked_out_at IS NULL AND (TG_TABLE_NAME<>'duty_authorizations' OR duty_id=(to_jsonb(NEW)->>'id')::uuid) ORDER BY id LOOP
  PERFORM private.attendance_force_close(target,t,cause);
 END LOOP;RETURN NEW;
END $$;
CREATE TRIGGER attendance_duty_invalidate AFTER UPDATE OF status,authorization_version ON duty_authorizations FOR EACH ROW EXECUTE FUNCTION private.attendance_invalidate();
CREATE TRIGGER attendance_user_invalidate AFTER UPDATE OF disabled_at ON users FOR EACH ROW EXECUTE FUNCTION private.attendance_invalidate();
CREATE TRIGGER attendance_employment_invalidate AFTER UPDATE OF employment_status ON employee_profiles FOR EACH ROW EXECUTE FUNCTION private.attendance_invalidate();
CREATE FUNCTION private.attendance_duty_switch() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.scope='DUTY' THEN
  PERFORM 1 FROM users WHERE id=NEW.user_id FOR UPDATE;
  PERFORM private.attendance_reconcile_employee(NEW.user_id);
  IF EXISTS(SELECT 1 FROM attendance_shifts WHERE employee_id=NEW.user_id AND clocked_out_at IS NULL AND (duty_id<>NEW.duty_id OR duty_authorization_version<>NEW.duty_authorization_version)) THEN RAISE EXCEPTION 'Clock Out before switching duty grants' USING ERRCODE='P0409';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER attendance_duty_switch BEFORE INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION private.attendance_duty_switch();
CREATE FUNCTION private.attendance_current() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid=private.work_actor();target uuid;ctx jsonb;t timestamptz=private.security_now();
BEGIN
 IF actor IS NULL OR private.is_admin() THEN RAISE EXCEPTION 'Employee duty required' USING ERRCODE='42501';END IF;
 SELECT id INTO target FROM attendance_shifts WHERE employee_id=actor AND clocked_out_at IS NULL;
 SELECT to_jsonb(d) INTO ctx FROM private.duty_context()d;
 RETURN jsonb_build_object('active',CASE WHEN target IS NOT NULL THEN private.attendance_row(target,t) END,'duty',ctx,'policy',private.attendance_policy(),'asOf',t);
END $$;
CREATE FUNCTION private.attendance_reconcile_self() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid=private.work_actor();
BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION 'Work permission required' USING ERRCODE='42501';END IF;
 IF private.is_admin() THEN RETURN private.attendance_reconcile_due();END IF;
 PERFORM private.attendance_lock(actor);RETURN private.attendance_reconcile_employee(actor);
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.attendance_current(),private.attendance_reconcile_self() TO libetario_runtime;
COMMIT;
