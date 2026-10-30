BEGIN;
CREATE FUNCTION private.employee_active(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.users u JOIN public.employee_profiles ep ON ep.user_id=u.id WHERE u.id=target AND u.role='EMPLOYEE' AND u.disabled_at IS NULL AND ep.employment_status='ACTIVE')
$$;
REVOKE ALL ON FUNCTION private.employee_active(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.employee_active(uuid) TO libetario_auth;
ALTER FUNCTION private.duty_context() RENAME TO duty_context_base;
REVOKE ALL ON FUNCTION private.duty_context_base() FROM libetario_runtime,libetario_auth,PUBLIC;
CREATE FUNCTION private.duty_context() RETURNS TABLE(user_id uuid,session_id uuid,duty_id uuid,duty_date date,authorization_version integer,valid_until timestamptz,idle_expires_at timestamptz,absolute_expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT b.* FROM private.duty_context_base() b WHERE private.employee_active(b.user_id)
$$;
REVOKE ALL ON FUNCTION private.duty_context() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.duty_context() TO libetario_runtime,libetario_auth;
CREATE FUNCTION private.duty_employee_constraint() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_TABLE_NAME='duty_authorizations' THEN
  IF NEW.status='ACTIVATED' AND NOT private.employee_active(NEW.employee_id) THEN RAISE EXCEPTION 'Active employee required' USING ERRCODE='22023';END IF;
 ELSE
  IF NEW.scope='DUTY' AND NOT private.employee_active(NEW.user_id) THEN RAISE EXCEPTION 'Active employee required' USING ERRCODE='42501';END IF;
 END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.duty_employee_constraint() FROM PUBLIC;
CREATE TRIGGER duty_employee_constraint BEFORE INSERT OR UPDATE ON duty_authorizations FOR EACH ROW EXECUTE FUNCTION private.duty_employee_constraint();
CREATE TRIGGER session_employee_constraint BEFORE INSERT OR UPDATE OF scope ON sessions FOR EACH ROW EXECUTE FUNCTION private.duty_employee_constraint();
CREATE FUNCTION private.employment_duty_invalidation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.employment_status IS DISTINCT FROM OLD.employment_status THEN
  UPDATE public.sessions SET revoked_at=private.security_now(),revocation_reason='DUTY_EMPLOYMENT_CHANGED' WHERE user_id=NEW.user_id AND scope='DUTY' AND revoked_at IS NULL;
  UPDATE public.auth_challenges SET invalidated_at=private.security_now() WHERE user_id=NEW.user_id AND consumed_at IS NULL AND invalidated_at IS NULL;
 END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.employment_duty_invalidation() FROM PUBLIC;
CREATE TRIGGER employment_duty_invalidation AFTER UPDATE OF employment_status ON employee_profiles FOR EACH ROW EXECUTE FUNCTION private.employment_duty_invalidation();
ALTER TABLE auth_challenges ADD CONSTRAINT challenge_pin_stage CHECK(
 (stage='PIN' AND pin_version IS NOT NULL AND pin_verified_at IS NULL) OR
 (stage='TOTP' AND ((pin_version IS NULL AND pin_verified_at IS NULL) OR (pin_version IS NOT NULL AND pin_verified_at IS NOT NULL)))
);
WITH old AS(SELECT p.* FROM policy_versions p JOIN company_settings s ON s.work_policy_id=p.id WHERE s.id=1),
added AS(INSERT INTO policy_versions(policy_key,revision,configuration,created_by)
 SELECT 'WORK',(SELECT max(revision)+1 FROM policy_versions WHERE policy_key='WORK'),jsonb_build_object('overnightCarryHours',8)||configuration,created_by FROM old RETURNING id)
UPDATE company_settings SET work_policy_id=added.id,version=version+1 FROM added WHERE company_settings.id=1;
COMMIT;
