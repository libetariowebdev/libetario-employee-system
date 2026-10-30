BEGIN;
CREATE TABLE duty_authorizations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), employee_id uuid NOT NULL REFERENCES employee_profiles(user_id) ON DELETE RESTRICT,
 duty_date date NOT NULL, status text NOT NULL CHECK(status IN ('ACTIVATED','REVOKED','COMPLETED')),
 granted_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,granted_at timestamptz NOT NULL DEFAULT private.security_now(),
 revoked_by uuid REFERENCES users(id) ON DELETE RESTRICT,revoked_at timestamptz,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 10 AND 500),
 valid_from timestamptz NOT NULL,valid_until timestamptz NOT NULL,overnight_allowed boolean NOT NULL DEFAULT false,
 work_policy_id uuid NOT NULL REFERENCES policy_versions(id) ON DELETE RESTRICT,
 authorization_version integer NOT NULL DEFAULT 1 CHECK(authorization_version>0),
 first_authenticated_at timestamptz,first_auth_version integer,
 created_at timestamptz NOT NULL DEFAULT private.security_now(),updated_at timestamptz NOT NULL DEFAULT private.security_now(),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 UNIQUE(employee_id,duty_date),UNIQUE(id,employee_id),
 CHECK(valid_from=(duty_date::timestamp AT TIME ZONE 'Asia/Manila') AND valid_until>valid_from),
 CHECK((status='REVOKED' AND revoked_at IS NOT NULL AND revoked_by IS NOT NULL) OR (status<>'REVOKED' AND revoked_at IS NULL AND revoked_by IS NULL)),
 CHECK((first_authenticated_at IS NULL AND first_auth_version IS NULL) OR (first_authenticated_at IS NOT NULL AND first_auth_version=authorization_version AND (first_authenticated_at AT TIME ZONE 'Asia/Manila')::date=duty_date))
);
CREATE INDEX ON duty_authorizations(granted_by);CREATE INDEX ON duty_authorizations(revoked_by);CREATE INDEX ON duty_authorizations(work_policy_id);CREATE INDEX ON duty_authorizations(duty_date,status);
ALTER TABLE sessions DROP CONSTRAINT sessions_scope_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_scope_check CHECK(scope IN ('ACCOUNT','SETUP','DUTY'));
ALTER TABLE sessions DROP CONSTRAINT sessions_scope_purpose_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_scope_purpose_check CHECK((scope='SETUP' AND setup_purpose IS NOT NULL AND mfa_verified_at IS NULL) OR (scope IN ('ACCOUNT','DUTY') AND setup_purpose IS NULL));
ALTER TABLE sessions ADD COLUMN duty_id uuid,ADD COLUMN duty_authorization_version integer,ADD COLUMN mfa_generation integer,ADD COLUMN pin_version integer;
ALTER TABLE sessions ADD CONSTRAINT session_duty_owner FOREIGN KEY(duty_id,user_id) REFERENCES duty_authorizations(id,employee_id) ON DELETE RESTRICT;
ALTER TABLE sessions ADD CONSTRAINT session_duty_claims CHECK((scope='DUTY' AND duty_id IS NOT NULL AND duty_authorization_version IS NOT NULL AND duty_authorization_version>0 AND mfa_enrollment_id IS NOT NULL AND mfa_generation IS NOT NULL AND mfa_generation>0 AND mfa_verified_at IS NOT NULL AND security_policy_id IS NOT NULL) OR (scope<>'DUTY' AND duty_id IS NULL AND duty_authorization_version IS NULL AND mfa_generation IS NULL AND pin_version IS NULL));
CREATE INDEX ON sessions(duty_id);
CREATE TABLE auth_challenges (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,bound_session_id uuid NOT NULL,
 challenge_token_hash text NOT NULL UNIQUE CHECK(length(challenge_token_hash)=64),
 purpose text NOT NULL CHECK(purpose IN ('DUTY_LOGIN','DUTY_REAUTH')),stage text NOT NULL CHECK(stage IN ('PIN','TOTP')),
 requested_scope text NOT NULL DEFAULT 'DUTY' CHECK(requested_scope='DUTY'),duty_id uuid NOT NULL,duty_authorization_version integer NOT NULL CHECK(duty_authorization_version>0),
 enrollment_id uuid NOT NULL,enrollment_generation integer NOT NULL CHECK(enrollment_generation>0),pin_version integer,
 security_policy_id uuid NOT NULL REFERENCES policy_versions(id) ON DELETE RESTRICT,user_authorization_version integer NOT NULL,
 password_verified_at timestamptz NOT NULL,pin_verified_at timestamptz,created_at timestamptz NOT NULL DEFAULT private.security_now(),expires_at timestamptz NOT NULL,
 consumed_at timestamptz,invalidated_at timestamptz,failed_attempts integer NOT NULL DEFAULT 0 CHECK(failed_attempts>=0),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 FOREIGN KEY(bound_session_id,user_id) REFERENCES sessions(id,user_id) ON DELETE RESTRICT,
 FOREIGN KEY(duty_id,user_id) REFERENCES duty_authorizations(id,employee_id) ON DELETE RESTRICT,
 FOREIGN KEY(enrollment_id,user_id) REFERENCES mfa_enrollments(id,user_id) ON DELETE RESTRICT,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '5 minutes'),CHECK(pin_version IS NULL OR pin_version>0)
);
CREATE INDEX ON auth_challenges(user_id);CREATE INDEX ON auth_challenges(bound_session_id);CREATE INDEX ON auth_challenges(duty_id);CREATE INDEX ON auth_challenges(enrollment_id);CREATE INDEX ON auth_challenges(security_policy_id);
ALTER TABLE duty_authorizations ENABLE ROW LEVEL SECURITY;ALTER TABLE auth_challenges ENABLE ROW LEVEL SECURITY;
CREATE POLICY duty_metadata ON duty_authorizations FOR SELECT TO libetario_runtime USING(private.can_read(employee_id));
GRANT SELECT ON duty_authorizations TO libetario_runtime;
CREATE POLICY duty_auth_read ON duty_authorizations FOR SELECT TO libetario_auth USING(true);
GRANT SELECT ON duty_authorizations TO libetario_auth;
CREATE POLICY challenges_auth ON auth_challenges TO libetario_auth USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE ON auth_challenges TO libetario_auth;
REVOKE ALL ON auth_challenges FROM libetario_runtime;

