BEGIN;
ALTER TABLE company_settings ADD COLUMN upload_validation_key_hash text CHECK(upload_validation_key_hash ~ '^[a-f0-9]{64}$');
-- Hash is public metadata; only the operator can replace the server capability verifier.
REVOKE UPDATE ON company_settings FROM libetario_runtime;
GRANT UPDATE(company_name,timezone,currency,security_policy_id,work_policy_id,pay_policy_id,updated_at,version) ON company_settings TO libetario_runtime;
CREATE TABLE task_submissions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),assignment_id uuid NOT NULL REFERENCES task_assignments(id) ON DELETE RESTRICT,
 revision_number integer NOT NULL CHECK(revision_number>0),state text NOT NULL DEFAULT 'DRAFT' CHECK(state IN ('DRAFT','SUBMITTED','ABANDONED')),
 notes text NOT NULL DEFAULT '' CHECK(length(notes)<=10000),urls jsonb NOT NULL DEFAULT '[]' CHECK(private.work_links(urls)),
 created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,created_at timestamptz NOT NULL DEFAULT private.security_now(),updated_at timestamptz NOT NULL DEFAULT private.security_now(),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),submitted_at timestamptz,
 creation_key uuid NOT NULL,creation_fingerprint text NOT NULL CHECK(creation_fingerprint ~ '^[a-f0-9]{64}$'),
 UNIQUE(assignment_id,revision_number),UNIQUE(id,assignment_id),UNIQUE(created_by,creation_key),CHECK((state='SUBMITTED')=(submitted_at IS NOT NULL))
);
CREATE UNIQUE INDEX submission_one_draft ON task_submissions(assignment_id) WHERE state='DRAFT';
CREATE INDEX ON task_submissions(created_by);CREATE INDEX ON task_submissions(state,submitted_at);
CREATE TABLE task_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),submission_id uuid NOT NULL UNIQUE REFERENCES task_submissions(id) ON DELETE RESTRICT,
 reviewer_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,decision text NOT NULL CHECK(decision IN ('APPROVED','REVISION_REQUIRED')),
 reason text NOT NULL DEFAULT '' CHECK(length(reason)<=2000),reviewed_at timestamptz NOT NULL DEFAULT private.security_now(),
 CHECK(decision<>'REVISION_REQUIRED' OR length(btrim(reason)) BETWEEN 10 AND 2000)
);
CREATE INDEX ON task_reviews(reviewer_id);
ALTER TABLE task_assignments ADD COLUMN current_submission_id uuid;
ALTER TABLE task_assignments ADD CONSTRAINT assignment_submission_owner FOREIGN KEY(current_submission_id,id) REFERENCES task_submissions(id,assignment_id) ON DELETE RESTRICT;
CREATE INDEX ON task_assignments(current_submission_id);
CREATE TABLE file_objects (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),storage_key text NOT NULL UNIQUE CHECK(storage_key ~ '^[a-f0-9]{64}$'),
 display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 120),declared_media_type text NOT NULL,detected_media_type text,
 reserved_bytes bigint NOT NULL CHECK(reserved_bytes BETWEEN 1 AND 10485760),size_bytes bigint CHECK(size_bytes BETWEEN 1 AND 10485760),sha256 text CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,uploaded_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 upload_session_id uuid NOT NULL,FOREIGN KEY(upload_session_id,uploaded_by) REFERENCES sessions(id,user_id) ON DELETE RESTRICT,
 membership_version integer CHECK(membership_version>0),state text NOT NULL DEFAULT 'QUARANTINED' CHECK(state IN ('QUARANTINED','AVAILABLE','REJECTED')),
 validation_policy_id uuid NOT NULL REFERENCES policy_versions(id) ON DELETE RESTRICT,created_at timestamptz NOT NULL DEFAULT private.security_now(),
 upload_completed_at timestamptz,validated_at timestamptz,validation_outcome text,validation_version integer NOT NULL DEFAULT 1 CHECK(validation_version=1),bytes_deleted_at timestamptz,
 CHECK(size_bytes IS NULL OR size_bytes<=reserved_bytes),
 CHECK(state<>'AVAILABLE' OR (size_bytes=reserved_bytes AND sha256 IS NOT NULL AND detected_media_type=declared_media_type AND upload_completed_at IS NOT NULL AND validated_at IS NOT NULL AND validation_outcome='VALIDATED' AND bytes_deleted_at IS NULL)),
 CHECK(state<>'REJECTED' OR (validated_at IS NOT NULL AND validation_outcome IS NOT NULL)),CHECK(bytes_deleted_at IS NULL OR state='REJECTED')
);
CREATE INDEX ON file_objects(project_id);CREATE INDEX ON file_objects(uploaded_by,created_at);CREATE INDEX ON file_objects(upload_session_id);CREATE INDEX ON file_objects(validation_policy_id);CREATE INDEX ON file_objects(state,created_at);
CREATE TABLE project_files (
 project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,file_id uuid NOT NULL UNIQUE REFERENCES file_objects(id) ON DELETE RESTRICT,
 linked_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,linked_at timestamptz NOT NULL DEFAULT private.security_now(),PRIMARY KEY(project_id,file_id)
);
CREATE TABLE task_files (
 task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,file_id uuid NOT NULL UNIQUE REFERENCES file_objects(id) ON DELETE RESTRICT,
 linked_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,linked_at timestamptz NOT NULL DEFAULT private.security_now(),PRIMARY KEY(task_id,file_id)
);
CREATE TABLE submission_files (
 submission_id uuid NOT NULL REFERENCES task_submissions(id) ON DELETE RESTRICT,file_id uuid NOT NULL UNIQUE REFERENCES file_objects(id) ON DELETE RESTRICT,
 linked_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,linked_at timestamptz NOT NULL DEFAULT private.security_now(),PRIMARY KEY(submission_id,file_id)
);
CREATE INDEX ON project_files(linked_by);CREATE INDEX ON task_files(linked_by);CREATE INDEX ON submission_files(linked_by);
CREATE FUNCTION private.can_assignment(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT private.is_admin() OR EXISTS(SELECT 1 FROM public.task_assignments a JOIN private.duty_context() d ON d.user_id=a.employee_id WHERE a.id=target AND a.access_revoked_at IS NULL)
$$;
CREATE FUNCTION private.can_submission(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.task_submissions s WHERE s.id=target AND private.can_assignment(s.assignment_id))
$$;
CREATE FUNCTION private.can_file(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.project_files x WHERE x.file_id=target AND private.can_project(x.project_id)) OR
 EXISTS(SELECT 1 FROM public.task_files x WHERE x.file_id=target AND private.can_task(x.task_id)) OR
 EXISTS(SELECT 1 FROM public.submission_files x WHERE x.file_id=target AND private.can_submission(x.submission_id))
$$;
ALTER TABLE task_submissions ENABLE ROW LEVEL SECURITY;ALTER TABLE task_reviews ENABLE ROW LEVEL SECURITY;ALTER TABLE file_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_files ENABLE ROW LEVEL SECURITY;ALTER TABLE task_files ENABLE ROW LEVEL SECURITY;ALTER TABLE submission_files ENABLE ROW LEVEL SECURITY;
CREATE POLICY submission_read ON task_submissions FOR SELECT TO libetario_runtime USING(private.can_assignment(assignment_id));
CREATE POLICY review_read ON task_reviews FOR SELECT TO libetario_runtime USING(private.can_submission(submission_id));
CREATE POLICY file_read ON file_objects FOR SELECT TO libetario_runtime USING(private.can_file(id));
CREATE POLICY project_file_read ON project_files FOR SELECT TO libetario_runtime USING(private.can_project(project_id));
CREATE POLICY task_file_read ON task_files FOR SELECT TO libetario_runtime USING(private.can_task(task_id));
CREATE POLICY submission_file_read ON submission_files FOR SELECT TO libetario_runtime USING(private.can_submission(submission_id));
REVOKE ALL ON task_submissions,task_reviews,file_objects,project_files,task_files,submission_files FROM PUBLIC,libetario_runtime,libetario_auth;
GRANT SELECT ON task_submissions,task_reviews,project_files,task_files,submission_files TO libetario_runtime;
GRANT SELECT(id,display_name,declared_media_type,detected_media_type,size_bytes,state,uploaded_by,created_at,validated_at,bytes_deleted_at) ON file_objects TO libetario_runtime;
REVOKE ALL ON FUNCTION private.can_assignment(uuid),private.can_submission(uuid),private.can_file(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.can_assignment(uuid),private.can_submission(uuid),private.can_file(uuid) TO libetario_runtime;
CREATE FUNCTION private.file_owner_constraint() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE target uuid;pid uuid;f public.file_objects%ROWTYPE;n integer;
BEGIN
 IF TG_TABLE_NAME='file_objects' THEN target=NEW.id;ELSE target=NEW.file_id;END IF;
 SELECT * INTO f FROM public.file_objects WHERE id=target FOR UPDATE;
 SELECT count(*),min(owner_project::text)::uuid INTO n,pid FROM (
  SELECT p.project_id owner_project FROM public.project_files p WHERE p.file_id=target
  UNION ALL SELECT t.project_id FROM public.task_files x JOIN public.tasks t ON t.id=x.task_id WHERE x.file_id=target
  UNION ALL SELECT t.project_id FROM public.submission_files x JOIN public.task_submissions s ON s.id=x.submission_id JOIN public.task_assignments a ON a.id=s.assignment_id JOIN public.tasks t ON t.id=a.task_id WHERE x.file_id=target
 ) owners;
 IF n<>1 OR pid IS DISTINCT FROM f.project_id THEN RAISE EXCEPTION 'Exactly one matching typed file owner required' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER file_owner_check AFTER INSERT OR UPDATE ON file_objects DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.file_owner_constraint();
CREATE CONSTRAINT TRIGGER project_file_owner_check AFTER INSERT ON project_files DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.file_owner_constraint();
CREATE CONSTRAINT TRIGGER task_file_owner_check AFTER INSERT ON task_files DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.file_owner_constraint();
CREATE CONSTRAINT TRIGGER submission_file_owner_check AFTER INSERT ON submission_files DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.file_owner_constraint();
CREATE TRIGGER protect_project_file BEFORE UPDATE OR DELETE OR TRUNCATE ON project_files FOR EACH STATEMENT EXECUTE FUNCTION private.immutable();
CREATE TRIGGER protect_task_file BEFORE UPDATE OR DELETE OR TRUNCATE ON task_files FOR EACH STATEMENT EXECUTE FUNCTION private.immutable();
CREATE TRIGGER protect_submission_file BEFORE UPDATE OR DELETE OR TRUNCATE ON submission_files FOR EACH STATEMENT EXECUTE FUNCTION private.immutable();
CREATE TRIGGER protect_review BEFORE UPDATE OR DELETE OR TRUNCATE ON task_reviews FOR EACH STATEMENT EXECUTE FUNCTION private.immutable();
REVOKE ALL ON FUNCTION private.file_owner_constraint() FROM PUBLIC;
COMMIT;
