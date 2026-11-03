BEGIN;
-- All mutations take policy -> sorted users -> session -> duty -> project -> task -> assignment.
-- Revalidate after waits. No function accepts an actor/user claim as authorization.
CREATE FUNCTION private.lock_work(admin_only boolean DEFAULT false,related uuid[] DEFAULT '{}') RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid;s public.sessions%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(72426820::bigint);
 actor=private.work_actor();
 IF actor IS NULL OR (admin_only AND NOT private.is_admin()) THEN RAISE EXCEPTION 'Work access required' USING ERRCODE='42501';END IF;
 PERFORM 1 FROM public.users WHERE id=actor OR id=ANY(related) ORDER BY id FOR UPDATE;
 SELECT * INTO s FROM public.sessions WHERE token_hash=current_setting('app.session_hash',true) FOR UPDATE;
 IF s.scope='DUTY' THEN PERFORM 1 FROM public.duty_authorizations WHERE id=s.duty_id FOR UPDATE;END IF;
 IF private.work_actor() IS DISTINCT FROM actor OR (admin_only AND NOT private.is_admin()) THEN RAISE EXCEPTION 'Work access required' USING ERRCODE='42501';END IF;
 RETURN actor;
END $$;
CREATE FUNCTION private.work_note(note text) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN IF note IS NULL OR length(btrim(note)) NOT BETWEEN 10 AND 500 THEN RAISE EXCEPTION 'Reason must have 10-500 characters' USING ERRCODE='22023';END IF;END $$;
CREATE FUNCTION private.lock_task(target uuid) RETURNS public.tasks LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t public.tasks%ROWTYPE;pid uuid;
BEGIN
 IF NOT private.can_task(target) THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
 SELECT project_id INTO pid FROM public.tasks WHERE id=target;
 IF pid IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
 PERFORM 1 FROM public.projects WHERE id=pid FOR UPDATE;
 SELECT * INTO t FROM public.tasks WHERE id=target FOR UPDATE;
 IF NOT private.can_task(target) THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
 RETURN t;
