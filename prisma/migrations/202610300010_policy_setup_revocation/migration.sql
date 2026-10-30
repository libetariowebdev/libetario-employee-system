BEGIN;
CREATE FUNCTION private.revoke_setup_on_policy_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.security_policy_id IS DISTINCT FROM OLD.security_policy_id THEN
  UPDATE public.sessions SET revoked_at=private.security_now(),revocation_reason='SECURITY_POLICY_CHANGED'
   WHERE scope='SETUP' AND revoked_at IS NULL;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.revoke_setup_on_policy_change() FROM PUBLIC;
CREATE TRIGGER revoke_setup_on_security_policy AFTER UPDATE OF security_policy_id ON company_settings
FOR EACH ROW EXECUTE FUNCTION private.revoke_setup_on_policy_change();
COMMIT;
