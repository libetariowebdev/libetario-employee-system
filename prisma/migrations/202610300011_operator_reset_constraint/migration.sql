BEGIN;
ALTER TABLE credential_resets DROP CONSTRAINT reset_source_check;
ALTER TABLE credential_resets ADD CONSTRAINT reset_source_check CHECK(
 (request_source='ADMIN' AND requested_by IS NOT NULL) OR
 (request_source='CLI' AND requested_by IS NULL AND kind='AUTHENTICATOR' AND
  operator_reference IS NOT NULL AND length(btrim(operator_reference))>0)
);
COMMIT;
