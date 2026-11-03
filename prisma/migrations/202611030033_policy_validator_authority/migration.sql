BEGIN;
-- Policy insertion remains subject to its existing RLS. The trigger must be able
-- to call its private, pure validator even when a runtime administrator inserts
-- a SECURITY policy; do not grant that helper broadly to the runtime role.
ALTER FUNCTION private.upload_policy_check() SECURITY DEFINER;
COMMIT;