END $$;
CREATE FUNCTION private.recipient_cap() RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT coalesce((p.configuration->'tasks'->>'maxRecipients')::integer,500) FROM public.company_settings s JOIN public.policy_versions p ON p.id=s.work_policy_id WHERE s.id=1
$$;
CREATE FUNCTION private.work_fingerprint(data jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT encode(sha256(convert_to(data::text,'UTF8')),'hex') $$;
CREATE FUNCTION private.work_audit(action_name text,details jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM private.write_audit(action_name,details);
 -- Use the same trusted clock as business rows, including owner-only test fixtures.
 -- write_audit's general implementation intentionally remains unchanged for prior phases.
END $$;
CREATE FUNCTION private.refresh_task(target uuid,note text DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE oldrow public.tasks%ROWTYPE;next_state text;actor uuid=private.work_actor();
BEGIN
 SELECT * INTO oldrow FROM public.tasks WHERE id=target FOR UPDATE;
 IF oldrow.status='CANCELLED' THEN next_state='CANCELLED';
 ELSIF NOT EXISTS(SELECT 1 FROM public.task_assignments WHERE task_id=target AND counts_for_completion) THEN next_state='CANCELLED';
 ELSIF EXISTS(SELECT 1 FROM public.task_assignments WHERE task_id=target AND counts_for_completion AND status='IN_PROGRESS') THEN next_state='IN_PROGRESS';
 ELSE next_state='PENDING';END IF;
 UPDATE public.tasks SET status=next_state,status_changed_by=CASE WHEN status<>next_state THEN actor ELSE status_changed_by END,
  status_changed_at=CASE WHEN status<>next_state THEN private.security_now() ELSE status_changed_at END,updated_at=private.security_now(),version=version+1 WHERE id=target;
 IF oldrow.status<>next_state THEN PERFORM private.work_audit('task.status',jsonb_build_object('task_id',target,'from',oldrow.status,'to',next_state,'reason',note,'version',oldrow.version+1));END IF;
END $$;
CREATE FUNCTION private.create_project(data jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid;found public.projects%ROWTYPE;fingerprint text;key uuid=(data->>'creationKey')::uuid;target uuid;
BEGIN
 actor=private.lock_work(true);fingerprint=private.work_fingerprint(data-'creationKey');
 SELECT * INTO found FROM public.projects WHERE created_by=actor AND creation_key=key;
 IF found.id IS NOT NULL THEN
  IF found.creation_fingerprint<>fingerprint THEN RAISE EXCEPTION 'Retry key conflict' USING ERRCODE='40001';END IF;RETURN found.id;
 END IF;
 INSERT INTO public.projects(code,name,client_label,website_url,description,reference_links,start_date,deadline_at,priority,status,created_by,status_changed_by,creation_key,creation_fingerprint)
 VALUES(data->>'code',data->>'name',data->>'clientLabel',data->>'websiteUrl',coalesce(data->>'description',''),coalesce(data->'references','[]'),(data->>'startDate')::date,(data->>'deadlineAt')::timestamptz,coalesce(data->>'priority','NORMAL'),coalesce(data->>'status','ACTIVE'),actor,actor,key,fingerprint) RETURNING id INTO target;
 PERFORM private.work_audit('project.created',jsonb_build_object('project_id',target,'status',coalesce(data->>'status','ACTIVE')));RETURN target;
END $$;
CREATE FUNCTION private.edit_project(target uuid,expected integer,data jsonb,note text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid;oldrow public.projects%ROWTYPE;newrow public.projects%ROWTYPE;
BEGIN
 actor=private.lock_work(true);PERFORM private.work_note(note);
 SELECT * INTO oldrow FROM public.projects WHERE id=target FOR UPDATE;
 IF oldrow.id IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
 IF expected IS DISTINCT FROM oldrow.version THEN RAISE EXCEPTION 'Version conflict' USING ERRCODE='40001';END IF;
 UPDATE public.projects SET code=coalesce(data->>'code',code),name=coalesce(data->>'name',name),
 client_label=CASE WHEN data ? 'clientLabel' THEN data->>'clientLabel' ELSE client_label END,website_url=CASE WHEN data ? 'websiteUrl' THEN data->>'websiteUrl' ELSE website_url END,
 description=coalesce(data->>'description',description),reference_links=coalesce(data->'references',reference_links),start_date=CASE WHEN data ? 'startDate' THEN (data->>'startDate')::date ELSE start_date END,
 deadline_at=CASE WHEN data ? 'deadlineAt' THEN (data->>'deadlineAt')::timestamptz ELSE deadline_at END,priority=coalesce(data->>'priority',priority),status=coalesce(data->>'status',status),
 status_changed_by=CASE WHEN data ? 'status' AND data->>'status'<>status THEN actor ELSE status_changed_by END,status_changed_at=CASE WHEN data ? 'status' AND data->>'status'<>status THEN private.security_now() ELSE status_changed_at END,
 updated_at=private.security_now(),version=version+1 WHERE id=target RETURNING * INTO newrow;
 PERFORM private.work_audit('project.updated',jsonb_build_object('project_id',target,'before',to_jsonb(oldrow)-'creation_fingerprint','after',to_jsonb(newrow)-'creation_fingerprint','reason',note));
END $$;
CREATE FUNCTION private.create_task(data jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid;existing public.tasks%ROWTYPE;recipients uuid[];mode text=data->>'assignmentMode';key uuid=(data->>'creationKey')::uuid;fingerprint text;target uuid=gen_random_uuid();pid uuid=(data->>'projectId')::uuid;snapshot_at timestamptz;cap integer;
BEGIN
 -- Snapshot ALL_ACTIVE once in this query. Never rerun the recipient query after waiting.
 SELECT array_agg(DISTINCT x::uuid ORDER BY x::uuid) INTO recipients FROM jsonb_array_elements_text(coalesce(data->'employeeIds','[]')) x;
 fingerprint=private.work_fingerprint((data-'creationKey'-'employeeIds')||jsonb_build_object('employeeIds',coalesce(to_jsonb(recipients),'[]')));
 IF NOT private.is_admin() THEN RAISE EXCEPTION 'Work access required' USING ERRCODE='42501';END IF;
 actor=private.work_actor();
 SELECT * INTO existing FROM public.tasks WHERE created_by=actor AND creation_key=key;
 IF existing.id IS NOT NULL THEN
  IF existing.creation_fingerprint<>fingerprint THEN RAISE EXCEPTION 'Retry key conflict' USING ERRCODE='40001';END IF;RETURN existing.id;
 END IF;
 snapshot_at=private.security_now();
 IF mode='ALL_ACTIVE' THEN
  IF cardinality(recipients)>0 THEN RAISE EXCEPTION 'ALL_ACTIVE takes no explicit recipients' USING ERRCODE='22023';END IF;
  SELECT array_agg(u.id ORDER BY u.id) INTO recipients FROM public.users u JOIN public.employee_profiles ep ON ep.user_id=u.id
   WHERE u.role='EMPLOYEE' AND u.disabled_at IS NULL AND ep.employment_status='ACTIVE' AND ep.start_date<=(snapshot_at AT TIME ZONE 'Asia/Manila')::date;
 END IF;
 actor=private.lock_work(true,coalesce(recipients,'{}'));
 -- Another identical request may have committed while this request waited.
 SELECT * INTO existing FROM public.tasks WHERE created_by=actor AND creation_key=key;
 IF existing.id IS NOT NULL THEN
  IF existing.creation_fingerprint<>fingerprint THEN RAISE EXCEPTION 'Retry key conflict' USING ERRCODE='40001';END IF;RETURN existing.id;
 END IF;
 cap=private.recipient_cap();
 IF cap IS NULL OR cap NOT BETWEEN 1 AND 500 OR coalesce(cardinality(recipients),0) NOT BETWEEN 1 AND cap OR mode NOT IN ('INDIVIDUAL','SELECTED','ALL_ACTIVE') OR mode IS NULL OR (mode='INDIVIDUAL' AND cardinality(recipients)<>1) OR coalesce(data->>'collaborationMode','SHARED')<>'SHARED' THEN RAISE EXCEPTION 'Invalid recipients or capacity' USING ERRCODE='22023';END IF;
 -- Creation snapshot does not retroactively change if a hire happens while the transaction waits.
 -- Eligibility is rechecked for removals/disabling, never to expand the captured set.
 PERFORM 1 FROM public.users WHERE id=ANY(recipients) ORDER BY id FOR UPDATE;
 IF (SELECT count(*) FROM public.users u JOIN public.employee_profiles ep ON ep.user_id=u.id WHERE u.id=ANY(recipients) AND u.role='EMPLOYEE' AND u.disabled_at IS NULL AND ep.employment_status='ACTIVE' AND ep.start_date<=(snapshot_at AT TIME ZONE 'Asia/Manila')::date)<>cardinality(recipients) THEN RAISE EXCEPTION 'Employee unavailable' USING ERRCODE='22023';END IF;
 PERFORM 1 FROM public.projects WHERE id=pid AND status IN ('ACTIVE','PLANNING','ON_HOLD') FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Project unavailable' USING ERRCODE='P0002';END IF;
 INSERT INTO public.tasks(id,task_number,project_id,title,instructions,reference_links,due_at,priority,assignment_mode,created_by,status_changed_by,recipient_snapshot_at,creation_key,creation_fingerprint)
 VALUES(target,'TSK-'||upper(replace(target::text,'-','')),pid,data->>'title',coalesce(data->>'instructions',''),coalesce(data->'references','[]'),(data->>'dueAt')::timestamptz,coalesce(data->>'priority','NORMAL'),mode,actor,actor,snapshot_at,key,fingerprint);
 INSERT INTO public.task_assignments(task_id,employee_id,assigned_by,assignment_origin,status_changed_by) SELECT target,x,actor,'INITIAL',actor FROM unnest(recipients) x;
 PERFORM private.work_audit('task.created',jsonb_build_object('task_id',target,'project_id',pid,'assignment_mode',mode,'recipient_count',cardinality(recipients),'snapshot_at',snapshot_at));
 PERFORM private.work_audit('assignment.created',jsonb_build_object('task_id',target,'assignment_id',a.id,'employee_id',a.employee_id,'to','PENDING')) FROM public.task_assignments a WHERE a.task_id=target;
 RETURN target;
END $$;
CREATE FUNCTION private.edit_task(target uuid,expected integer,data jsonb,note text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid;t public.tasks%ROWTYPE;afterrow public.tasks%ROWTYPE;
BEGIN
 actor=private.lock_work(true);PERFORM private.work_note(note);t=private.lock_task(target);
 IF expected IS DISTINCT FROM t.version THEN RAISE EXCEPTION 'Version conflict' USING ERRCODE='40001';END IF;
 UPDATE public.tasks SET title=coalesce(data->>'title',title),instructions=coalesce(data->>'instructions',instructions),reference_links=coalesce(data->'references',reference_links),
 due_at=CASE WHEN data ? 'dueAt' THEN (data->>'dueAt')::timestamptz ELSE due_at END,priority=coalesce(data->>'priority',priority),updated_at=private.security_now(),version=version+1 WHERE id=target RETURNING * INTO afterrow;
 PERFORM private.work_audit('task.updated',jsonb_build_object('task_id',target,'before',to_jsonb(t)-'creation_fingerprint','after',to_jsonb(afterrow)-'creation_fingerprint','reason',note));
END $$;
CREATE FUNCTION private.task_progress(target uuid,expected integer,next_state text,note text DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid;t public.tasks%ROWTYPE;a public.task_assignments%ROWTYPE;admin boolean;
BEGIN
 actor=private.lock_work();admin=private.is_admin();t=private.lock_task(target);
 IF next_state IS NULL OR next_state NOT IN ('PENDING','IN_PROGRESS','CANCELLED') THEN RAISE EXCEPTION 'Review workflow is unavailable in 3a' USING ERRCODE='22023';END IF;
 IF admin THEN
  PERFORM private.work_note(note);
  IF expected IS DISTINCT FROM t.version THEN RAISE EXCEPTION 'Version conflict' USING ERRCODE='40001';END IF;
  IF NOT ((t.status IN ('PENDING','IN_PROGRESS') AND next_state='CANCELLED') OR (t.status='CANCELLED' AND next_state='PENDING')) THEN RAISE EXCEPTION 'Invalid administrator transition' USING ERRCODE='22023';END IF;
  IF next_state='PENDING' AND ((SELECT status FROM public.projects WHERE id=t.project_id)<>'ACTIVE' OR NOT EXISTS(SELECT 1 FROM public.task_assignments WHERE task_id=target AND access_revoked_at IS NULL)) THEN RAISE EXCEPTION 'Active project and recipients required' USING ERRCODE='22023';END IF;
  FOR a IN SELECT * FROM public.task_assignments WHERE task_id=target AND access_revoked_at IS NULL ORDER BY id FOR UPDATE LOOP
   IF a.status=next_state THEN CONTINUE;END IF;
   UPDATE public.task_assignments SET status=next_state,counts_for_completion=next_state<>'CANCELLED',status_changed_by=actor,status_changed_at=private.security_now(),updated_at=private.security_now(),version=version+1 WHERE id=a.id;
   PERFORM private.work_audit('assignment.status',jsonb_build_object('task_id',target,'assignment_id',a.id,'employee_id',a.employee_id,'from',a.status,'to',next_state,'reason',note,'version',a.version+1));
  END LOOP;
  UPDATE public.tasks SET status=next_state,status_changed_by=actor,status_changed_at=private.security_now(),updated_at=private.security_now(),version=version+1 WHERE id=target;
  PERFORM private.work_audit('task.status',jsonb_build_object('task_id',target,'from',t.status,'to',next_state,'reason',note,'version',t.version+1));
 ELSE
  SELECT * INTO a FROM public.task_assignments WHERE task_id=target AND employee_id=actor AND access_revoked_at IS NULL FOR UPDATE;
  IF a.id IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
  IF expected IS DISTINCT FROM a.version THEN RAISE EXCEPTION 'Version conflict' USING ERRCODE='40001';END IF;
  IF (SELECT status FROM public.projects WHERE id=t.project_id)<>'ACTIVE' OR t.status='CANCELLED' OR a.status<>'PENDING' OR next_state<>'IN_PROGRESS' THEN RAISE EXCEPTION 'Progress is read-only or transition invalid' USING ERRCODE='22023';END IF;
  UPDATE public.task_assignments SET status='IN_PROGRESS',status_changed_by=actor,status_changed_at=private.security_now(),updated_at=private.security_now(),version=version+1 WHERE id=a.id;
  PERFORM private.work_audit('assignment.status',jsonb_build_object('task_id',target,'assignment_id',a.id,'employee_id',actor,'from',a.status,'to','IN_PROGRESS','version',a.version+1));
  PERFORM private.refresh_task(target);
 END IF;
END $$;
CREATE FUNCTION private.task_membership(target uuid,expected integer,add_ids uuid[],remove_ids uuid[],note text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid;t public.tasks%ROWTYPE;a public.task_assignments%ROWTYPE;who uuid;cap integer;
BEGIN
 IF add_ids IS NULL OR remove_ids IS NULL OR cardinality(add_ids)+cardinality(remove_ids) NOT BETWEEN 1 AND 1000 OR array_position(add_ids,NULL) IS NOT NULL OR array_position(remove_ids,NULL) IS NOT NULL OR add_ids&&remove_ids OR cardinality(add_ids)<>(SELECT count(DISTINCT x) FROM unnest(add_ids)x) OR cardinality(remove_ids)<>(SELECT count(DISTINCT x) FROM unnest(remove_ids)x) THEN RAISE EXCEPTION 'Invalid membership set' USING ERRCODE='22023';END IF;
 actor=private.lock_work(true,add_ids||remove_ids);PERFORM private.work_note(note);t=private.lock_task(target);
 IF expected IS DISTINCT FROM t.version THEN RAISE EXCEPTION 'Version conflict' USING ERRCODE='40001';END IF;
 cap=private.recipient_cap();
 IF cap IS NULL OR cap NOT BETWEEN 1 AND 500 OR cardinality(add_ids)>cap OR cardinality(remove_ids)>500 OR t.status='CANCELLED' THEN RAISE EXCEPTION 'Task is closed or capacity exceeded' USING ERRCODE='22023';END IF;
 IF (SELECT count(*) FROM public.users u JOIN public.employee_profiles p ON p.user_id=u.id WHERE u.id=ANY(add_ids) AND u.role='EMPLOYEE' AND u.disabled_at IS NULL AND p.employment_status='ACTIVE' AND p.start_date<=(private.security_now() AT TIME ZONE 'Asia/Manila')::date)<>cardinality(add_ids) THEN RAISE EXCEPTION 'Employee unavailable' USING ERRCODE='22023';END IF;
 FOREACH who IN ARRAY remove_ids LOOP
  SELECT * INTO a FROM public.task_assignments WHERE task_id=target AND employee_id=who AND access_revoked_at IS NULL FOR UPDATE;
  IF a.id IS NULL THEN RAISE EXCEPTION 'Assignment unavailable' USING ERRCODE='22023';END IF;
  UPDATE public.task_assignments SET access_revoked_at=private.security_now(),access_revoked_by=actor,revocation_reason=note,status='CANCELLED',counts_for_completion=false,status_changed_by=actor,status_changed_at=private.security_now(),updated_at=private.security_now(),version=version+1 WHERE id=a.id;
  PERFORM private.work_audit('assignment.withdrawn',jsonb_build_object('task_id',target,'assignment_id',a.id,'employee_id',who,'from',a.status,'to','CANCELLED','reason',note,'version',a.version+1));
 END LOOP;
 FOREACH who IN ARRAY add_ids LOOP
  SELECT * INTO a FROM public.task_assignments WHERE task_id=target AND employee_id=who FOR UPDATE;
  IF a.id IS NOT NULL AND a.access_revoked_at IS NULL THEN RAISE EXCEPTION 'Already assigned' USING ERRCODE='22023';END IF;
  IF a.id IS NULL THEN
   INSERT INTO public.task_assignments(task_id,employee_id,assigned_by,assignment_origin,status_changed_by) VALUES(target,who,actor,'ADMIN_ADDED',actor) RETURNING * INTO a;
  ELSE
   UPDATE public.task_assignments SET access_revoked_at=NULL,access_revoked_by=NULL,revocation_reason=NULL,status='PENDING',counts_for_completion=true,status_changed_by=actor,status_changed_at=private.security_now(),updated_at=private.security_now(),version=version+1 WHERE id=a.id RETURNING * INTO a;
  END IF;
  PERFORM private.work_audit('assignment.added',jsonb_build_object('task_id',target,'assignment_id',a.id,'employee_id',who,'to','PENDING','reason',note,'version',a.version));
 END LOOP;
 IF (SELECT count(*) FROM public.task_assignments WHERE task_id=target AND access_revoked_at IS NULL)>cap THEN RAISE EXCEPTION 'Recipient capacity exceeded' USING ERRCODE='22023';END IF;
 UPDATE public.tasks SET membership_version=membership_version+1 WHERE id=target;
 PERFORM private.refresh_task(target,note);
END $$;
CREATE FUNCTION private.add_task_comment(target uuid,data jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid;t public.tasks%ROWTYPE;previous public.task_comments%ROWTYPE;fingerprint text;key uuid=(data->>'creationKey')::uuid;result uuid;
BEGIN
 actor=private.lock_work();t=private.lock_task(target);fingerprint=private.work_fingerprint(jsonb_build_object('task_id',target,'body',data->>'body'));
 SELECT * INTO previous FROM public.task_comments WHERE author_id=actor AND creation_key=key;
 IF previous.id IS NOT NULL THEN
  IF previous.creation_fingerprint<>fingerprint THEN RAISE EXCEPTION 'Retry key conflict' USING ERRCODE='40001';END IF;RETURN previous.id;
 END IF;
 IF (SELECT status FROM public.projects WHERE id=t.project_id)<>'ACTIVE' OR t.status='CANCELLED' THEN RAISE EXCEPTION 'Comments are read-only' USING ERRCODE='22023';END IF;
 INSERT INTO public.task_comments(task_id,author_id,body,creation_key,creation_fingerprint) VALUES(target,actor,data->>'body',key,fingerprint) RETURNING id INTO result;
 PERFORM private.refresh_task(target);
 PERFORM private.work_audit('task.comment_added',jsonb_build_object('task_id',target,'comment_id',result));RETURN result;
END $$;
-- An acknowledgment contains observed versions, never a caller-provided timestamp.
CREATE FUNCTION private.task_list_seen(observations jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid;item jsonb;a public.task_assignments%ROWTYPE;t public.tasks%ROWTYPE;pv integer;
BEGIN
 actor=private.lock_work();
 IF private.is_admin() OR observations IS NULL OR jsonb_typeof(observations)<>'array' OR jsonb_array_length(observations)>50 THEN RAISE EXCEPTION 'Invalid list visit' USING ERRCODE='22023';END IF;
 -- Each statement only updates own markers, never membership or progress; task rows stay unlocked.
 FOR item IN SELECT * FROM jsonb_array_elements(observations) LOOP
  SELECT * INTO a FROM public.task_assignments WHERE id=(item->>'assignmentId')::uuid AND employee_id=actor AND access_revoked_at IS NULL FOR UPDATE;
  IF a.id IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
  SELECT * INTO t FROM public.tasks WHERE id=a.task_id;SELECT version INTO pv FROM public.projects WHERE id=t.project_id;
  IF (item->>'taskVersion')::int NOT BETWEEN 1 AND t.version OR (item->>'projectVersion')::int NOT BETWEEN 1 AND pv OR (item->>'assignmentVersion')::int NOT BETWEEN 1 AND a.version OR NOT(item ?& ARRAY['taskVersion','projectVersion','assignmentVersion']) THEN RAISE EXCEPTION 'Invalid observed version' USING ERRCODE='22023';END IF;
  UPDATE public.task_assignments SET seen_task_version=greatest(seen_task_version,(item->>'taskVersion')::int),seen_project_version=greatest(seen_project_version,(item->>'projectVersion')::int),seen_assignment_version=greatest(seen_assignment_version,(item->>'assignmentVersion')::int),last_list_seen_at=private.security_now() WHERE id=a.id;
 END LOOP;
END $$;
-- Minimal labels and safe status history without granting a DUTY employee profile/audit SELECT.
CREATE FUNCTION private.work_comments(target uuid,skip integer DEFAULT 0) RETURNS TABLE(id uuid,body text,created_at timestamptz,author_label text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF private.work_actor() IS NULL THEN RAISE EXCEPTION 'Work access required' USING ERRCODE='42501';END IF;
 IF NOT private.can_task(target) OR NOT EXISTS(SELECT 1 FROM public.tasks WHERE tasks.id=target) THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
 RETURN QUERY SELECT c.id,c.body,c.created_at,CASE WHEN u.role='ADMINISTRATOR' THEN 'Administrator' ELSE p.display_name END FROM public.task_comments c JOIN public.users u ON u.id=c.author_id LEFT JOIN public.employee_profiles p ON p.user_id=u.id WHERE c.task_id=target ORDER BY c.created_at DESC,c.id LIMIT 50 OFFSET greatest(0,least(skip,100000));
END $$;
CREATE FUNCTION private.work_history(target uuid) RETURNS TABLE(action text,occurred_at timestamptz,actor_label text,from_status text,to_status text,reason text,assignment_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid=private.work_actor();admin boolean=private.is_admin();
BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION 'Work access required' USING ERRCODE='42501';END IF;
 IF NOT private.can_task(target) OR NOT EXISTS(SELECT 1 FROM public.tasks WHERE id=target) THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
 RETURN QUERY SELECT l.action,l.occurred_at,CASE WHEN u.role='ADMINISTRATOR' THEN 'Administrator' ELSE p.display_name END,l.payload->>'from',l.payload->>'to',l.payload->>'reason',(l.payload->>'assignment_id')::uuid
 FROM public.audit_log l LEFT JOIN public.users u ON u.id=l.actor_user_id LEFT JOIN public.employee_profiles p ON p.user_id=u.id
 WHERE l.payload->>'task_id'=target::text AND l.action IN ('task.status','assignment.status','assignment.created','assignment.added','assignment.withdrawn')
 AND (admin OR l.action='task.status' OR l.payload->>'employee_id'=actor::text) ORDER BY l.occurred_at DESC,l.id LIMIT 100;
END $$;
-- Explicit public API; internal helpers remain owner-only.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.create_project(jsonb),private.edit_project(uuid,integer,jsonb,text),private.create_task(jsonb),private.edit_task(uuid,integer,jsonb,text),private.task_progress(uuid,integer,text,text),private.task_membership(uuid,integer,uuid[],uuid[],text),private.add_task_comment(uuid,jsonb),private.task_list_seen(jsonb),private.work_comments(uuid,integer),private.work_history(uuid) TO libetario_runtime;
COMMIT;
