-- Applied only after the profile/rate checkpoint passes.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_schedule_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_schedule_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_throttles ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE credential_resets ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_read ON users FOR SELECT TO libetario_runtime USING(private.can_read(id));
CREATE POLICY user_create ON users FOR INSERT TO libetario_runtime WITH CHECK(private.is_admin() AND role='EMPLOYEE' AND must_change_password AND disabled_at IS NULL);
CREATE POLICY user_edit ON users FOR UPDATE TO libetario_runtime USING(private.is_admin() AND role='EMPLOYEE') WITH CHECK(private.is_admin() AND role='EMPLOYEE');
GRANT SELECT(id,email,username,role,disabled_at,must_change_password,created_at,updated_at,version) ON users TO libetario_runtime;
GRANT INSERT ON users TO libetario_runtime;
GRANT UPDATE(email,username,version,updated_at) ON users TO libetario_runtime;

CREATE POLICY policy_read ON policy_versions FOR SELECT TO libetario_runtime USING(private.is_admin());
CREATE POLICY policy_create ON policy_versions FOR INSERT TO libetario_runtime WITH CHECK(private.is_admin() AND created_by=private.actor());
GRANT SELECT,INSERT ON policy_versions TO libetario_runtime;
CREATE POLICY settings_read ON company_settings FOR SELECT TO libetario_runtime USING(private.is_admin());
CREATE POLICY settings_edit ON company_settings FOR UPDATE TO libetario_runtime USING(private.is_admin()) WITH CHECK(private.is_admin());
GRANT SELECT,UPDATE ON company_settings TO libetario_runtime;
CREATE POLICY schedule_read ON employee_schedule_history FOR SELECT TO libetario_runtime USING(private.can_read(employee_id));
CREATE POLICY schedule_create ON employee_schedule_history FOR INSERT TO libetario_runtime WITH CHECK(private.is_admin() AND created_by=private.actor());
CREATE POLICY schedule_edit ON employee_schedule_history FOR UPDATE TO libetario_runtime USING(private.is_admin()) WITH CHECK(private.is_admin());
GRANT SELECT,INSERT,UPDATE ON employee_schedule_history TO libetario_runtime;
CREATE POLICY days_read ON employee_schedule_days FOR SELECT TO libetario_runtime USING(EXISTS(SELECT 1 FROM employee_schedule_history s WHERE s.id=schedule_id AND private.can_read(s.employee_id)));
CREATE POLICY days_create ON employee_schedule_days FOR INSERT TO libetario_runtime WITH CHECK(private.is_admin());
GRANT SELECT,INSERT ON employee_schedule_days TO libetario_runtime;
CREATE POLICY session_read ON sessions FOR SELECT TO libetario_runtime USING(user_id=private.actor() OR private.is_admin());
GRANT SELECT(id,user_id,scope,created_at,last_seen_at,idle_expires_at,absolute_expires_at,revoked_at,revocation_reason) ON sessions TO libetario_runtime;
CREATE POLICY events_read ON auth_events FOR SELECT TO libetario_runtime USING(private.is_admin());
CREATE POLICY audit_read ON audit_log FOR SELECT TO libetario_runtime USING(private.is_admin());
GRANT SELECT ON auth_events,audit_log TO libetario_runtime;
-- No runtime SELECT/INSERT/UPDATE privilege on throttles/resets or credential columns.

-- Separate authentication authority: no employee/rate/schedule or audit SELECT.
CREATE POLICY auth_users ON users TO libetario_auth USING(true) WITH CHECK(true);
CREATE POLICY auth_sessions ON sessions TO libetario_auth USING(true) WITH CHECK(true);
CREATE POLICY auth_throttles ON security_throttles TO libetario_auth USING(true) WITH CHECK(true);
CREATE POLICY auth_events ON auth_events FOR INSERT TO libetario_auth WITH CHECK(true);
CREATE POLICY auth_resets ON credential_resets TO libetario_auth USING(true) WITH CHECK(true);
GRANT SELECT(id,email,username,password_hash,role,disabled_at,must_change_password,authorization_version) ON users TO libetario_auth;
GRANT UPDATE(password_hash,password_changed_at,must_change_password,authorization_version,updated_at,version) ON users TO libetario_auth;
GRANT SELECT,INSERT,UPDATE ON sessions,security_throttles TO libetario_auth;
GRANT INSERT ON auth_events TO libetario_auth;
GRANT SELECT,UPDATE ON credential_resets TO libetario_auth;

CREATE FUNCTION private.security_policy() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT p.configuration FROM public.company_settings s JOIN public.policy_versions p ON p.id=s.security_policy_id WHERE s.id=1
$$;
GRANT EXECUTE ON FUNCTION private.security_policy() TO libetario_auth;
REVOKE ALL ON FUNCTION private.security_policy() FROM PUBLIC;