-- ACCOUNT/SETUP helpers never accept a DUTY cookie as an ordinary account.
CREATE OR REPLACE FUNCTION private.auth_context() RETURNS TABLE(user_id uuid,role "Role",must_change_password boolean,session_id uuid,scope text,setup_purpose text,mfa_enrollment_id uuid,mfa_verified_at timestamptz,password_verified_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT u.id,u.role,u.must_change_password,s.id,s.scope,s.setup_purpose,s.mfa_enrollment_id,s.mfa_verified_at,s.password_verified_at
 FROM public.sessions s JOIN public.users u ON u.id=s.user_id
 WHERE s.scope IN ('ACCOUNT','SETUP') AND s.token_hash=current_setting('app.session_hash',true) AND s.revoked_at IS NULL AND u.disabled_at IS NULL AND s.authorization_version=u.authorization_version
 AND s.idle_expires_at>private.security_now() AND s.absolute_expires_at>private.security_now()
 AND (s.scope='SETUP' OR u.role='EMPLOYEE' OR (s.mfa_verified_at IS NOT NULL AND EXISTS(SELECT 1 FROM public.mfa_enrollments e WHERE e.id=s.mfa_enrollment_id AND e.user_id=u.id AND e.state='CONFIRMED')))
$$;

CREATE FUNCTION private.duty_context() RETURNS TABLE(user_id uuid,session_id uuid,duty_id uuid,duty_date date,authorization_version integer,valid_until timestamptz,idle_expires_at timestamptz,absolute_expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT u.id,s.id,d.id,d.duty_date,d.authorization_version,d.valid_until,s.idle_expires_at,s.absolute_expires_at
 FROM public.sessions s JOIN public.users u ON u.id=s.user_id JOIN public.duty_authorizations d ON d.id=s.duty_id AND d.employee_id=u.id
 JOIN public.mfa_enrollments e ON e.id=s.mfa_enrollment_id AND e.user_id=u.id
 JOIN public.company_settings cs ON cs.id=1 JOIN public.policy_versions p ON p.id=cs.security_policy_id
 LEFT JOIN public.employee_pins pin ON pin.user_id=u.id
 WHERE s.token_hash=current_setting('app.session_hash',true) AND s.scope='DUTY' AND s.revoked_at IS NULL
 AND u.role='EMPLOYEE' AND u.disabled_at IS NULL AND NOT u.must_change_password AND u.authorization_version=s.authorization_version
 AND d.status='ACTIVATED' AND d.authorization_version=s.duty_authorization_version AND d.first_auth_version=d.authorization_version
 AND private.security_now()>=d.valid_from AND private.security_now()<d.valid_until
 AND (private.security_now() AT TIME ZONE 'Asia/Manila')::date>=d.duty_date
 AND s.idle_expires_at>private.security_now() AND s.absolute_expires_at>private.security_now()
 AND e.state='CONFIRMED' AND e.generation=s.mfa_generation AND s.mfa_verified_at IS NOT NULL AND s.security_policy_id=cs.security_policy_id
 AND (NOT coalesce((p.configuration->>'pinEnabled')::boolean,false) OR (pin.version=s.pin_version AND s.pin_version IS NOT NULL))
$$;
REVOKE ALL ON FUNCTION private.duty_context() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.duty_context() TO libetario_runtime,libetario_auth;

-- Shared policy lock precedes users -> sessions -> grants -> enrollments -> challenges.
-- All company-setting updates serialize against final duty issuance, including direct SQL.
CREATE FUNCTION private.lock_policy_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN PERFORM pg_advisory_xact_lock(72426820::bigint);RETURN NULL;END $$;
CREATE TRIGGER lock_policy_change BEFORE UPDATE ON company_settings FOR EACH STATEMENT EXECUTE FUNCTION private.lock_policy_change();
REVOKE ALL ON FUNCTION private.lock_policy_change() FROM PUBLIC;
CREATE OR REPLACE FUNCTION private.revoke_setup_on_policy_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.security_policy_id IS DISTINCT FROM OLD.security_policy_id THEN
  UPDATE public.sessions SET revoked_at=private.security_now(),revocation_reason='SECURITY_POLICY_CHANGED' WHERE scope IN ('SETUP','DUTY') AND revoked_at IS NULL;
  UPDATE public.auth_challenges SET invalidated_at=private.security_now() WHERE consumed_at IS NULL AND invalidated_at IS NULL;
 END IF;RETURN NEW;
END $$;

CREATE FUNCTION private.invalidate_duty_credentials() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE target uuid;
BEGIN
 IF TG_TABLE_NAME='employee_pins' THEN target=NEW.user_id;
 ELSIF TG_TABLE_NAME='users' THEN
  IF NEW.authorization_version=OLD.authorization_version AND NEW.disabled_at IS NOT DISTINCT FROM OLD.disabled_at THEN RETURN NEW;END IF;target=NEW.id;
 ELSE
  IF NEW.state='CONFIRMED' THEN RETURN NEW;END IF;target=NEW.user_id;
 END IF;
 UPDATE public.sessions SET revoked_at=private.security_now(),revocation_reason='DUTY_CREDENTIAL_CHANGED' WHERE user_id=target AND scope='DUTY' AND revoked_at IS NULL;
 UPDATE public.auth_challenges SET invalidated_at=private.security_now() WHERE user_id=target AND consumed_at IS NULL AND invalidated_at IS NULL;
 RETURN NEW;
END $$;
CREATE TRIGGER pin_duty_invalidation AFTER UPDATE ON employee_pins FOR EACH ROW EXECUTE FUNCTION private.invalidate_duty_credentials();
CREATE TRIGGER user_duty_invalidation AFTER UPDATE OF authorization_version,disabled_at ON users FOR EACH ROW EXECUTE FUNCTION private.invalidate_duty_credentials();
CREATE TRIGGER mfa_duty_invalidation AFTER UPDATE OF state ON mfa_enrollments FOR EACH ROW EXECUTE FUNCTION private.invalidate_duty_credentials();
REVOKE ALL ON FUNCTION private.invalidate_duty_credentials() FROM PUBLIC;
CREATE FUNCTION private.invalidate_bound_challenges() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.revoked_at IS NOT NULL AND NEW.revocation_reason IS DISTINCT FROM 'EXPIRED' THEN
  UPDATE public.auth_challenges SET invalidated_at=private.security_now() WHERE bound_session_id=NEW.id AND consumed_at IS NULL AND invalidated_at IS NULL;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER bound_challenge_invalidation AFTER UPDATE OF revoked_at ON sessions FOR EACH ROW EXECUTE FUNCTION private.invalidate_bound_challenges();
REVOKE ALL ON FUNCTION private.invalidate_bound_challenges() FROM PUBLIC;

CREATE FUNCTION private.mutate_duty(employee_ids uuid[],day date,action text,note text,overnight boolean DEFAULT false,until_time timestamptz DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid;who uuid;d public.duty_authorizations%ROWTYPE;previous jsonb;wp uuid;cfg jsonb;start_at timestamptz;end_at timestamptz;midnight_end timestamptz;changed integer=0;carry integer;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(72426820::bigint);
 actor=private.actor();
 IF actor IS NULL OR NOT private.is_admin() THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501';END IF;
 IF cardinality(employee_ids) NOT BETWEEN 1 AND 100 OR array_position(employee_ids,NULL) IS NOT NULL OR cardinality(employee_ids)<>(SELECT count(DISTINCT x) FROM unnest(employee_ids)x) OR action NOT IN ('ACTIVATE','REVOKE','REGRANT') OR length(btrim(note)) NOT BETWEEN 10 AND 500 OR note IS NULL THEN RAISE EXCEPTION 'Invalid duty request' USING ERRCODE='22023';END IF;
 IF day IS NULL OR day<'2000-01-01' OR day>='2100-01-01' THEN RAISE EXCEPTION 'Invalid duty date' USING ERRCODE='22023';END IF;
 PERFORM 1 FROM public.users WHERE id=actor OR id=ANY(employee_ids) ORDER BY id FOR UPDATE;
 IF NOT private.is_admin() THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501';END IF;
 IF (SELECT count(*) FROM public.users u JOIN public.employee_profiles ep ON ep.user_id=u.id WHERE u.id=ANY(employee_ids) AND u.role='EMPLOYEE' AND u.disabled_at IS NULL)<>cardinality(employee_ids) THEN RAISE EXCEPTION 'Employee unavailable' USING ERRCODE='22023';END IF;
 SELECT p.id,p.configuration INTO wp,cfg FROM public.company_settings s JOIN public.policy_versions p ON p.id=s.work_policy_id WHERE s.id=1;
 start_at=day::timestamp AT TIME ZONE 'Asia/Manila';midnight_end=(day+1)::timestamp AT TIME ZONE 'Asia/Manila';end_at=coalesce(until_time,midnight_end);
 carry=coalesce((cfg->>'overnightCarryHours')::int,8);
 IF action<>'REVOKE' AND (end_at<=start_at OR (NOT overnight AND end_at<>midnight_end) OR (overnight AND (NOT coalesce((cfg->>'overnightEnabled')::boolean,false) OR carry NOT BETWEEN 1 AND 8 OR end_at<=midnight_end OR end_at>midnight_end+make_interval(hours=>carry)))) THEN RAISE EXCEPTION 'Duty window violates work policy' USING ERRCODE='22023';END IF;
 FOREACH who IN ARRAY (SELECT array_agg(x ORDER BY x) FROM unnest(employee_ids)x) LOOP
  SELECT * INTO d FROM public.duty_authorizations WHERE employee_id=who AND duty_date=day FOR UPDATE;
  previous=to_jsonb(d);
  IF action='ACTIVATE' THEN
   IF d.id IS NOT NULL THEN
    IF d.status='ACTIVATED' AND d.valid_from=start_at AND d.valid_until=end_at AND d.overnight_allowed=overnight THEN CONTINUE;END IF;
    RAISE EXCEPTION 'Existing grant requires explicit revoke/regrant' USING ERRCODE='22023';
   END IF;
   INSERT INTO public.duty_authorizations(employee_id,duty_date,status,granted_by,reason,valid_from,valid_until,overnight_allowed,work_policy_id) VALUES(who,day,'ACTIVATED',actor,note,start_at,end_at,overnight,wp) RETURNING * INTO d;
  ELSE
   IF d.id IS NULL THEN RAISE EXCEPTION 'Duty grant not found' USING ERRCODE='22023';END IF;
   IF action='REVOKE' AND d.status='REVOKED' THEN CONTINUE;END IF;
   IF action='REGRANT' AND d.status<>'REVOKED' THEN RAISE EXCEPTION 'Only revoked grants can be regranted' USING ERRCODE='22023';END IF;
   UPDATE public.sessions SET revoked_at=private.security_now(),revocation_reason='DUTY_'||action WHERE duty_id=d.id AND revoked_at IS NULL;
   UPDATE public.auth_challenges SET invalidated_at=private.security_now() WHERE duty_id=d.id AND consumed_at IS NULL AND invalidated_at IS NULL;
   UPDATE public.duty_authorizations SET status=CASE WHEN action='REVOKE' THEN 'REVOKED' ELSE 'ACTIVATED' END,
    authorization_version=authorization_version+1,version=version+1,reason=note,updated_at=private.security_now(),
    revoked_at=CASE WHEN action='REVOKE' THEN private.security_now() END,revoked_by=CASE WHEN action='REVOKE' THEN actor END,
    granted_by=CASE WHEN action='REGRANT' THEN actor ELSE granted_by END,granted_at=CASE WHEN action='REGRANT' THEN private.security_now() ELSE granted_at END,
    valid_from=CASE WHEN action='REGRANT' THEN start_at ELSE valid_from END,valid_until=CASE WHEN action='REGRANT' THEN end_at ELSE valid_until END,
    overnight_allowed=CASE WHEN action='REGRANT' THEN overnight ELSE overnight_allowed END,work_policy_id=CASE WHEN action='REGRANT' THEN wp ELSE work_policy_id END,
    first_authenticated_at=NULL,first_auth_version=NULL WHERE id=d.id RETURNING * INTO d;
  END IF;
  PERFORM private.write_audit('duty.'||lower(action),jsonb_build_object('duty_id',d.id,'employee_id',who,'duty_date',day,'authorization_version',d.authorization_version,'reason',note,'previous',previous,'current',to_jsonb(d)));
  INSERT INTO public.auth_events(user_id,event_type,outcome,occurred_at,metadata) VALUES(who,'DUTY_'||action,'SUCCESS',private.security_now(),jsonb_build_object('duty_id',d.id,'duty_date',day,'actor_id',actor));
  changed=changed+1;
 END LOOP;RETURN changed;
END $$;
REVOKE ALL ON FUNCTION private.mutate_duty(uuid[],date,text,text,boolean,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.mutate_duty(uuid[],date,text,text,boolean,timestamptz) TO libetario_runtime;

-- Auth authority may mark the first security authentication, never change grants.
CREATE FUNCTION private.mark_duty_authenticated(target uuid,employee uuid,expected integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 UPDATE public.duty_authorizations SET first_authenticated_at=coalesce(first_authenticated_at,private.security_now()),first_auth_version=authorization_version,updated_at=private.security_now()
 WHERE id=target AND employee_id=employee AND status='ACTIVATED' AND authorization_version=expected
 AND private.security_now()>=valid_from AND private.security_now()<valid_until
 AND ((private.security_now() AT TIME ZONE 'Asia/Manila')::date=duty_date OR first_auth_version=authorization_version);
 IF NOT FOUND THEN RAISE EXCEPTION 'Duty unavailable' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION private.mark_duty_authenticated(uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.mark_duty_authenticated(uuid,uuid,integer) TO libetario_auth;
CREATE FUNCTION private.lock_duty(target uuid,employee uuid) RETURNS SETOF public.duty_authorizations LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT * FROM public.duty_authorizations WHERE id=target AND employee_id=employee FOR UPDATE
$$;
REVOKE ALL ON FUNCTION private.lock_duty(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.lock_duty(uuid,uuid) TO libetario_auth;

CREATE FUNCTION private.validate_duty_session() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.scope='DUTY' AND NOT EXISTS(
  SELECT 1 FROM public.users u JOIN public.duty_authorizations d ON d.employee_id=u.id JOIN public.mfa_enrollments e ON e.user_id=u.id
  JOIN public.company_settings cs ON cs.id=1 JOIN public.policy_versions p ON p.id=cs.security_policy_id LEFT JOIN public.employee_pins pin ON pin.user_id=u.id
  WHERE u.id=NEW.user_id AND u.role='EMPLOYEE' AND u.disabled_at IS NULL AND NOT u.must_change_password AND u.authorization_version=NEW.authorization_version
  AND d.id=NEW.duty_id AND d.status='ACTIVATED' AND d.authorization_version=NEW.duty_authorization_version AND d.first_auth_version=d.authorization_version
  AND private.security_now()>=d.valid_from AND private.security_now()<d.valid_until
  AND e.id=NEW.mfa_enrollment_id AND e.state='CONFIRMED' AND e.generation=NEW.mfa_generation AND cs.security_policy_id=NEW.security_policy_id
  AND NEW.absolute_expires_at<=least(d.valid_until,NEW.created_at+make_interval(hours=>coalesce((p.configuration->>'dutyMaxHours')::int,12)))
  AND (NOT coalesce((p.configuration->>'pinEnabled')::boolean,false) OR (pin.version=NEW.pin_version AND NEW.pin_version IS NOT NULL))
 ) THEN RAISE EXCEPTION 'Invalid duty claims' USING ERRCODE='42501';END IF;RETURN NEW;
END $$;
CREATE TRIGGER validate_duty_session BEFORE INSERT OR UPDATE OF scope,duty_id,duty_authorization_version,mfa_enrollment_id,mfa_generation,pin_version,security_policy_id ON sessions FOR EACH ROW EXECUTE FUNCTION private.validate_duty_session();
REVOKE ALL ON FUNCTION private.validate_duty_session() FROM PUBLIC;
CREATE FUNCTION private.touch_duty() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE target uuid;minutes integer;
BEGIN
 SELECT session_id INTO target FROM private.duty_context();
 IF target IS NOT NULL THEN
  minutes=coalesce((private.security_policy()->>'dutyIdleMinutes')::int,30);
  UPDATE public.sessions SET last_seen_at=private.security_now(),idle_expires_at=least(absolute_expires_at,private.security_now()+make_interval(mins=>minutes)) WHERE id=target AND revoked_at IS NULL AND idle_expires_at>private.security_now() AND absolute_expires_at>private.security_now();
 END IF;
END $$;
REVOKE ALL ON FUNCTION private.touch_duty() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.touch_duty() TO libetario_runtime;
COMMIT;
