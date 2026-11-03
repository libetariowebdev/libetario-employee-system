BEGIN;
ALTER TABLE tasks DROP CONSTRAINT task_3a_review_gate;
ALTER TABLE task_assignments DROP CONSTRAINT assignment_3a_review_gate;
ALTER TABLE task_assignments DROP CONSTRAINT task_assignments_check1;
ALTER TABLE task_assignments ADD CONSTRAINT withdrawn_progress CHECK(access_revoked_at IS NULL OR status IN ('CANCELLED','APPROVED'));
CREATE FUNCTION private.aggregate_task(target uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT CASE WHEN count(*)=0 THEN 'CANCELLED' WHEN bool_and(status='APPROVED') THEN 'APPROVED'
 WHEN bool_or(status='REVISION_REQUIRED') THEN 'REVISION_REQUIRED' WHEN bool_or(status='SUBMITTED') THEN 'SUBMITTED'
 WHEN bool_or(status IN ('IN_PROGRESS','APPROVED')) THEN 'IN_PROGRESS' ELSE 'PENDING' END FROM public.task_assignments WHERE task_id=target AND counts_for_completion
$$;
CREATE OR REPLACE FUNCTION private.refresh_task(target uuid,note text DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE oldrow public.tasks%ROWTYPE;next_state text;actor uuid=private.work_actor();
BEGIN
 SELECT * INTO oldrow FROM public.tasks WHERE id=target FOR UPDATE;
 next_state=CASE WHEN oldrow.status='CANCELLED' THEN 'CANCELLED' ELSE private.aggregate_task(target) END;
 UPDATE public.tasks SET status=next_state,status_changed_by=CASE WHEN status<>next_state THEN actor ELSE status_changed_by END,status_changed_at=CASE WHEN status<>next_state THEN private.security_now() ELSE status_changed_at END,updated_at=private.security_now(),version=version+1 WHERE id=target;
 IF oldrow.status<>next_state THEN PERFORM private.work_audit('task.status',jsonb_build_object('task_id',target,'from',oldrow.status,'to',next_state,'reason',note,'version',oldrow.version+1));END IF;
END $$;
CREATE OR REPLACE FUNCTION private.work_invariants() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_TABLE_NAME='projects' THEN
  IF NEW.status='COMPLETED' AND (NOT EXISTS(SELECT 1 FROM public.tasks WHERE project_id=NEW.id AND status<>'CANCELLED') OR EXISTS(SELECT 1 FROM public.tasks WHERE project_id=NEW.id AND status NOT IN ('APPROVED','CANCELLED'))) THEN RAISE EXCEPTION 'All nonempty work must be approved' USING ERRCODE='22023';END IF;
  IF TG_OP='UPDATE' AND (NEW.id,NEW.created_by,NEW.creation_key,NEW.creation_fingerprint,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.created_by,OLD.creation_key,OLD.creation_fingerprint,OLD.created_at) THEN RAISE EXCEPTION 'Immutable identity' USING ERRCODE='22023';END IF;
 ELSIF TG_TABLE_NAME='tasks' THEN
  IF TG_OP='UPDATE' THEN
   IF (NEW.id,NEW.project_id,NEW.assignment_mode,NEW.collaboration_mode,NEW.created_by,NEW.creation_key,NEW.creation_fingerprint,NEW.created_at,NEW.recipient_snapshot_at,NEW.task_number) IS DISTINCT FROM (OLD.id,OLD.project_id,OLD.assignment_mode,OLD.collaboration_mode,OLD.created_by,OLD.creation_key,OLD.creation_fingerprint,OLD.created_at,OLD.recipient_snapshot_at,OLD.task_number) THEN RAISE EXCEPTION 'Immutable task shape' USING ERRCODE='22023';END IF;
   IF OLD.status='APPROVED' AND (NEW.status,NEW.title,NEW.instructions,NEW.reference_links,NEW.due_at,NEW.priority) IS DISTINCT FROM (OLD.status,OLD.title,OLD.instructions,OLD.reference_links,OLD.due_at,OLD.priority) THEN RAISE EXCEPTION 'Approved task is terminal' USING ERRCODE='22023';END IF;
  END IF;
 ELSE
  IF TG_OP='INSERT' AND NEW.status<>'PENDING' THEN RAISE EXCEPTION 'Initial progress required' USING ERRCODE='22023';END IF;
  IF TG_OP='UPDATE' THEN
   IF (NEW.id,NEW.task_id,NEW.employee_id,NEW.assigned_by,NEW.assigned_at,NEW.assignment_origin,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.task_id,OLD.employee_id,OLD.assigned_by,OLD.assigned_at,OLD.assignment_origin,OLD.created_at) THEN RAISE EXCEPTION 'Immutable contribution identity' USING ERRCODE='22023';END IF;
   IF OLD.status='APPROVED' AND (NEW.status,NEW.current_submission_id,NEW.counts_for_completion) IS DISTINCT FROM (OLD.status,OLD.current_submission_id,OLD.counts_for_completion) THEN RAISE EXCEPTION 'Approved contribution is terminal' USING ERRCODE='22023';END IF;
   IF NEW.status<>OLD.status AND NOT ((OLD.status IN ('PENDING','REVISION_REQUIRED') AND NEW.status='IN_PROGRESS') OR (OLD.status IN ('PENDING','IN_PROGRESS','SUBMITTED','REVISION_REQUIRED') AND NEW.status='CANCELLED') OR (OLD.status='CANCELLED' AND NEW.status='PENDING') OR (OLD.status IN ('IN_PROGRESS','REVISION_REQUIRED') AND NEW.status='SUBMITTED') OR (OLD.status='SUBMITTED' AND NEW.status IN ('APPROVED','REVISION_REQUIRED'))) THEN RAISE EXCEPTION 'Invalid progress transition' USING ERRCODE='22023';END IF;
  END IF;
 END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION private.task_cardinality() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE target uuid;mode text;state text;n integer;
BEGIN
 IF TG_TABLE_NAME='tasks' THEN target=NEW.id;ELSE target=NEW.task_id;END IF;
 SELECT assignment_mode,status INTO mode,state FROM public.tasks WHERE id=target;
 SELECT count(*) INTO n FROM public.task_assignments WHERE task_id=target AND access_revoked_at IS NULL;
 IF (mode='INDIVIDUAL' AND n>1) OR (state NOT IN ('CANCELLED','APPROVED') AND n=0) OR (state<>'CANCELLED' AND state<>private.aggregate_task(target)) THEN RAISE EXCEPTION 'Invalid final task/contribution aggregate' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE FUNCTION private.submission_integrity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Retain submission history' USING ERRCODE='42501';END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.state<>'DRAFT' OR (NEW.id,NEW.assignment_id,NEW.revision_number,NEW.created_by,NEW.created_at,NEW.creation_key,NEW.creation_fingerprint) IS DISTINCT FROM (OLD.id,OLD.assignment_id,OLD.revision_number,OLD.created_by,OLD.created_at,OLD.creation_key,OLD.creation_fingerprint) THEN RAISE EXCEPTION 'Immutable submission history' USING ERRCODE='22023';END IF;
 END IF;
 IF session_user='libetario_runtime' AND (private.work_actor() IS NULL OR (NEW.state<>'ABANDONED' AND (private.is_admin() OR NEW.created_by<>private.work_actor()))) THEN RAISE EXCEPTION 'Own duty contribution required' USING ERRCODE='42501';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER submission_integrity BEFORE INSERT OR UPDATE OR DELETE ON task_submissions FOR EACH ROW EXECUTE FUNCTION private.submission_integrity();
CREATE TRIGGER protect_submission_truncate BEFORE TRUNCATE ON task_submissions FOR EACH STATEMENT EXECUTE FUNCTION private.immutable();
CREATE FUNCTION private.contribution_proof() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.task_assignments%ROWTYPE;s public.task_submissions%ROWTYPE;r public.task_reviews%ROWTYPE;
BEGIN
 SELECT * INTO a FROM public.task_assignments WHERE id=NEW.id;
 IF a.status IN ('SUBMITTED','REVISION_REQUIRED','APPROVED') THEN
  SELECT * INTO s FROM public.task_submissions WHERE id=a.current_submission_id AND assignment_id=a.id AND state='SUBMITTED';
  SELECT * INTO r FROM public.task_reviews WHERE submission_id=s.id;
  IF s.id IS NULL OR EXISTS(SELECT 1 FROM public.task_submissions WHERE assignment_id=a.id AND state='SUBMITTED' AND revision_number>s.revision_number) OR (a.status='SUBMITTED' AND r.id IS NOT NULL) OR (a.status IN ('APPROVED','REVISION_REQUIRED') AND r.decision IS DISTINCT FROM a.status) THEN RAISE EXCEPTION 'Current immutable submission/review required' USING ERRCODE='23514';END IF;
 END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER contribution_proof AFTER INSERT OR UPDATE ON task_assignments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.contribution_proof();
CREATE FUNCTION private.lock_submission(target uuid) RETURNS public.task_submissions LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.task_submissions%ROWTYPE;t public.tasks%ROWTYPE;
BEGIN
 IF NOT private.can_submission(target) THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
 SELECT s0.* INTO s FROM public.task_submissions s0 WHERE s0.id=target;
 t=private.lock_task((SELECT task_id FROM public.task_assignments WHERE id=s.assignment_id));
 PERFORM 1 FROM public.task_assignments WHERE id=s.assignment_id FOR UPDATE;
 SELECT * INTO s FROM public.task_submissions WHERE id=target FOR UPDATE;
 IF NOT private.can_submission(target) THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
 RETURN s;
END $$;
CREATE FUNCTION private.assert_submission_open(s public.task_submissions) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.task_assignments a JOIN public.tasks t ON t.id=a.task_id JOIN public.projects p ON p.id=t.project_id WHERE a.id=s.assignment_id AND a.access_revoked_at IS NULL AND p.status='ACTIVE' AND t.status NOT IN ('CANCELLED','APPROVED')) THEN RAISE EXCEPTION 'Work is read-only' USING ERRCODE='22023';END IF;
END $$;
CREATE FUNCTION private.create_submission(assignment uuid,data jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid;t public.tasks%ROWTYPE;a public.task_assignments%ROWTYPE;s public.task_submissions%ROWTYPE;key uuid=(data->>'creationKey')::uuid;fp text;target uuid;rev integer;
BEGIN
 actor=private.lock_work();IF private.is_admin() THEN RAISE EXCEPTION 'Employee submits own work' USING ERRCODE='42501';END IF;
 IF NOT private.can_assignment(assignment) THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
 t=private.lock_task((SELECT task_id FROM public.task_assignments WHERE id=assignment));
 SELECT * INTO a FROM public.task_assignments WHERE id=assignment AND employee_id=actor AND access_revoked_at IS NULL FOR UPDATE;
 IF a.id IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
 fp=private.work_fingerprint(jsonb_build_object('assignment_id',assignment,'notes',coalesce(data->>'notes',''),'urls',coalesce(data->'urls','[]')));
 SELECT * INTO s FROM public.task_submissions WHERE created_by=actor AND creation_key=key;
 IF s.id IS NOT NULL THEN IF s.creation_fingerprint<>fp THEN RAISE EXCEPTION 'Retry conflict' USING ERRCODE='40001';END IF;RETURN s.id;END IF;
 IF a.status NOT IN ('IN_PROGRESS','REVISION_REQUIRED') OR t.status IN ('CANCELLED','APPROVED') OR (SELECT status FROM public.projects WHERE id=t.project_id)<>'ACTIVE' OR EXISTS(SELECT 1 FROM public.task_submissions WHERE assignment_id=assignment AND state='DRAFT') THEN RAISE EXCEPTION 'No new draft permitted' USING ERRCODE='22023';END IF;
 SELECT coalesce(max(revision_number),0)+1 INTO rev FROM public.task_submissions WHERE assignment_id=assignment;
 INSERT INTO public.task_submissions(assignment_id,revision_number,notes,urls,created_by,creation_key,creation_fingerprint) VALUES(assignment,rev,coalesce(data->>'notes',''),coalesce(data->'urls','[]'),actor,key,fp) RETURNING id INTO target;
 UPDATE public.task_assignments SET version=version+1,updated_at=private.security_now() WHERE id=assignment;
 PERFORM private.work_audit('submission.draft_created',jsonb_build_object('task_id',t.id,'assignment_id',assignment,'employee_id',actor,'submission_id',target,'revision',rev));RETURN target;
END $$;
CREATE FUNCTION private.edit_submission(target uuid,expected integer,data jsonb,abandon boolean DEFAULT false) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid;s public.task_submissions%ROWTYPE;
BEGIN
 actor=private.lock_work();IF private.is_admin() THEN RAISE EXCEPTION 'Employee submits own work' USING ERRCODE='42501';END IF;
 s=private.lock_submission(target);PERFORM private.assert_submission_open(s);
 IF s.state<>'DRAFT' OR expected IS DISTINCT FROM s.version THEN RAISE EXCEPTION 'Draft changed or frozen' USING ERRCODE='40001';END IF;
 UPDATE public.task_submissions SET notes=CASE WHEN abandon THEN notes ELSE coalesce(data->>'notes',notes) END,urls=CASE WHEN abandon THEN urls ELSE coalesce(data->'urls',urls) END,state=CASE WHEN abandon THEN 'ABANDONED' ELSE 'DRAFT' END,updated_at=private.security_now(),version=version+1 WHERE id=target;
 UPDATE public.task_assignments SET version=version+1,updated_at=private.security_now() WHERE id=s.assignment_id;
 PERFORM private.work_audit('submission.draft_updated',jsonb_build_object('assignment_id',s.assignment_id,'employee_id',actor,'submission_id',target,'abandoned',abandon));
END $$;
CREATE FUNCTION private.submit_submission(target uuid,expected integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid;s public.task_submissions%ROWTYPE;a public.task_assignments%ROWTYPE;
BEGIN
 actor=private.lock_work();IF private.is_admin() THEN RAISE EXCEPTION 'Employee submits own work' USING ERRCODE='42501';END IF;
 s=private.lock_submission(target);PERFORM private.assert_submission_open(s);
 SELECT * INTO a FROM public.task_assignments WHERE id=s.assignment_id;
 IF s.state<>'DRAFT' OR expected IS DISTINCT FROM s.version OR a.status NOT IN ('IN_PROGRESS','REVISION_REQUIRED') THEN RAISE EXCEPTION 'Current draft required' USING ERRCODE='40001';END IF;
 PERFORM 1 FROM public.file_objects f JOIN public.submission_files x ON x.file_id=f.id WHERE x.submission_id=target ORDER BY f.id FOR UPDATE OF f;
 IF EXISTS(SELECT 1 FROM public.file_objects f JOIN public.submission_files x ON x.file_id=f.id WHERE x.submission_id=target AND f.state<>'AVAILABLE') OR (length(btrim(s.notes))=0 AND jsonb_array_length(s.urls)=0 AND NOT EXISTS(SELECT 1 FROM public.submission_files WHERE submission_id=target)) THEN RAISE EXCEPTION 'Complete content and available attachments required' USING ERRCODE='22023';END IF;
 UPDATE public.task_submissions SET state='SUBMITTED',submitted_at=private.security_now(),updated_at=private.security_now(),version=version+1 WHERE id=target;
 UPDATE public.task_assignments SET current_submission_id=target,status='SUBMITTED',status_changed_by=actor,status_changed_at=private.security_now(),updated_at=private.security_now(),version=version+1 WHERE id=a.id;
 PERFORM private.work_audit('assignment.status',jsonb_build_object('task_id',a.task_id,'assignment_id',a.id,'employee_id',actor,'submission_id',target,'from',a.status,'to','SUBMITTED'));
 PERFORM private.refresh_task(a.task_id);
END $$;
CREATE FUNCTION private.review_submission(target uuid,expected integer,decision text,note text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid;s public.task_submissions%ROWTYPE;a public.task_assignments%ROWTYPE;r public.task_reviews%ROWTYPE;result uuid;
BEGIN
 actor=private.lock_work(true);s=private.lock_submission(target);PERFORM private.assert_submission_open(s);
 SELECT * INTO a FROM public.task_assignments WHERE id=s.assignment_id;
 IF s.state<>'SUBMITTED' OR a.current_submission_id IS DISTINCT FROM target OR expected IS DISTINCT FROM s.version OR decision IS NULL OR decision NOT IN ('APPROVED','REVISION_REQUIRED') OR note IS NULL OR length(note)>2000 OR (decision='REVISION_REQUIRED' AND length(btrim(note)) NOT BETWEEN 10 AND 2000) THEN RAISE EXCEPTION 'Current submission and valid review required' USING ERRCODE='22023';END IF;
 SELECT * INTO r FROM public.task_reviews WHERE submission_id=target;
 IF r.id IS NOT NULL THEN IF r.decision=decision AND r.reason=note THEN RETURN r.id;END IF;RAISE EXCEPTION 'Review already recorded' USING ERRCODE='40001';END IF;
 IF a.status<>'SUBMITTED' THEN RAISE EXCEPTION 'Submission is no longer awaiting review' USING ERRCODE='40001';END IF;
 INSERT INTO public.task_reviews(submission_id,reviewer_id,decision,reason) VALUES(target,actor,decision,note) RETURNING id INTO result;
 UPDATE public.task_assignments SET status=decision,status_changed_by=actor,status_changed_at=private.security_now(),updated_at=private.security_now(),version=version+1 WHERE id=a.id;
 PERFORM private.work_audit('assignment.status',jsonb_build_object('task_id',a.task_id,'assignment_id',a.id,'employee_id',a.employee_id,'submission_id',target,'review_id',result,'from','SUBMITTED','to',decision,'reason',note));
 PERFORM private.refresh_task(a.task_id);RETURN result;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.create_submission(uuid,jsonb),private.edit_submission(uuid,integer,jsonb,boolean),private.submit_submission(uuid,integer),private.review_submission(uuid,integer,text,text) TO libetario_runtime;
COMMIT;
