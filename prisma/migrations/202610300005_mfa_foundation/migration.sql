-- Checkpoint 2a: THREE new tables only. Duty/challenge tables belong to 2b.
BEGIN;
CREATE TABLE mfa_enrollments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 generation integer NOT NULL CHECK(generation>0),state text NOT NULL CHECK(state IN ('PENDING','CONFIRMED','REVOKED','EXPIRED')),
 ciphertext bytea,nonce bytea,tag bytea,encryption_key_id text,encryption_format_version integer NOT NULL DEFAULT 1 CHECK(encryption_format_version=1),
 algorithm text NOT NULL DEFAULT 'SHA1' CHECK(algorithm='SHA1'),digits integer NOT NULL DEFAULT 6 CHECK(digits=6),period_seconds integer NOT NULL DEFAULT 30 CHECK(period_seconds=30),
 enrollment_session_id uuid NOT NULL,reset_id uuid,recovered_from_id uuid,
 pending_expires_at timestamptz,confirmed_at timestamptz,last_accepted_step bigint CHECK(last_accepted_step>=0),
 recovery_batch_version integer NOT NULL DEFAULT 0 CHECK(recovery_batch_version>=0),revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version integer NOT NULL DEFAULT 1,
 UNIQUE(id,user_id),UNIQUE(user_id,generation),
 CHECK(state NOT IN ('PENDING','CONFIRMED') OR (ciphertext IS NOT NULL AND octet_length(ciphertext)=32 AND nonce IS NOT NULL AND octet_length(nonce)=12 AND tag IS NOT NULL AND octet_length(tag)=16 AND encryption_key_id IS NOT NULL)),
 CHECK(state<>'PENDING' OR (pending_expires_at IS NOT NULL AND confirmed_at IS NULL)),
 CHECK(state<>'CONFIRMED' OR (confirmed_at IS NOT NULL AND last_accepted_step IS NOT NULL)),
 CHECK(state<>'REVOKED' OR revoked_at IS NOT NULL)
);
CREATE UNIQUE INDEX mfa_current_user ON mfa_enrollments(user_id) WHERE state IN ('PENDING','CONFIRMED');
CREATE UNIQUE INDEX mfa_nonce_unique ON mfa_enrollments(encryption_key_id,nonce) WHERE nonce IS NOT NULL;
CREATE INDEX ON mfa_enrollments(enrollment_session_id);CREATE INDEX ON mfa_enrollments(reset_id);CREATE INDEX ON mfa_enrollments(recovered_from_id);
CREATE TABLE employee_pins (
 user_id uuid PRIMARY KEY REFERENCES employee_profiles(user_id) ON DELETE RESTRICT,pin_hash text NOT NULL,changed_at timestamptz NOT NULL DEFAULT now(),version integer NOT NULL DEFAULT 1 CHECK(version>0)
);
CREATE TABLE recovery_codes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),enrollment_id uuid NOT NULL REFERENCES mfa_enrollments(id) ON DELETE RESTRICT,
 batch_version integer NOT NULL CHECK(batch_version>0),code_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),consumed_at timestamptz,revoked_at timestamptz
);
CREATE INDEX ON recovery_codes(enrollment_id,batch_version);
ALTER TABLE sessions ADD CONSTRAINT sessions_id_user_unique UNIQUE(id,user_id);
ALTER TABLE sessions DROP CONSTRAINT sessions_scope_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_scope_check CHECK(scope IN ('ACCOUNT','SETUP'));
ALTER TABLE sessions ADD COLUMN setup_purpose text CHECK(setup_purpose IN ('PASSWORD_CHANGE','MFA_LOGIN','MFA_ENROLL','MFA_RECOVERY','MFA_RESET_REQUIRED'));
ALTER TABLE sessions ADD COLUMN password_verified_at timestamptz;
ALTER TABLE sessions ADD COLUMN mfa_enrollment_id uuid;
ALTER TABLE sessions ADD COLUMN mfa_verified_at timestamptz;
ALTER TABLE sessions ADD COLUMN setup_failures integer NOT NULL DEFAULT 0 CHECK(setup_failures>=0);
ALTER TABLE sessions ADD COLUMN security_policy_id uuid REFERENCES policy_versions(id) ON DELETE RESTRICT;
ALTER TABLE sessions ADD COLUMN reset_id uuid;
ALTER TABLE sessions ADD COLUMN recovery_enrollment_id uuid;
ALTER TABLE sessions ADD CONSTRAINT sessions_mfa_owner FOREIGN KEY(mfa_enrollment_id,user_id) REFERENCES mfa_enrollments(id,user_id) ON DELETE RESTRICT;
ALTER TABLE sessions ADD CONSTRAINT sessions_recovery_owner FOREIGN KEY(recovery_enrollment_id,user_id) REFERENCES mfa_enrollments(id,user_id) ON DELETE RESTRICT;
ALTER TABLE sessions ADD CONSTRAINT sessions_scope_purpose_check CHECK((scope='SETUP' AND setup_purpose IS NOT NULL AND mfa_verified_at IS NULL) OR (scope='ACCOUNT' AND setup_purpose IS NULL));
CREATE INDEX ON sessions(mfa_enrollment_id);CREATE INDEX ON sessions(security_policy_id);CREATE INDEX ON sessions(reset_id);CREATE INDEX ON sessions(recovery_enrollment_id);
ALTER TABLE credential_resets DROP CONSTRAINT credential_resets_kind_check;
ALTER TABLE credential_resets ADD CONSTRAINT credential_resets_kind_check CHECK(kind IN ('PASSWORD','AUTHENTICATOR'));
ALTER TABLE credential_resets ALTER COLUMN requested_by DROP NOT NULL;
ALTER TABLE credential_resets ADD COLUMN reason text;
ALTER TABLE credential_resets ADD COLUMN request_source text NOT NULL DEFAULT 'ADMIN' CHECK(request_source IN ('ADMIN','CLI'));
ALTER TABLE credential_resets ADD COLUMN operator_reference text;
ALTER TABLE credential_resets ADD COLUMN target_enrollment_id uuid;
ALTER TABLE credential_resets ADD CONSTRAINT resets_id_user_unique UNIQUE(id,user_id);
ALTER TABLE credential_resets ADD CONSTRAINT resets_enrollment_owner FOREIGN KEY(target_enrollment_id,user_id) REFERENCES mfa_enrollments(id,user_id) ON DELETE RESTRICT;
ALTER TABLE credential_resets ADD CONSTRAINT reset_source_check CHECK((request_source='ADMIN' AND requested_by IS NOT NULL) OR (request_source='CLI' AND requested_by IS NULL AND kind='AUTHENTICATOR' AND length(btrim(operator_reference))>0));
ALTER TABLE credential_resets ADD CONSTRAINT reset_mfa_reason CHECK(kind<>'AUTHENTICATOR' OR (target_enrollment_id IS NOT NULL AND reason IS NOT NULL AND length(btrim(reason)) BETWEEN 10 AND 500));
CREATE INDEX ON credential_resets(target_enrollment_id);
ALTER TABLE mfa_enrollments ADD CONSTRAINT enrollment_session_owner FOREIGN KEY(enrollment_session_id,user_id) REFERENCES sessions(id,user_id) ON DELETE RESTRICT;
ALTER TABLE mfa_enrollments ADD CONSTRAINT enrollment_reset_owner FOREIGN KEY(reset_id,user_id) REFERENCES credential_resets(id,user_id) ON DELETE RESTRICT;
ALTER TABLE mfa_enrollments ADD CONSTRAINT enrollment_recovery_owner FOREIGN KEY(recovered_from_id,user_id) REFERENCES mfa_enrollments(id,user_id) ON DELETE RESTRICT;
ALTER TABLE sessions ADD CONSTRAINT session_reset_owner FOREIGN KEY(reset_id,user_id) REFERENCES credential_resets(id,user_id) ON DELETE RESTRICT;

