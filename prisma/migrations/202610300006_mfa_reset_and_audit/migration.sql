BEGIN;
CREATE FUNCTION private.security_metadata_audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE details jsonb;
BEGIN
 IF TG_TABLE_NAME='mfa_enrollments' THEN
  details=jsonb_build_object('id',NEW.id,'user_id',NEW.user_id,'generation',NEW.generation,'state',NEW.state,'key_id',NEW.encryption_key_id);
 ELSIF TG_TABLE_NAME='employee_pins' THEN details=jsonb_build_object('user_id',NEW.user_id,'version',NEW.version);
 ELSE details=jsonb_build_object('id',NEW.id,'enrollment_id',NEW.enrollment_id,'consumed',NEW.consumed_at IS NOT NULL,'revoked',NEW.revoked_at IS NOT NULL);
 END IF;
 PERFORM private.write_audit(TG_TABLE_NAME||'.'||lower(TG_OP),details);RETURN NEW;
END $$;
CREATE TRIGGER mfa_metadata_audit AFTER INSERT OR UPDATE ON mfa_enrollments FOR EACH ROW EXECUTE FUNCTION private.security_metadata_audit();
CREATE TRIGGER pin_metadata_audit AFTER INSERT OR UPDATE ON employee_pins FOR EACH ROW EXECUTE FUNCTION private.security_metadata_audit();
CREATE TRIGGER codes_metadata_audit AFTER INSERT OR UPDATE ON recovery_codes FOR EACH ROW EXECUTE FUNCTION private.security_metadata_audit();
REVOKE ALL ON FUNCTION private.security_metadata_audit() FROM PUBLIC;

CREATE FUNCTION private.perform_mfa_reset(target uuid,actor uuid,source text,token_digest text,note text,reset_reason text,operator_name text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE enrollment uuid;reset_record uuid;
BEGIN
 IF length(token_digest)<>64 OR length(btrim(note)) NOT BETWEEN 10 AND 500 OR length(btrim(reset_reason)) NOT BETWEEN 10 AND 500 THEN RAISE EXCEPTION 'Invalid reset request';END IF;
 PERFORM 1 FROM public.users WHERE id=target AND disabled_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Account unavailable';END IF;
 SELECT id INTO enrollment FROM public.mfa_enrollments WHERE user_id=target ORDER BY generation DESC LIMIT 1 FOR UPDATE;
 IF enrollment IS NULL THEN RAISE EXCEPTION 'No authenticator enrollment found';END IF;
 UPDATE public.credential_resets SET consumed_at=private.security_now() WHERE user_id=target AND consumed_at IS NULL;
 INSERT INTO public.credential_resets(user_id,requested_by,kind,verification_note,reason,request_source,operator_reference,target_enrollment_id,token_hash,expires_at)
 VALUES(target,actor,'AUTHENTICATOR',note,reset_reason,source,operator_name,enrollment,token_digest,private.security_now()+make_interval(mins=>coalesce((private.security_policy()->>'resetMinutes')::int,15))) RETURNING id INTO reset_record;
 UPDATE public.mfa_enrollments SET state='REVOKED',revoked_at=private.security_now(),ciphertext=NULL,nonce=NULL,tag=NULL,encryption_key_id=NULL,version=version+1,updated_at=private.security_now() WHERE user_id=target AND state IN ('PENDING','CONFIRMED');
 UPDATE public.recovery_codes SET revoked_at=private.security_now() WHERE enrollment_id IN (SELECT id FROM public.mfa_enrollments WHERE user_id=target) AND revoked_at IS NULL;
 UPDATE public.users SET authorization_version=authorization_version+1,updated_at=private.security_now(),version=version+1 WHERE id=target;
 UPDATE public.sessions SET revoked_at=private.security_now(),revocation_reason='AUTHENTICATOR_RESET' WHERE user_id=target AND revoked_at IS NULL;
 PERFORM private.write_audit('mfa.reset_issued',jsonb_build_object('target_user_id',target,'source',source,'operator',operator_name,'verification_note',note,'reason',reset_reason,'reset_id',reset_record));
 INSERT INTO public.auth_events(user_id,event_type,outcome,metadata) VALUES(target,'MFA_RESET','ISSUED',jsonb_build_object('source',source,'actor_id',actor));
 RETURN reset_record;
END $$;
REVOKE ALL ON FUNCTION private.perform_mfa_reset(uuid,uuid,text,text,text,text,text) FROM PUBLIC;

CREATE FUNCTION private.admin_reset_mfa(target uuid,token_digest text,note text,reset_reason text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid;verified timestamptz;
BEGIN
 IF NOT private.is_admin() THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501';END IF;
 SELECT user_id,mfa_verified_at INTO actor,verified FROM private.auth_context();
 IF actor=target OR verified IS NULL OR verified<private.security_now()-make_interval(mins=>coalesce((private.security_policy()->>'sensitiveReauthMinutes')::int,5)) THEN RAISE EXCEPTION 'Recent administrator MFA required' USING ERRCODE='42501';END IF;
 RETURN private.perform_mfa_reset(target,actor,'ADMIN',token_digest,note,reset_reason,NULL);
END $$;
REVOKE ALL ON FUNCTION private.admin_reset_mfa(uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.admin_reset_mfa(uuid,text,text,text) TO libetario_runtime;

CREATE FUNCTION private.validate_security_invariants() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.policy_key='SECURITY' AND NOT (NEW.configuration @> '{"adminTotpRequired":true,"dutyTotpRequired":true}'::jsonb) THEN RAISE EXCEPTION 'Mandatory MFA cannot be disabled';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER security_invariants BEFORE INSERT ON policy_versions FOR EACH ROW EXECUTE FUNCTION private.validate_security_invariants();
REVOKE ALL ON FUNCTION private.validate_security_invariants() FROM PUBLIC;
COMMIT;
