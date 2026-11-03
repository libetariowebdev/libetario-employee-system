BEGIN;
-- An open stream cannot revive after membership withdrawal and restoration.
-- Use the PostgreSQL built-in SHA-256; no extension is required.
CREATE OR REPLACE FUNCTION private.file_locator(target uuid) RETURNS TABLE(storage_key text,display_name text,media_type text,size_bytes bigint,sha256 text,authorization_stamp text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid;stamp text;
BEGIN
 actor=private.work_actor();
 IF actor IS NULL THEN RAISE EXCEPTION 'Work access required' USING ERRCODE='42501';END IF;
 IF NOT private.can_file(target) THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
 IF private.is_admin() THEN stamp='ADMINISTRATOR';ELSE
  SELECT encode(sha256(convert_to(coalesce(string_agg(a.id::text||':'||t.membership_version::text,',' ORDER BY a.id),''),'UTF8')),'hex') INTO stamp
  FROM public.task_assignments a JOIN public.tasks t ON t.id=a.task_id
  WHERE a.employee_id=actor AND a.access_revoked_at IS NULL AND (
   EXISTS(SELECT 1 FROM public.project_files p WHERE p.file_id=target AND p.project_id=t.project_id) OR
   EXISTS(SELECT 1 FROM public.task_files x WHERE x.file_id=target AND x.task_id=t.id) OR
   EXISTS(SELECT 1 FROM public.submission_files x JOIN public.task_submissions s ON s.id=x.submission_id WHERE x.file_id=target AND s.assignment_id=a.id));
 END IF;
 RETURN QUERY SELECT f.storage_key,f.display_name,f.detected_media_type,f.size_bytes,f.sha256,stamp FROM public.file_objects f WHERE f.id=target AND f.state='AVAILABLE';
 IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
END $$;
REVOKE ALL ON FUNCTION private.file_locator(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.file_locator(uuid) TO libetario_runtime;
COMMIT;
