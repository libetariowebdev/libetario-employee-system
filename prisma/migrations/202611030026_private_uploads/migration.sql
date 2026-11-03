BEGIN;
ALTER TABLE submission_files ADD COLUMN excluded_at timestamptz,ADD COLUMN excluded_by uuid REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE submission_files ADD CONSTRAINT exclusion_actor CHECK((excluded_at IS NULL)=(excluded_by IS NULL));
CREATE INDEX ON submission_files(excluded_by);
CREATE FUNCTION private.upload_defaults() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT '{"allowedTypes":["application/pdf","image/png","image/jpeg","image/webp"],"maxFileBytes":10485760,"maxFilesPerDraft":10,"dailyBytes":104857600,"projectBytes":1073741824,"appBytes":5368709120,"maxDimension":8192,"maxPixels":20000000,"maxPdfPages":500,"validationTimeoutMs":30000,"uploadAttempts":20,"downloadAttempts":120}'::jsonb
$$;
CREATE FUNCTION private.validate_upload_policy(cfg jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE key text;v numeric;limits jsonb='{"maxFileBytes":10485760,"maxFilesPerDraft":10,"dailyBytes":1073741824,"projectBytes":10737418240,"appBytes":53687091200,"maxDimension":8192,"maxPixels":20000000,"maxPdfPages":500,"validationTimeoutMs":30000,"uploadAttempts":100,"downloadAttempts":1000}';
BEGIN
 IF cfg IS NULL OR jsonb_typeof(cfg)<>'object' OR jsonb_typeof(cfg->'allowedTypes') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 IF jsonb_array_length(cfg->'allowedTypes') NOT BETWEEN 1 AND 4 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(cfg->'allowedTypes') t WHERE t NOT IN ('application/pdf','image/png','image/jpeg','image/webp')) OR (SELECT count(DISTINCT x) FROM jsonb_array_elements_text(cfg->'allowedTypes') x)<>jsonb_array_length(cfg->'allowedTypes') THEN RETURN false;END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(cfg))<>12 THEN RETURN false;END IF;
 FOR key IN SELECT jsonb_object_keys(limits) LOOP
  IF jsonb_typeof(cfg->key) IS DISTINCT FROM 'number' THEN RETURN false;END IF;v=(cfg->>key)::numeric;
  IF v<>trunc(v) OR v<1 OR v>(limits->>key)::numeric THEN RETURN false;END IF;
 END LOOP;RETURN true;
