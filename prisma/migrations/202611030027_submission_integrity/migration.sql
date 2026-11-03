BEGIN;
ALTER TABLE task_submissions ADD CONSTRAINT submission_employee_owner FOREIGN KEY(assignment_id,created_by) REFERENCES task_assignments(id,employee_id) ON DELETE RESTRICT;
CREATE FUNCTION private.submission_attachment_insert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.task_submissions WHERE id=NEW.submission_id AND state='DRAFT') OR NOT EXISTS(SELECT 1 FROM public.file_objects WHERE id=NEW.file_id AND state='QUARANTINED') THEN RAISE EXCEPTION 'Draft attachments only' USING ERRCODE='22023';END IF;RETURN NEW;
END $$;
CREATE TRIGGER submission_attachment_insert BEFORE INSERT ON submission_files FOR EACH ROW EXECUTE FUNCTION private.submission_attachment_insert();
CREATE FUNCTION private.project_completion() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE target uuid;
BEGIN
 IF TG_TABLE_NAME='projects' THEN target=NEW.id;ELSE target=NEW.project_id;END IF;
 IF EXISTS(SELECT 1 FROM public.projects WHERE id=target AND status='COMPLETED') AND (NOT EXISTS(SELECT 1 FROM public.tasks WHERE project_id=target AND status<>'CANCELLED') OR EXISTS(SELECT 1 FROM public.tasks WHERE project_id=target AND status NOT IN ('APPROVED','CANCELLED'))) THEN RAISE EXCEPTION 'Nonempty approved work required' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER project_completion AFTER INSERT OR UPDATE ON projects DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.project_completion();
CREATE CONSTRAINT TRIGGER task_project_completion AFTER INSERT OR UPDATE ON tasks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.project_completion();
CREATE OR REPLACE FUNCTION private.submit_submission(target uuid,expected integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid;s public.task_submissions%ROWTYPE;a public.task_assignments%ROWTYPE;
BEGIN
 actor=private.lock_work();IF private.is_admin() THEN RAISE EXCEPTION 'Employee submits own work' USING ERRCODE='42501';END IF;
 s=private.lock_submission(target);PERFORM private.assert_submission_open(s);
 SELECT * INTO a FROM public.task_assignments WHERE id=s.assignment_id;
 IF s.state<>'DRAFT' OR expected IS DISTINCT FROM s.version OR a.status NOT IN ('IN_PROGRESS','REVISION_REQUIRED') THEN RAISE EXCEPTION 'Current draft required' USING ERRCODE='40001';END IF;
 PERFORM 1 FROM public.file_objects f JOIN public.submission_files x ON x.file_id=f.id WHERE x.submission_id=target AND x.excluded_at IS NULL ORDER BY f.id FOR UPDATE OF f;
 IF EXISTS(SELECT 1 FROM public.file_objects f JOIN public.submission_files x ON x.file_id=f.id WHERE x.submission_id=target AND x.excluded_at IS NULL AND f.state<>'AVAILABLE') OR (length(btrim(s.notes))=0 AND jsonb_array_length(s.urls)=0 AND NOT EXISTS(SELECT 1 FROM public.submission_files WHERE submission_id=target AND excluded_at IS NULL)) THEN RAISE EXCEPTION 'Complete content and available attachments required' USING ERRCODE='22023';END IF;
 UPDATE public.task_submissions SET state='SUBMITTED',submitted_at=private.security_now(),updated_at=private.security_now(),version=version+1 WHERE id=target;
 UPDATE public.task_assignments SET current_submission_id=target,status='SUBMITTED',status_changed_by=actor,status_changed_at=private.security_now(),updated_at=private.security_now(),version=version+1 WHERE id=a.id;
 PERFORM private.work_audit('assignment.status',jsonb_build_object('task_id',a.task_id,'assignment_id',a.id,'employee_id',actor,'submission_id',target,'from',a.status,'to','SUBMITTED'));
 PERFORM private.refresh_task(a.task_id);
END $$;

REVOKE ALL ON FUNCTION private.submission_attachment_insert(),private.project_completion() FROM PUBLIC;
COMMIT;
