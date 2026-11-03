BEGIN;
CREATE OR REPLACE FUNCTION private.task_cardinality() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE target uuid;mode text;state text;n integer;
BEGIN
 IF TG_TABLE_NAME='tasks' THEN target=NEW.id;ELSE target=NEW.task_id;END IF;
 SELECT assignment_mode,status INTO mode,state FROM public.tasks WHERE id=target;
 SELECT count(*) INTO n FROM public.task_assignments WHERE task_id=target AND access_revoked_at IS NULL;
 IF (mode='INDIVIDUAL' AND n>1) OR (state<>'CANCELLED' AND n=0) THEN RAISE EXCEPTION 'Invalid final assignment cardinality' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION private.work_audit(action_name text,details jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid;sid uuid;
BEGIN
 SELECT user_id,id INTO actor,sid FROM public.sessions WHERE token_hash=current_setting('app.session_hash',true);
 INSERT INTO public.audit_log(actor_user_id,session_id,action,occurred_at,request_id,payload) VALUES(actor,sid,action_name,private.security_now(),coalesce(nullif(current_setting('app.request_id',true),''),gen_random_uuid()::text),details);
END $$;
COMMIT;
