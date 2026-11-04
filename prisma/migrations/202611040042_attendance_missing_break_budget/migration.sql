BEGIN;
CREATE OR REPLACE FUNCTION private.attendance_decide(target uuid,data jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
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
  allowance=coalesce((item->>'allowanceSeconds')::int,CASE WHEN (item->>'paid')::boolean THEN (coalesce(s.schedule_snapshot,a.grant_snapshot->'schedule')->>'paid_break_seconds')::int ELSE (coalesce(s.schedule_snapshot,a.grant_snapshot->'schedule')->>'unpaid_break_seconds')::int END);
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
COMMIT;
