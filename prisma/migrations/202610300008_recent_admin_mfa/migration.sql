BEGIN;
CREATE FUNCTION private.admin_recent() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT private.is_admin() AND coalesce((SELECT mfa_verified_at>=private.security_now()-make_interval(mins=>coalesce((private.security_policy()->>'sensitiveReauthMinutes')::int,5)) FROM private.auth_context()),false)
$$;
REVOKE ALL ON FUNCTION private.admin_recent() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.admin_recent() TO libetario_runtime;
DROP POLICY policy_create ON policy_versions;
CREATE POLICY policy_create ON policy_versions FOR INSERT TO libetario_runtime WITH CHECK(private.is_admin() AND created_by=private.actor() AND (policy_key<>'SECURITY' OR private.admin_recent()));
DROP POLICY settings_edit ON company_settings;
CREATE POLICY settings_edit ON company_settings FOR UPDATE TO libetario_runtime USING(private.admin_recent()) WITH CHECK(private.admin_recent());
COMMIT;
