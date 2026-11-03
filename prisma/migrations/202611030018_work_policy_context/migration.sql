BEGIN;
CREATE FUNCTION private.work_context() RETURNS TABLE(user_id uuid,administrator boolean,display_name text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT u.id,private.is_admin(),CASE WHEN u.role='ADMINISTRATOR' THEN 'Administrator' ELSE p.display_name END FROM public.users u LEFT JOIN public.employee_profiles p ON p.user_id=u.id WHERE u.id=private.work_actor()
$$;
CREATE FUNCTION private.work_policy_check() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.policy_key='WORK' AND NEW.configuration ? 'tasks' AND (jsonb_typeof(NEW.configuration->'tasks')<>'object' OR jsonb_typeof(NEW.configuration->'tasks'->'maxRecipients')<>'number' OR (NEW.configuration->'tasks'->>'maxRecipients')::numeric NOT BETWEEN 1 AND 500 OR trunc((NEW.configuration->'tasks'->>'maxRecipients')::numeric)<>(NEW.configuration->'tasks'->>'maxRecipients')::numeric OR (NEW.configuration->'tasks'-'maxRecipients')<>'{}') THEN RAISE EXCEPTION 'Invalid task policy' USING ERRCODE='22023';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER work_policy_check BEFORE INSERT ON policy_versions FOR EACH ROW EXECUTE FUNCTION private.work_policy_check();
CREATE FUNCTION private.set_task_policy(expected uuid,cap integer,note text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid;p public.policy_versions%ROWTYPE;added uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(72426820::bigint);actor=private.lock_work(true);PERFORM private.work_note(note);
 IF NOT private.admin_recent() OR cap IS NULL OR cap NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Recent MFA and valid capacity required' USING ERRCODE='42501';END IF;
 PERFORM 1 FROM public.company_settings WHERE id=1 FOR UPDATE;
 SELECT v.* INTO p FROM public.company_settings s JOIN public.policy_versions v ON v.id=s.work_policy_id WHERE s.id=1;
 IF p.id IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Policy conflict' USING ERRCODE='40001';END IF;
 INSERT INTO public.policy_versions(policy_key,revision,configuration,created_by) SELECT 'WORK',max(revision)+1,p.configuration||jsonb_build_object('tasks',jsonb_build_object('maxRecipients',cap)),actor FROM public.policy_versions WHERE policy_key='WORK' RETURNING id INTO added;
 UPDATE public.company_settings SET work_policy_id=added,version=version+1,updated_at=private.security_now() WHERE id=1;
 PERFORM private.work_audit('work.task_policy_changed',jsonb_build_object('previous_policy_id',expected,'policy_id',added,'maxRecipients',cap,'reason',note));
END $$;
REVOKE ALL ON FUNCTION private.work_context(),private.work_policy_check(),private.set_task_policy(uuid,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.work_context(),private.set_task_policy(uuid,integer,text) TO libetario_runtime;
COMMIT;