END $$;
CREATE FUNCTION private.upload_policy_check() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN IF NEW.policy_key='WORK' AND NEW.configuration ? 'uploads' AND NOT private.validate_upload_policy(NEW.configuration->'uploads') THEN RAISE EXCEPTION 'Invalid upload policy' USING ERRCODE='22023';END IF;RETURN NEW;END $$;
CREATE TRIGGER upload_policy_check BEFORE INSERT ON policy_versions FOR EACH ROW EXECUTE FUNCTION private.upload_policy_check();
CREATE FUNCTION private.upload_policy() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT private.upload_defaults()||coalesce(p.configuration->'uploads','{}')||jsonb_build_object('policyId',p.id) FROM public.company_settings c JOIN public.policy_versions p ON p.id=c.work_policy_id WHERE c.id=1
$$;
CREATE FUNCTION private.set_upload_policy(expected uuid,cfg jsonb,note text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid;p public.policy_versions%ROWTYPE;added uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(72426820::bigint);actor=private.lock_work(true);PERFORM private.work_note(note);
 IF NOT private.admin_recent() OR NOT private.validate_upload_policy(cfg) THEN RAISE EXCEPTION 'Recent MFA and valid upload policy required' USING ERRCODE='42501';END IF;
 PERFORM 1 FROM public.company_settings WHERE id=1 FOR UPDATE;
 SELECT p0.* INTO p FROM public.company_settings c JOIN public.policy_versions p0 ON p0.id=c.work_policy_id WHERE c.id=1;
 IF p.id IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Policy changed' USING ERRCODE='40001';END IF;
 INSERT INTO public.policy_versions(policy_key,revision,configuration,created_by) SELECT 'WORK',max(revision)+1,p.configuration||jsonb_build_object('uploads',cfg),actor FROM public.policy_versions WHERE policy_key='WORK' RETURNING id INTO added;
 UPDATE public.company_settings SET work_policy_id=added,version=version+1,updated_at=private.security_now() WHERE id=1;
 PERFORM private.work_audit('work.upload_policy_changed',jsonb_build_object('previous_policy_id',expected,'policy_id',added,'reason',note));
END $$;
CREATE FUNCTION private.assert_upload_proof(proof text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN IF proof IS NULL OR proof !~ '^[a-f0-9]{64}$' OR NOT EXISTS(SELECT 1 FROM public.company_settings WHERE id=1 AND upload_validation_key_hash=encode(sha256(convert_to(proof,'UTF8')),'hex')) THEN RAISE EXCEPTION 'Server validation proof required' USING ERRCODE='42501';END IF;END $$;
CREATE FUNCTION private.file_name_valid(name text,media text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT name IS NOT NULL AND name=btrim(name) AND normalize(name,NFKC)=name AND length(name) BETWEEN 3 AND 120 AND name !~ '[[:cntrl:]/:%]' AND strpos(name,chr(92))=0 AND name !~ U&'[\202A-\202E\2066-\2069]' AND length(name)-length(replace(name,'.',''))=1 AND split_part(name,'.',1) !~* '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]|CLOCK[$])$' AND
 (CASE lower(split_part(name,'.',2)) WHEN 'pdf' THEN media='application/pdf' WHEN 'png' THEN media='image/png' WHEN 'jpg' THEN media='image/jpeg' WHEN 'jpeg' THEN media='image/jpeg' WHEN 'webp' THEN media='image/webp' ELSE false END)
$$;
CREATE FUNCTION private.file_request_limit(kind text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid=private.work_actor();scope_name text;subject text;cap integer;n integer;cfg jsonb;
BEGIN
 IF actor IS NULL OR kind NOT IN ('UPLOAD','DOWNLOAD') OR kind IS NULL THEN RAISE EXCEPTION 'Work access required' USING ERRCODE='42501';END IF;
 cfg=private.upload_policy();scope_name='FILE_'||kind;subject=encode(sha256(convert_to(actor::text,'UTF8')),'hex');cap=(cfg->>CASE WHEN kind='UPLOAD' THEN 'uploadAttempts' ELSE 'downloadAttempts' END)::int;
 PERFORM pg_advisory_xact_lock(hashtextextended(scope_name||subject,0));
 INSERT INTO public.security_throttles(scope,subject_digest) VALUES(scope_name,subject) ON CONFLICT DO NOTHING;
 UPDATE public.security_throttles SET failure_count=0,window_started_at=private.security_now(),locked_until=NULL WHERE scope=scope_name AND subject_digest=subject AND window_started_at<=private.security_now()-interval '15 minutes';
 UPDATE public.security_throttles SET failure_count=failure_count+1,updated_at=private.security_now() WHERE scope=scope_name AND subject_digest=subject RETURNING failure_count INTO n;
 RETURN n<=cap;
END $$;
CREATE FUNCTION private.reserve_file(kind text,parent uuid,data jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid;pid uuid;t public.tasks%ROWTYPE;s public.task_submissions%ROWTYPE;sid uuid;mv integer;cfg jsonb;bytes bigint=(data->>'size')::bigint;target uuid=gen_random_uuid();
BEGIN
 actor=private.lock_work();SELECT id INTO sid FROM public.sessions WHERE token_hash=current_setting('app.session_hash',true);
 IF kind='PROJECT' THEN
  IF NOT private.is_admin() THEN RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501';END IF;
  SELECT id INTO pid FROM public.projects WHERE id=parent FOR UPDATE;
 ELSIF kind='TASK' THEN
  IF NOT private.is_admin() THEN RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501';END IF;t=private.lock_task(parent);pid=t.project_id;mv=t.membership_version;
  IF t.status IN ('CANCELLED','APPROVED') THEN RAISE EXCEPTION 'Task references frozen' USING ERRCODE='22023';END IF;
 ELSIF kind='SUBMISSION' THEN
  IF private.is_admin() THEN RAISE EXCEPTION 'Employee uploads own draft' USING ERRCODE='42501';END IF;s=private.lock_submission(parent);PERFORM private.assert_submission_open(s);
  IF s.state<>'DRAFT' THEN RAISE EXCEPTION 'Draft frozen' USING ERRCODE='22023';END IF;
  SELECT t0.* INTO t FROM public.tasks t0 JOIN public.task_assignments a ON a.task_id=t0.id WHERE a.id=s.assignment_id;pid=t.project_id;mv=t.membership_version;
 ELSE RAISE EXCEPTION 'Invalid owner' USING ERRCODE='22023';END IF;
 IF pid IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
 IF (SELECT status FROM public.projects WHERE id=pid)<>'ACTIVE' THEN RAISE EXCEPTION 'Project read-only' USING ERRCODE='22023';END IF;
 cfg=private.upload_policy();
 IF bytes IS NULL OR bytes NOT BETWEEN 1 AND (cfg->>'maxFileBytes')::bigint OR NOT (cfg->'allowedTypes' ? (data->>'media')) OR NOT private.file_name_valid(data->>'name',data->>'media') OR data->>'storageKey' IS NULL OR data->>'storageKey' !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid file metadata' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(72426824::bigint);
 IF coalesce((SELECT sum(reserved_bytes) FROM public.file_objects WHERE bytes_deleted_at IS NULL),0)+bytes>(cfg->>'appBytes')::bigint OR coalesce((SELECT sum(reserved_bytes) FROM public.file_objects WHERE project_id=pid AND bytes_deleted_at IS NULL),0)+bytes>(cfg->>'projectBytes')::bigint OR coalesce((SELECT sum(reserved_bytes) FROM public.file_objects WHERE uploaded_by=actor AND (created_at AT TIME ZONE 'Asia/Manila')::date=(private.security_now() AT TIME ZONE 'Asia/Manila')::date AND bytes_deleted_at IS NULL),0)+bytes>(cfg->>'dailyBytes')::bigint OR (kind='SUBMISSION' AND (SELECT count(*) FROM public.submission_files WHERE submission_id=parent AND excluded_at IS NULL)>=(cfg->>'maxFilesPerDraft')::int) THEN RAISE EXCEPTION 'Upload quota exceeded' USING ERRCODE='P0413';END IF;
 INSERT INTO public.file_objects(id,storage_key,display_name,declared_media_type,reserved_bytes,project_id,uploaded_by,upload_session_id,membership_version,validation_policy_id)
 VALUES(target,data->>'storageKey',data->>'name',data->>'media',bytes,pid,actor,sid,mv,(cfg->>'policyId')::uuid);
 IF kind='PROJECT' THEN INSERT INTO public.project_files(project_id,file_id,linked_by) VALUES(parent,target,actor);
 ELSIF kind='TASK' THEN INSERT INTO public.task_files(task_id,file_id,linked_by) VALUES(parent,target,actor);
 ELSE
  INSERT INTO public.submission_files(submission_id,file_id,linked_by) VALUES(parent,target,actor);
  UPDATE public.task_submissions SET version=version+1,updated_at=private.security_now() WHERE id=parent;
  UPDATE public.task_assignments SET version=version+1,updated_at=private.security_now() WHERE id=s.assignment_id;
 END IF;
 PERFORM private.work_audit('file.quarantined',jsonb_build_object('file_id',target,'owner_kind',kind,'owner_id',parent));RETURN target;
END $$;
CREATE FUNCTION private.publish_file(target uuid,bytes bigint,hash text,media text,proof text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid;f public.file_objects%ROWTYPE;t public.tasks%ROWTYPE;s public.task_submissions%ROWTYPE;parent uuid;cfg jsonb;kind text;sid uuid;
BEGIN
 actor=private.lock_work();PERFORM private.assert_upload_proof(proof);
 SELECT * INTO f FROM public.file_objects WHERE id=target;
 SELECT id INTO sid FROM public.sessions WHERE token_hash=current_setting('app.session_hash',true);
 IF f.id IS NULL OR NOT private.can_file(target) OR f.uploaded_by<>actor OR f.upload_session_id<>sid THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
 SELECT project_id INTO parent FROM public.project_files WHERE file_id=target;
 IF parent IS NOT NULL THEN kind='PROJECT';PERFORM 1 FROM public.projects WHERE id=parent FOR UPDATE;
 ELSE
  SELECT task_id INTO parent FROM public.task_files WHERE file_id=target;
  IF parent IS NOT NULL THEN kind='TASK';t=private.lock_task(parent);IF t.status IN ('APPROVED','CANCELLED') THEN RAISE EXCEPTION 'Task frozen' USING ERRCODE='22023';END IF;
  ELSE kind='SUBMISSION';SELECT submission_id INTO parent FROM public.submission_files WHERE file_id=target AND excluded_at IS NULL;s=private.lock_submission(parent);PERFORM private.assert_submission_open(s);IF s.state<>'DRAFT' THEN RAISE EXCEPTION 'Draft frozen' USING ERRCODE='22023';END IF;SELECT t0.* INTO t FROM public.tasks t0 JOIN public.task_assignments a ON a.task_id=t0.id WHERE a.id=s.assignment_id;
  END IF;
 END IF;
 SELECT * INTO f FROM public.file_objects WHERE id=target FOR UPDATE;
 cfg=private.upload_policy();
 IF NOT private.can_file(target) OR (SELECT status FROM public.projects WHERE id=f.project_id)<>'ACTIVE' OR (kind<>'PROJECT' AND t.membership_version<>f.membership_version) OR f.state<>'QUARANTINED' OR f.validation_policy_id IS DISTINCT FROM (cfg->>'policyId')::uuid OR bytes IS DISTINCT FROM f.reserved_bytes OR hash IS NULL OR hash !~ '^[a-f0-9]{64}$' OR media IS DISTINCT FROM f.declared_media_type OR NOT(cfg->'allowedTypes' ? media) THEN RAISE EXCEPTION 'Upload authorization or content changed' USING ERRCODE='22023';END IF;
 UPDATE public.file_objects SET size_bytes=bytes,sha256=hash,detected_media_type=media,state='AVAILABLE',upload_completed_at=private.security_now(),validated_at=private.security_now(),validation_outcome='VALIDATED' WHERE id=target;
 IF kind='SUBMISSION' THEN UPDATE public.task_submissions SET version=version+1,updated_at=private.security_now() WHERE id=parent;UPDATE public.task_assignments SET version=version+1,updated_at=private.security_now() WHERE id=s.assignment_id;
 ELSIF kind='TASK' THEN PERFORM private.refresh_task(parent);
 ELSE UPDATE public.projects SET version=version+1,updated_at=private.security_now() WHERE id=parent;END IF;
 PERFORM private.work_audit('file.available',jsonb_build_object('file_id',target));
END $$;
CREATE FUNCTION private.reject_file(target uuid,proof text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM private.assert_upload_proof(proof);
 UPDATE public.file_objects SET state='REJECTED',validated_at=private.security_now(),validation_outcome='VALIDATION_OR_AUTHORIZATION_FAILED' WHERE id=target AND state='QUARANTINED' AND upload_session_id=(SELECT id FROM public.sessions WHERE token_hash=current_setting('app.session_hash',true));
 IF FOUND THEN PERFORM private.work_audit('file.rejected',jsonb_build_object('file_id',target));END IF;
END $$;
CREATE FUNCTION private.file_locator(target uuid) RETURNS TABLE(storage_key text,display_name text,media_type text,size_bytes bigint,sha256 text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF private.work_actor() IS NULL THEN RAISE EXCEPTION 'Work access required' USING ERRCODE='42501';END IF;
 IF NOT private.can_file(target) THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
 RETURN QUERY SELECT f.storage_key,f.display_name,f.detected_media_type,f.size_bytes,f.sha256 FROM public.file_objects f WHERE f.id=target AND f.state='AVAILABLE';
 IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
END $$;
CREATE FUNCTION private.submission_link_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Immutable owner link' USING ERRCODE='42501';END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.submission_id,NEW.file_id,NEW.linked_by,NEW.linked_at) IS DISTINCT FROM (OLD.submission_id,OLD.file_id,OLD.linked_by,OLD.linked_at) OR OLD.excluded_at IS NOT NULL OR NEW.excluded_at IS NULL OR NOT EXISTS(SELECT 1 FROM public.task_submissions WHERE id=NEW.submission_id AND state='DRAFT') THEN RAISE EXCEPTION 'Frozen attachment/owner' USING ERRCODE='22023';END IF;
 END IF;RETURN NEW;
END $$;
DROP TRIGGER protect_submission_file ON submission_files;
CREATE TRIGGER protect_submission_file BEFORE UPDATE OR DELETE ON submission_files FOR EACH ROW EXECUTE FUNCTION private.submission_link_guard();
CREATE TRIGGER protect_submission_file_truncate BEFORE TRUNCATE ON submission_files FOR EACH STATEMENT EXECUTE FUNCTION private.immutable();
CREATE FUNCTION private.exclude_draft_file(target uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid;s public.task_submissions%ROWTYPE;parent uuid;
BEGIN
 actor=private.lock_work();IF private.is_admin() THEN RAISE EXCEPTION 'Employee owns draft' USING ERRCODE='42501';END IF;
 IF NOT private.can_file(target) THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
 SELECT submission_id INTO parent FROM public.submission_files WHERE file_id=target;s=private.lock_submission(parent);PERFORM private.assert_submission_open(s);
 IF s.state<>'DRAFT' THEN RAISE EXCEPTION 'Draft frozen' USING ERRCODE='22023';END IF;
 PERFORM 1 FROM public.file_objects WHERE id=target FOR UPDATE;
 UPDATE public.submission_files SET excluded_at=private.security_now(),excluded_by=actor WHERE file_id=target AND excluded_at IS NULL;
 IF FOUND THEN UPDATE public.task_submissions SET version=version+1,updated_at=private.security_now() WHERE id=parent;PERFORM private.work_audit('file.excluded_from_draft',jsonb_build_object('file_id',target,'submission_id',parent));END IF;
END $$;
CREATE FUNCTION private.file_integrity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (NEW.id,NEW.storage_key,NEW.display_name,NEW.declared_media_type,NEW.reserved_bytes,NEW.project_id,NEW.uploaded_by,NEW.upload_session_id,NEW.membership_version,NEW.validation_policy_id,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.storage_key,OLD.display_name,OLD.declared_media_type,OLD.reserved_bytes,OLD.project_id,OLD.uploaded_by,OLD.upload_session_id,OLD.membership_version,OLD.validation_policy_id,OLD.created_at) OR OLD.state='AVAILABLE' OR (OLD.state='REJECTED' AND (to_jsonb(NEW)-'bytes_deleted_at')<>(to_jsonb(OLD)-'bytes_deleted_at')) THEN RAISE EXCEPTION 'Immutable file identity/content' USING ERRCODE='22023';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER file_integrity BEFORE UPDATE ON file_objects FOR EACH ROW EXECUTE FUNCTION private.file_integrity();
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.upload_policy(),private.set_upload_policy(uuid,jsonb,text),private.file_request_limit(text),private.reserve_file(text,uuid,jsonb),private.publish_file(uuid,bigint,text,text,text),private.reject_file(uuid,text),private.file_locator(uuid),private.exclude_draft_file(uuid) TO libetario_runtime;
COMMIT;
