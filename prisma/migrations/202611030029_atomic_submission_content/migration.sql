BEGIN;
CREATE FUNCTION private.submit_submission_content(target uuid,expected integer,content jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid;s public.task_submissions%ROWTYPE;
BEGIN
 actor=private.lock_work();IF private.is_admin() THEN RAISE EXCEPTION 'Own employee draft required' USING ERRCODE='42501';END IF;
 s=private.lock_submission(target);PERFORM private.assert_submission_open(s);
 IF s.state<>'DRAFT' OR expected IS DISTINCT FROM s.version THEN RAISE EXCEPTION 'Draft changed or frozen' USING ERRCODE='40001';END IF;
 IF content IS NOT NULL THEN
  UPDATE public.task_submissions SET notes=coalesce(content->>'notes',''),urls=coalesce(content->'urls','[]'),updated_at=private.security_now(),version=version+1 WHERE id=target;
  PERFORM private.submit_submission(target,expected+1);
 ELSE PERFORM private.submit_submission(target,expected);END IF;
END $$;
REVOKE ALL ON FUNCTION private.submit_submission_content(uuid,integer,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.submit_submission_content(uuid,integer,jsonb) TO libetario_runtime;
COMMIT;
