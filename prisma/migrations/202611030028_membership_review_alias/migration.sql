BEGIN;
CREATE OR REPLACE FUNCTION private.task_membership(target uuid,expected integer,add_ids uuid[],remove_ids uuid[],note text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid;t public.tasks%ROWTYPE;a public.task_assignments%ROWTYPE;who uuid;cap integer;reopening boolean=false;
BEGIN
 IF add_ids IS NULL OR remove_ids IS NULL OR cardinality(add_ids)+cardinality(remove_ids) NOT BETWEEN 1 AND 1000 OR array_position(add_ids,NULL) IS NOT NULL OR array_position(remove_ids,NULL) IS NOT NULL OR add_ids&&remove_ids OR cardinality(add_ids)<>(SELECT count(DISTINCT x) FROM unnest(add_ids)x) OR cardinality(remove_ids)<>(SELECT count(DISTINCT x) FROM unnest(remove_ids)x) THEN RAISE EXCEPTION 'Invalid membership set' USING ERRCODE='22023';END IF;
 actor=private.lock_work(true,add_ids||remove_ids);PERFORM private.work_note(note);t=private.lock_task(target);
 IF expected IS DISTINCT FROM t.version THEN RAISE EXCEPTION 'Version conflict' USING ERRCODE='40001';END IF;
 cap=private.recipient_cap();
 IF cap IS NULL OR cap NOT BETWEEN 1 AND 500 OR cardinality(add_ids)>cap OR cardinality(remove_ids)>500 THEN RAISE EXCEPTION 'Task is closed or capacity exceeded' USING ERRCODE='22023';END IF;
 IF t.status='APPROVED' AND EXISTS(SELECT 1 FROM unnest(add_ids) x LEFT JOIN public.task_assignments member0 ON member0.task_id=target AND member0.employee_id=x WHERE member0.id IS NULL OR member0.status<>'APPROVED' OR member0.access_revoked_at IS NULL) THEN RAISE EXCEPTION 'Approved task cannot acquire work' USING ERRCODE='22023';END IF;
 IF t.status='CANCELLED' THEN
  IF cardinality(add_ids)=0 OR EXISTS(SELECT 1 FROM public.task_assignments WHERE task_id=target AND access_revoked_at IS NULL) OR (SELECT status FROM public.projects WHERE id=t.project_id)<>'ACTIVE' THEN RAISE EXCEPTION 'Explicit task restoration required' USING ERRCODE='22023';END IF;
  reopening=true;
 END IF;
 IF (SELECT count(*) FROM public.users u JOIN public.employee_profiles p ON p.user_id=u.id WHERE u.id=ANY(add_ids) AND u.role='EMPLOYEE' AND u.disabled_at IS NULL AND p.employment_status='ACTIVE' AND p.start_date<=(private.security_now() AT TIME ZONE 'Asia/Manila')::date)<>cardinality(add_ids) THEN RAISE EXCEPTION 'Employee unavailable' USING ERRCODE='22023';END IF;
 FOREACH who IN ARRAY remove_ids LOOP
  SELECT * INTO a FROM public.task_assignments WHERE task_id=target AND employee_id=who AND access_revoked_at IS NULL FOR UPDATE;
  IF a.id IS NULL THEN RAISE EXCEPTION 'Assignment unavailable' USING ERRCODE='22023';END IF;
  UPDATE public.task_assignments SET access_revoked_at=private.security_now(),access_revoked_by=actor,revocation_reason=note,status=CASE WHEN a.status='APPROVED' THEN 'APPROVED' ELSE 'CANCELLED' END,counts_for_completion=a.status='APPROVED',current_submission_id=CASE WHEN a.status='APPROVED' THEN current_submission_id END,status_changed_by=CASE WHEN a.status='APPROVED' THEN status_changed_by ELSE actor END,status_changed_at=CASE WHEN a.status='APPROVED' THEN status_changed_at ELSE private.security_now() END,updated_at=private.security_now(),version=version+1 WHERE id=a.id;
  UPDATE public.task_submissions SET state='ABANDONED',version=version+1,updated_at=private.security_now() WHERE assignment_id=a.id AND state='DRAFT';
  PERFORM private.work_audit('assignment.withdrawn',jsonb_build_object('task_id',target,'assignment_id',a.id,'employee_id',who,'from',a.status,'to',CASE WHEN a.status='APPROVED' THEN 'APPROVED' ELSE 'CANCELLED' END,'reason',note,'version',a.version+1));
 END LOOP;
 FOREACH who IN ARRAY add_ids LOOP
  SELECT * INTO a FROM public.task_assignments WHERE task_id=target AND employee_id=who FOR UPDATE;
  IF a.id IS NOT NULL AND a.access_revoked_at IS NULL THEN RAISE EXCEPTION 'Already assigned' USING ERRCODE='22023';END IF;
  IF a.id IS NULL THEN
   INSERT INTO public.task_assignments(task_id,employee_id,assigned_by,assignment_origin,status_changed_by) VALUES(target,who,actor,'ADMIN_ADDED',actor) RETURNING * INTO a;
  ELSE
   UPDATE public.task_assignments SET access_revoked_at=NULL,access_revoked_by=NULL,revocation_reason=NULL,status=CASE WHEN a.status='APPROVED' THEN 'APPROVED' ELSE 'PENDING' END,counts_for_completion=true,status_changed_by=CASE WHEN a.status='APPROVED' THEN status_changed_by ELSE actor END,status_changed_at=CASE WHEN a.status='APPROVED' THEN status_changed_at ELSE private.security_now() END,updated_at=private.security_now(),version=version+1 WHERE id=a.id RETURNING * INTO a;
  END IF;
  PERFORM private.work_audit('assignment.added',jsonb_build_object('task_id',target,'assignment_id',a.id,'employee_id',who,'to',a.status,'reason',note,'version',a.version));
 END LOOP;
 IF cardinality(add_ids)>0 AND (SELECT count(*) FROM public.task_assignments WHERE task_id=target AND access_revoked_at IS NULL)>cap THEN RAISE EXCEPTION 'Recipient capacity exceeded' USING ERRCODE='22023';END IF;
 IF reopening THEN
  UPDATE public.tasks SET status='PENDING',status_changed_by=actor,status_changed_at=private.security_now() WHERE id=target;
  PERFORM private.work_audit('task.status',jsonb_build_object('task_id',target,'from','CANCELLED','to','PENDING','reason',note,'version',t.version+1));
 END IF;
 UPDATE public.tasks SET membership_version=membership_version+1 WHERE id=target;
 PERFORM private.refresh_task(target,note);
END $$;
COMMIT;
