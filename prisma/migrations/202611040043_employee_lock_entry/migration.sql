BEGIN;
-- Existing profile/rate/schedule services enter the same sorted user-row lock
-- order through this administrator-only capability. Internal lock_work stays private.
CREATE FUNCTION private.lock_employee_profile(target uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 RETURN private.lock_work(true,ARRAY[target]);
END $$;
REVOKE ALL ON FUNCTION private.lock_employee_profile(uuid) FROM PUBLIC,libetario_auth;
GRANT EXECUTE ON FUNCTION private.lock_employee_profile(uuid) TO libetario_runtime;
COMMIT;
