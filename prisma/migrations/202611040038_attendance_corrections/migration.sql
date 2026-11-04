BEGIN;
CREATE FUNCTION private.attendance_proposal(data jsonb,target uuid,cfg jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE start_at timestamptz=(data->>'clockedInAt')::timestamptz;end_at timestamptz=(data->>'clockedOutAt')::timestamptz;item jsonb;items jsonb;result jsonb='[]';b public.attendance_breaks%ROWTYPE;rule jsonb;bid uuid;bs timestamptz;be timestamptz;seen uuid[]='{}';is_new boolean;
BEGIN
 IF start_at IS NULL OR end_at IS NULL OR end_at<start_at OR end_at>private.security_now() OR start_at<'2000-01-01' OR end_at>='2100-01-01' THEN RAISE EXCEPTION 'Closed past endpoints required' USING ERRCODE='22023';END IF;
 items=data->'breaks';
 IF items IS NULL THEN SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'code',code,'startedAt',started_at,'endedAt',ended_at,'voided',is_voided)),'[]') INTO items FROM attendance_breaks WHERE shift_id=target;END IF;
 IF jsonb_typeof(items)<>'array' OR jsonb_array_length(items)>100 THEN RAISE EXCEPTION 'Invalid break change set' USING ERRCODE='22023';END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(items) LOOP
  bs=(item->>'startedAt')::timestamptz;be=(item->>'endedAt')::timestamptz;bid=(item->>'id')::uuid;is_new=bid IS NULL;
  IF NOT is_new THEN SELECT * INTO b FROM attendance_breaks WHERE id=bid AND shift_id=target;IF b.id IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;IF bid=ANY(seen) THEN RAISE EXCEPTION 'Duplicate break' USING ERRCODE='22023';END IF;seen=array_append(seen,bid);ELSE bid=gen_random_uuid();END IF;
  rule=(SELECT x FROM jsonb_array_elements(cfg->'breakCodes')x WHERE x->>'code'=item->>'code');
  IF rule IS NULL OR bs IS NULL OR be IS NULL OR be<bs OR be>private.security_now() OR (NOT coalesce((item->>'voided')::boolean,false) AND (bs<start_at OR be>end_at)) THEN RAISE EXCEPTION 'Invalid break endpoints/code' USING ERRCODE='22023';END IF;
  IF is_new AND coalesce((item->>'voided')::boolean,false) THEN RAISE EXCEPTION 'Cannot void a nonexistent break' USING ERRCODE='22023';END IF;
  result=result||jsonb_build_array(jsonb_build_object('id',bid,'new',is_new,'code',item->>'code','paid',(rule->>'paid')::boolean,'allowanceSeconds',rule->'allowanceSeconds','startedAt',bs,'endedAt',be,'voided',coalesce((item->>'voided')::boolean,false)));
 END LOOP;
 IF EXISTS(SELECT 1 FROM attendance_breaks WHERE shift_id=target AND NOT id=ANY(seen)) THEN RAISE EXCEPTION 'Preserve or explicitly void every existing break' USING ERRCODE='22023';END IF;
 RETURN jsonb_build_object('clockedInAt',start_at,'clockedOutAt',end_at,'breaks',result);
