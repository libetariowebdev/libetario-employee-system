BEGIN;
CREATE OR REPLACE FUNCTION private.admin_reset_mfa(target uuid,token_digest text,note text,reset_reason text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid;verified timestamptz;
BEGIN
 actor=private.actor();
 IF actor IS NULL OR actor=target THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501';END IF;
 PERFORM 1 FROM public.users WHERE id IN (actor,target) ORDER BY id FOR UPDATE;
 IF NOT private.is_admin() THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501';END IF;
 SELECT mfa_verified_at INTO verified FROM private.auth_context();
 IF verified IS NULL OR verified<private.security_now()-make_interval(mins=>coalesce((private.security_policy()->>'sensitiveReauthMinutes')::int,5)) THEN RAISE EXCEPTION 'Recent administrator MFA required' USING ERRCODE='42501';END IF;
 RETURN private.perform_mfa_reset(target,actor,'ADMIN',token_digest,note,reset_reason,NULL);
END $$;
COMMIT;
