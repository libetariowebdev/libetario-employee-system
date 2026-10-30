BEGIN;
CREATE OR REPLACE FUNCTION private.mutate_duty(employee_ids uuid[],day date,action text,note text,overnight boolean DEFAULT false,until_time timestamptz DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid;who uuid;d public.duty_authorizations%ROWTYPE;previous jsonb;wp uuid;cfg jsonb;start_at timestamptz;end_at timestamptz;midnight_end timestamptz;changed integer=0;carry integer;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(72426820::bigint);
 actor=private.actor();
 IF actor IS NULL OR NOT private.is_admin() THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501';END IF;
 IF employee_ids IS NULL OR action IS NULL OR overnight IS NULL OR cardinality(employee_ids) NOT BETWEEN 1 AND 100 OR array_position(employee_ids,NULL) IS NOT NULL OR cardinality(employee_ids)<>(SELECT count(DISTINCT x) FROM unnest(employee_ids)x) OR action NOT IN ('ACTIVATE','REVOKE','REGRANT') OR length(btrim(note)) NOT BETWEEN 10 AND 500 OR note IS NULL THEN RAISE EXCEPTION 'Invalid duty request' USING ERRCODE='22023';END IF;
 IF day IS NULL OR day<'2000-01-01' OR day>='2100-01-01' THEN RAISE EXCEPTION 'Invalid duty date' USING ERRCODE='22023';END IF;
 PERFORM 1 FROM public.users WHERE id=actor OR id=ANY(employee_ids) ORDER BY id FOR UPDATE;
 IF NOT private.is_admin() THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501';END IF;
 IF (SELECT count(*) FROM public.users u JOIN public.employee_profiles ep ON ep.user_id=u.id WHERE u.id=ANY(employee_ids) AND u.role='EMPLOYEE' AND (action='REVOKE' OR (u.disabled_at IS NULL AND ep.employment_status='ACTIVE')))<>cardinality(employee_ids) THEN RAISE EXCEPTION 'Employee unavailable' USING ERRCODE='22023';END IF;
 SELECT p.id,p.configuration INTO wp,cfg FROM public.company_settings s JOIN public.policy_versions p ON p.id=s.work_policy_id WHERE s.id=1;
 start_at=day::timestamp AT TIME ZONE 'Asia/Manila';midnight_end=(day+1)::timestamp AT TIME ZONE 'Asia/Manila';end_at=coalesce(until_time,midnight_end);
 carry=coalesce((cfg->>'overnightCarryHours')::int,8);

 FOREACH who IN ARRAY (SELECT array_agg(x ORDER BY x) FROM unnest(employee_ids)x) LOOP
  SELECT * INTO d FROM public.duty_authorizations WHERE employee_id=who AND duty_date=day FOR UPDATE;
  previous=to_jsonb(d);
 IF action<>'REVOKE' AND NOT coalesce((action='ACTIVATE' AND d.status='ACTIVATED' AND d.valid_from=start_at AND d.valid_until=end_at AND d.overnight_allowed=overnight),false) AND (end_at<=start_at OR (NOT overnight AND end_at<>midnight_end) OR (overnight AND (NOT coalesce((cfg->>'overnightEnabled')::boolean,false) OR carry NOT BETWEEN 1 AND 8 OR end_at<=midnight_end OR end_at>midnight_end+make_interval(hours=>carry)))) THEN RAISE EXCEPTION 'Duty window violates work policy' USING ERRCODE='22023';END IF;
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
COMMIT;
