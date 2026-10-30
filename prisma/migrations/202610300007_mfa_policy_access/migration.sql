BEGIN;
CREATE FUNCTION private.current_security_policy_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$SELECT security_policy_id FROM public.company_settings WHERE id=1$$;
REVOKE ALL ON FUNCTION private.current_security_policy_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.current_security_policy_id() TO libetario_auth;
GRANT EXECUTE ON FUNCTION private.auth_context() TO libetario_auth;
COMMIT;