END $$;
CREATE FUNCTION private.attendance_request(data jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid=private.work_actor();who uuid;target uuid=(data->>'shiftId')::uuid;did uuid=(data->>'dutyId')::uuid;kind text=data->>'kind';key uuid=(data->>'operationKey')::uuid;fp text;old public.attendance_adjustments%ROWTYPE;s public.attendance_shifts%ROWTYPE;d public.duty_authorizations%ROWTYPE;cfg jsonb;proposed jsonb;result uuid;
BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION 'Work permission required' USING ERRCODE='42501';END IF;PERFORM private.attendance_note(data->>'reason');
 IF key IS NULL OR kind IS NULL OR kind NOT IN('AMEND_SHIFT','ADD_MISSING_SHIFT') OR (kind='AMEND_SHIFT' AND (target IS NULL OR did IS NOT NULL)) OR (kind='ADD_MISSING_SHIFT' AND (did IS NULL OR target IS NOT NULL)) THEN RAISE EXCEPTION 'Invalid correction target' USING ERRCODE='22023';END IF;
 IF kind='AMEND_SHIFT' THEN SELECT employee_id,duty_id INTO who,did FROM attendance_shifts WHERE id=target;ELSE SELECT employee_id INTO who FROM duty_authorizations WHERE id=did;END IF;
 IF who IS NULL OR NOT private.attendance_visible(who) THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
 PERFORM private.attendance_lock(who,private.is_admin(),private.is_admin());
 fp=private.work_fingerprint(data||jsonb_build_object('reason',btrim(data->>'reason')));
 SELECT * INTO old FROM attendance_adjustments WHERE requested_by=actor AND request_key=key;
 IF old.id IS NOT NULL THEN IF old.fingerprint<>fp THEN RAISE EXCEPTION 'Retry conflict' USING ERRCODE='40001';END IF;RETURN old.id;END IF;
 SELECT * INTO d FROM duty_authorizations WHERE id=did FOR UPDATE;
 IF kind='AMEND_SHIFT' THEN
  SELECT * INTO s FROM attendance_shifts WHERE id=target FOR UPDATE;
  PERFORM 1 FROM attendance_breaks WHERE shift_id=target ORDER BY id FOR UPDATE;
  IF s.version IS DISTINCT FROM (data->>'expectedVersion')::int THEN RAISE EXCEPTION 'Version conflict' USING ERRCODE='40001';END IF;
  cfg=s.policy_snapshot;
 ELSE cfg=private.attendance_policy();END IF;
 proposed=private.attendance_proposal(data->'proposed',target,cfg);
 IF private.work_actor() IS DISTINCT FROM actor OR (private.is_admin() AND NOT private.admin_recent()) THEN RAISE EXCEPTION 'Current permission required' USING ERRCODE='42501';END IF;
 INSERT INTO attendance_adjustments(employee_id,duty_id,kind,target_shift_id,requested_by,reason,target_version,original_values,proposed_values,grant_snapshot,request_key,fingerprint)
 VALUES(who,did,kind,target,actor,btrim(data->>'reason'),CASE WHEN target IS NOT NULL THEN s.version END,coalesce(private.attendance_snapshot(target),jsonb_build_object('shiftExists',false)),proposed,
 CASE WHEN target IS NOT NULL THEN jsonb_build_object('version',s.duty_authorization_version,'date',s.duty_date,'from',s.grant_from,'until',s.grant_until,'policy',cfg) ELSE jsonb_build_object('version',d.authorization_version,'date',d.duty_date,'from',d.valid_from,'until',d.valid_until,'policy',cfg,'schedule',private.attendance_schedule(who,d.duty_date)) END,key,fp) RETURNING id INTO result;
 PERFORM private.attendance_audit('attendance.correction_requested',jsonb_build_object('adjustment_id',result,'shift_id',target,'employee_id',who,'kind',kind,'reason',data->>'reason'));RETURN result;
END $$;
CREATE FUNCTION private.attendance_decide(target uuid,data jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.attendance_adjustments%ROWTYPE;s public.attendance_shifts%ROWTYPE;who uuid;actor uuid;d public.duty_authorizations%ROWTYPE;start_at timestamptz;end_at timestamptz;t timestamptz;sid uuid;before_values jsonb;cfg jsonb;item jsonb;bid uuid;allowance integer;note text=btrim(data->>'reason');decision text=data->>'decision';key uuid=(data->>'operationKey')::uuid;fp text;
BEGIN
 IF NOT private.is_admin() THEN RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501';END IF;
 SELECT employee_id INTO who FROM attendance_adjustments WHERE id=target;IF who IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
 actor=private.attendance_lock(who,true,true);
 SELECT * INTO a FROM attendance_adjustments WHERE id=target;
 SELECT * INTO d FROM duty_authorizations WHERE id=a.duty_id FOR UPDATE;
 IF a.target_shift_id IS NOT NULL THEN SELECT * INTO s FROM attendance_shifts WHERE id=a.target_shift_id FOR UPDATE;PERFORM 1 FROM attendance_breaks WHERE shift_id=s.id ORDER BY id FOR UPDATE;END IF;
 SELECT * INTO a FROM attendance_adjustments WHERE id=target FOR UPDATE;
 PERFORM private.attendance_note(note);
 IF NOT private.admin_recent() OR key IS NULL THEN RAISE EXCEPTION 'Recent MFA required' USING ERRCODE='42501';END IF;
 fp=private.work_fingerprint(data||jsonb_build_object('reason',note));
 IF a.status<>'PENDING' THEN IF a.review_key=key AND a.review_fingerprint=fp THEN RETURN coalesce(a.applied_shift_id,a.target_shift_id,a.id);END IF;RAISE EXCEPTION 'Already decided' USING ERRCODE='40001';END IF;
 IF a.version IS DISTINCT FROM (data->>'expectedVersion')::int OR decision IS NULL OR decision NOT IN('APPROVED','REJECTED') THEN RAISE EXCEPTION 'Invalid or stale decision' USING ERRCODE='40001';END IF;
 t=private.security_now();
 IF decision='REJECTED' THEN
  UPDATE attendance_adjustments SET status='REJECTED',reviewed_by=actor,reviewed_at=t,review_reason=note,review_key=key,review_fingerprint=fp,version=version+1 WHERE id=target;
  PERFORM private.attendance_audit('attendance.correction_rejected',jsonb_build_object('adjustment_id',target,'employee_id',who,'reason',note));RETURN coalesce(a.target_shift_id,a.id);
 END IF;
 IF a.kind='AMEND_SHIFT' AND s.version IS DISTINCT FROM a.target_version THEN RAISE EXCEPTION 'Punch changed since request; reject or replace proposal' USING ERRCODE='40001';END IF;
 IF a.kind='ADD_MISSING_SHIFT' AND (d.authorization_version IS DISTINCT FROM (a.grant_snapshot->>'version')::int OR d.valid_from IS DISTINCT FROM (a.grant_snapshot->>'from')::timestamptz OR d.valid_until IS DISTINCT FROM (a.grant_snapshot->>'until')::timestamptz) THEN RAISE EXCEPTION 'Historical grant changed; verification and replacement required' USING ERRCODE='40001';END IF;
 start_at=(a.proposed_values->>'clockedInAt')::timestamptz;end_at=(a.proposed_values->>'clockedOutAt')::timestamptz;
 IF start_at<(a.grant_snapshot->>'from')::timestamptz OR start_at>=(a.grant_snapshot->>'until')::timestamptz OR end_at>(a.grant_snapshot->>'until')::timestamptz OR end_at>t THEN RAISE EXCEPTION 'Proposal outside verified window; claim retained for review' USING ERRCODE='22023';END IF;
 SET CONSTRAINTS ALL DEFERRED;
 cfg=a.grant_snapshot->'policy';
 IF a.kind='ADD_MISSING_SHIFT' THEN
  sid=gen_random_uuid();before_values=jsonb_build_object('shiftExists',false);
  INSERT INTO attendance_shifts(id,employee_id,duty_id,duty_authorization_version,duty_date,grant_from,grant_until,shift_number,clocked_in_at,clocked_out_at,source,close_source,close_reason,closed_by,origin_adjustment_id,policy_id,policy_snapshot,schedule_id,weekday,schedule_snapshot,flags)
  VALUES(sid,who,a.duty_id,(a.grant_snapshot->>'version')::int,(a.grant_snapshot->>'date')::date,(a.grant_snapshot->>'from')::timestamptz,(a.grant_snapshot->>'until')::timestamptz,(SELECT coalesce(max(shift_number),0)+1 FROM attendance_shifts WHERE duty_id=a.duty_id),start_at,end_at,'CORRECTION','CORRECTION','APPROVED_CORRECTION',actor,a.id,(cfg->>'policyId')::uuid,cfg,(a.grant_snapshot->'schedule'->>'id')::uuid,(a.grant_snapshot->'schedule'->>'weekday')::int,nullif(a.grant_snapshot->'schedule','null'::jsonb),ARRAY['MISSING_PUNCH','CORRECTED']);
 ELSE
  sid=s.id;before_values=private.attendance_snapshot(sid);
  IF s.clocked_out_at IS NULL THEN PERFORM private.attendance_force_close(sid,t,'ADMIN_CORRECTION_REVIEW');END IF;
  UPDATE attendance_shifts SET clocked_in_at=start_at,clocked_out_at=end_at,close_source='CORRECTION',close_reason='APPROVED_CORRECTION',closed_by=actor,approval_status='PENDING',approved_payable_seconds=NULL,suggested_at_review=NULL,review_mode=NULL,reviewed_by=NULL,reviewed_at=NULL,review_reason=NULL,acknowledged_flags='{}',flags=flags||ARRAY['CORRECTED'],version=version+1,updated_at=t WHERE id=sid;
 END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(a.proposed_values->'breaks') LOOP
  bid=(item->>'id')::uuid;
  allowance=coalesce((item->>'allowanceSeconds')::int,CASE WHEN (item->>'paid')::boolean THEN (s.schedule_snapshot->>'paid_break_seconds')::int ELSE (s.schedule_snapshot->>'unpaid_break_seconds')::int END);
  IF (item->>'new')::boolean THEN
   INSERT INTO attendance_breaks(id,shift_id,employee_id,started_at,ended_at,code,paid,recorded_code,recorded_paid,allowance_seconds,policy_id,source,origin_adjustment_id,last_adjustment_id,end_reason,ended_by)
   VALUES(bid,sid,who,(item->>'startedAt')::timestamptz,(item->>'endedAt')::timestamptz,item->>'code',(item->>'paid')::boolean,item->>'code',(item->>'paid')::boolean,allowance,(cfg->>'policyId')::uuid,'CORRECTION',a.id,a.id,'APPROVED_CORRECTION',actor);
  ELSE
   UPDATE attendance_breaks SET started_at=(item->>'startedAt')::timestamptz,ended_at=(item->>'endedAt')::timestamptz,code=item->>'code',paid=(item->>'paid')::boolean,allowance_seconds=allowance,is_voided=(item->>'voided')::boolean,last_adjustment_id=a.id,end_reason='APPROVED_CORRECTION',ended_by=actor,version=version+1,updated_at=t WHERE id=bid AND shift_id=sid;
   IF NOT FOUND THEN RAISE EXCEPTION 'Break ownership changed' USING ERRCODE='P0002';END IF;
  END IF;
 END LOOP;
 UPDATE attendance_shifts SET flags=array_remove(private.attendance_flags(sid,t),'CORRECTION_PENDING') WHERE id=sid;
 UPDATE attendance_adjustments SET status='APPROVED',reviewed_by=actor,reviewed_at=t,review_reason=note,applied_shift_id=sid,applied_before=before_values,applied_after=private.attendance_snapshot(sid),review_key=key,review_fingerprint=fp,version=version+1 WHERE id=target;
 PERFORM private.attendance_audit('attendance.correction_approved',jsonb_build_object('adjustment_id',target,'shift_id',sid,'employee_id',who,'reason',note,'before',before_values,'after',private.attendance_snapshot(sid)));RETURN sid;
END $$;
CREATE FUNCTION private.attendance_corrections(filters jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid=private.work_actor();who uuid=(filters->>'employeeId')::uuid;first_day date=coalesce((filters->>'from')::date,(private.security_now() AT TIME ZONE 'Asia/Manila')::date);last_day date=coalesce((filters->>'to')::date,first_day);page_number integer=coalesce((filters->>'page')::int,1);items jsonb;n integer;
BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION 'Work permission required' USING ERRCODE='42501';END IF;
 IF who IS NOT NULL AND NOT private.attendance_visible(who) THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
 IF last_day<first_day OR last_day-first_day>=31 OR page_number NOT BETWEEN 1 AND 100000 THEN RAISE EXCEPTION 'Invalid correction filters' USING ERRCODE='22023';END IF;
 SELECT count(*) INTO n FROM attendance_adjustments a JOIN duty_authorizations d ON d.id=a.duty_id WHERE d.duty_date BETWEEN first_day AND last_day AND private.attendance_visible(a.employee_id) AND (who IS NULL OR who=a.employee_id);
 SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC,x.id),'[]') INTO items FROM (SELECT a.*,p.display_name employee_name,d.duty_date FROM attendance_adjustments a JOIN duty_authorizations d ON d.id=a.duty_id JOIN employee_profiles p ON p.user_id=a.employee_id WHERE d.duty_date BETWEEN first_day AND last_day AND private.attendance_visible(a.employee_id) AND (who IS NULL OR who=a.employee_id) ORDER BY a.created_at DESC,a.id LIMIT 50 OFFSET(page_number-1)*50)x;
 RETURN jsonb_build_object('items',items,'total',n,'page',page_number,'asOf',private.security_now());
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.attendance_request(jsonb),private.attendance_decide(uuid,jsonb),private.attendance_corrections(jsonb) TO libetario_runtime;
COMMIT;