CREATE FUNCTION private.write_audit(action_name text, details jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor_id uuid; sid uuid;
BEGIN
 SELECT user_id,session_id INTO actor_id,sid FROM private.identity();
 INSERT INTO public.audit_log(actor_user_id,session_id,action,request_id,payload)
 VALUES(actor_id,sid,action_name,coalesce(nullif(current_setting('app.request_id',true),''),gen_random_uuid()::text),details);
END $$;
REVOKE ALL ON FUNCTION private.write_audit(text,jsonb) FROM PUBLIC;

CREATE FUNCTION private.audit_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE old_json jsonb; new_json jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN old_json=to_jsonb(OLD)-'password_hash'; END IF;
 IF TG_OP<>'DELETE' THEN new_json=to_jsonb(NEW)-'password_hash'; END IF;
 PERFORM private.write_audit(TG_TABLE_NAME||'.'||lower(TG_OP),jsonb_build_object('before',old_json,'after',new_json,'reason',nullif(current_setting('app.change_reason',true),'')));
 RETURN NEW;
END $$;
CREATE TRIGGER audit_users AFTER INSERT OR UPDATE ON users FOR EACH ROW EXECUTE FUNCTION private.audit_change();
CREATE TRIGGER audit_profiles AFTER INSERT OR UPDATE ON employee_profiles FOR EACH ROW EXECUTE FUNCTION private.audit_change();
CREATE TRIGGER audit_rates AFTER INSERT OR UPDATE ON employee_rate_history FOR EACH ROW EXECUTE FUNCTION private.audit_change();
CREATE TRIGGER audit_schedules AFTER INSERT OR UPDATE ON employee_schedule_history FOR EACH ROW EXECUTE FUNCTION private.audit_change();
CREATE TRIGGER audit_days AFTER INSERT ON employee_schedule_days FOR EACH ROW EXECUTE FUNCTION private.audit_change();
CREATE TRIGGER audit_policies AFTER INSERT ON policy_versions FOR EACH ROW EXECUTE FUNCTION private.audit_change();
CREATE TRIGGER audit_settings AFTER UPDATE ON company_settings FOR EACH ROW EXECUTE FUNCTION private.audit_change();

CREATE FUNCTION private.immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'Append-only record' USING ERRCODE='42501'; END $$;
CREATE TRIGGER protect_audit BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION private.immutable();
CREATE TRIGGER protect_auth_events BEFORE UPDATE OR DELETE OR TRUNCATE ON auth_events FOR EACH STATEMENT EXECUTE FUNCTION private.immutable();
CREATE TRIGGER protect_policies BEFORE UPDATE OR DELETE OR TRUNCATE ON policy_versions FOR EACH STATEMENT EXECUTE FUNCTION private.immutable();

CREATE FUNCTION private.validate_policy_link() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_TABLE_NAME='company_settings' THEN
  IF NOT EXISTS(SELECT 1 FROM policy_versions WHERE id=NEW.security_policy_id AND policy_key='SECURITY') OR
     NOT EXISTS(SELECT 1 FROM policy_versions WHERE id=NEW.work_policy_id AND policy_key='WORK') OR
     NOT EXISTS(SELECT 1 FROM policy_versions WHERE id=NEW.pay_policy_id AND policy_key='PAY') THEN RAISE EXCEPTION 'Incorrect policy kind'; END IF;
 ELSIF TG_TABLE_NAME='employee_rate_history' THEN
  IF NOT EXISTS(SELECT 1 FROM policy_versions WHERE id=NEW.pay_policy_id AND policy_key='PAY') THEN RAISE EXCEPTION 'Incorrect pay policy'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM policy_versions WHERE id=NEW.work_policy_id AND policy_key='WORK') THEN RAISE EXCEPTION 'Incorrect work policy'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER settings_policy BEFORE INSERT OR UPDATE ON company_settings FOR EACH ROW EXECUTE FUNCTION private.validate_policy_link();
CREATE TRIGGER rates_policy BEFORE INSERT OR UPDATE ON employee_rate_history FOR EACH ROW EXECUTE FUNCTION private.validate_policy_link();
CREATE TRIGGER schedule_policy BEFORE INSERT OR UPDATE ON employee_schedule_history FOR EACH ROW EXECUTE FUNCTION private.validate_policy_link();

CREATE FUNCTION private.profile_status() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.employment_status<>OLD.employment_status THEN
  UPDATE public.users SET disabled_at=CASE WHEN NEW.employment_status='INACTIVE' THEN statement_timestamp() ELSE NULL END,authorization_version=authorization_version+1,updated_at=statement_timestamp(),version=version+1 WHERE id=NEW.user_id;
  UPDATE public.sessions SET revoked_at=statement_timestamp(),revocation_reason='EMPLOYMENT_STATUS_CHANGED' WHERE user_id=NEW.user_id AND revoked_at IS NULL;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER profile_status_changed AFTER UPDATE OF employment_status ON employee_profiles FOR EACH ROW EXECUTE FUNCTION private.profile_status();

CREATE FUNCTION private.request_password_reset(target uuid, token_digest text, note text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor_id uuid;
BEGIN
 IF NOT private.is_admin() THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 actor_id=private.actor();
 PERFORM 1 FROM public.users WHERE id=target AND disabled_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Account unavailable'; END IF;
 IF length(token_digest)<>64 THEN RAISE EXCEPTION 'Invalid digest'; END IF;
 UPDATE public.credential_resets SET consumed_at=statement_timestamp() WHERE user_id=target AND consumed_at IS NULL;
 INSERT INTO public.credential_resets(user_id,requested_by,verification_note,token_hash,expires_at)
 VALUES(target,actor_id,note,token_digest,statement_timestamp()+make_interval(mins=>(private.security_policy()->>'resetMinutes')::int));
 UPDATE public.users SET authorization_version=authorization_version+1,updated_at=statement_timestamp(),version=version+1 WHERE id=target;
 UPDATE public.sessions SET revoked_at=statement_timestamp(),revocation_reason='PASSWORD_RESET_REQUESTED' WHERE user_id=target AND revoked_at IS NULL;
 PERFORM private.write_audit('password.reset_requested',jsonb_build_object('employee_id',target,'verification_note',note));
END $$;
REVOKE ALL ON FUNCTION private.request_password_reset(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.request_password_reset(uuid,text,text) TO libetario_runtime;

-- Functions default to PUBLIC EXECUTE; deny every helper except the explicit API.
REVOKE ALL ON FUNCTION private.audit_change(),private.immutable(),private.validate_policy_link(),private.profile_status() FROM PUBLIC;