CREATE FUNCTION private.security_now() RETURNS timestamptz LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$SELECT clock_timestamp()$$;
REVOKE ALL ON FUNCTION private.security_now() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.security_now() TO libetario_runtime,libetario_auth;

-- Keep Phase 1 function signatures; all ordinary RLS checks now enforce admin MFA.
CREATE FUNCTION private.auth_context() RETURNS TABLE(user_id uuid,role "Role",must_change_password boolean,session_id uuid,scope text,setup_purpose text,mfa_enrollment_id uuid,mfa_verified_at timestamptz,password_verified_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT u.id,u.role,u.must_change_password,s.id,s.scope,s.setup_purpose,s.mfa_enrollment_id,s.mfa_verified_at,s.password_verified_at
 FROM public.sessions s JOIN public.users u ON u.id=s.user_id
 WHERE s.token_hash=current_setting('app.session_hash',true) AND s.revoked_at IS NULL AND u.disabled_at IS NULL AND s.authorization_version=u.authorization_version
 AND s.idle_expires_at>private.security_now() AND s.absolute_expires_at>private.security_now()
 AND (s.scope='SETUP' OR u.role='EMPLOYEE' OR (s.mfa_verified_at IS NOT NULL AND EXISTS(SELECT 1 FROM public.mfa_enrollments e WHERE e.id=s.mfa_enrollment_id AND e.user_id=u.id AND e.state='CONFIRMED')))
$$;
CREATE OR REPLACE FUNCTION private.identity() RETURNS TABLE(user_id uuid,role "Role",must_change_password boolean,session_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$SELECT user_id,role,must_change_password,session_id FROM private.auth_context() WHERE scope='ACCOUNT'$$;
REVOKE ALL ON FUNCTION private.auth_context() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.auth_context() TO libetario_runtime;

ALTER TABLE mfa_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE recovery_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY mfa_metadata ON mfa_enrollments FOR SELECT TO libetario_runtime USING(private.can_read(user_id));
GRANT SELECT(id,user_id,generation,state,confirmed_at,revoked_at,created_at) ON mfa_enrollments TO libetario_runtime;
CREATE POLICY auth_mfa ON mfa_enrollments TO libetario_auth USING(true) WITH CHECK(true);
CREATE POLICY auth_pins ON employee_pins TO libetario_auth USING(true) WITH CHECK(true);
CREATE POLICY auth_recovery ON recovery_codes TO libetario_auth USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE ON mfa_enrollments,employee_pins,recovery_codes TO libetario_auth;
-- Runtime receives NO PIN/recovery hashes or enrollment ciphertext and cannot mutate MFA claims.
REVOKE ALL ON employee_pins,recovery_codes FROM libetario_runtime;

CREATE FUNCTION private.validate_session_mfa() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.scope='ACCOUNT' AND EXISTS(SELECT 1 FROM public.users WHERE id=NEW.user_id AND role='ADMINISTRATOR') AND
 (NEW.mfa_verified_at IS NULL OR NOT EXISTS(SELECT 1 FROM public.mfa_enrollments WHERE id=NEW.mfa_enrollment_id AND user_id=NEW.user_id AND state='CONFIRMED')) THEN RAISE EXCEPTION 'Administrator MFA required' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER validate_session_mfa BEFORE INSERT OR UPDATE OF scope,mfa_enrollment_id,mfa_verified_at ON sessions FOR EACH ROW EXECUTE FUNCTION private.validate_session_mfa();
REVOKE ALL ON FUNCTION private.validate_session_mfa() FROM PUBLIC;

-- Append policy version, preserving history. Seed defaults also use these fields.
WITH old AS (SELECT p.* FROM policy_versions p JOIN company_settings s ON s.security_policy_id=p.id WHERE s.id=1),
 added AS (INSERT INTO policy_versions(policy_key,revision,configuration,created_by)
 SELECT 'SECURITY',(SELECT max(revision)+1 FROM policy_versions WHERE policy_key='SECURITY'),configuration||'{"pinEnabled":false,"adminTotpRequired":true,"dutyTotpRequired":true,"setupMinutes":5,"factorLimit":5,"factorNetworkLimit":30,"recoveryNetworkLimit":5,"sensitiveReauthMinutes":5,"dutyIdleMinutes":30,"dutyMaxHours":12}'::jsonb,created_by FROM old RETURNING id)
 UPDATE company_settings SET security_policy_id=added.id,version=version+1 FROM added WHERE company_settings.id=1;
UPDATE sessions SET revoked_at=clock_timestamp(),revocation_reason='PHASE_2A_ROLLOUT' WHERE revoked_at IS NULL;
COMMIT;
