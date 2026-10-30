-- Audit attribution must survive the very operation that revokes a session.
CREATE OR REPLACE FUNCTION private.write_audit(action_name text, details jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor_id uuid; sid uuid;
BEGIN
 SELECT s.user_id,s.id INTO actor_id,sid FROM public.sessions s WHERE s.token_hash=current_setting('app.session_hash',true);
 INSERT INTO public.audit_log(actor_user_id,session_id,action,request_id,payload)
 VALUES(actor_id,sid,action_name,coalesce(nullif(current_setting('app.request_id',true),''),gen_random_uuid()::text),details);
END $$;
-- Runtime cannot relabel, delete, or truncate any history.
REVOKE DELETE,TRUNCATE ON ALL TABLES IN SCHEMA public FROM libetario_runtime,libetario_auth;
REVOKE ALL ON FUNCTION private.write_audit(text,jsonb) FROM PUBLIC;
-- Database-enforced schedule duration/break sanity beyond API validation.
ALTER TABLE employee_schedule_days ADD CONSTRAINT schedule_breaks_fit CHECK (
 NOT working_day OR (
 (extract(epoch FROM end_local-start_local)+(CASE WHEN ends_next_day THEN 86400 ELSE 0 END)) BETWEEN 1 AND 86400
 AND paid_break_seconds+unpaid_break_seconds < extract(epoch FROM end_local-start_local)+(CASE WHEN ends_next_day THEN 86400 ELSE 0 END)
 ));
