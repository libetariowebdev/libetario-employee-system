BEGIN;
CREATE OR REPLACE FUNCTION private.attendance_review(target uuid,data jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
<<review_scope>>
DECLARE s public.attendance_shifts%ROWTYPE;actor uuid;who uuid;at_time timestamptz;flags text[];value numeric;suggestion numeric;note text=btrim(coalesce(data->>'reason',''));decision text=data->>'decision';mode text=coalesce(data->>'mode','SUGGESTED');key uuid=(data->>'operationKey')::uuid;fp text;before_values jsonb;canonical jsonb=data;
BEGIN
 IF NOT private.is_admin() THEN RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501';END IF;
 SELECT employee_id INTO who FROM attendance_shifts WHERE id=target;IF who IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
 actor=private.attendance_lock(who,true,true);
 PERFORM 1 FROM duty_authorizations WHERE id=(SELECT duty_id FROM attendance_shifts WHERE id=target) FOR UPDATE;
 SELECT * INTO s FROM attendance_shifts WHERE id=target FOR UPDATE;
 PERFORM 1 FROM attendance_breaks WHERE shift_id=target ORDER BY id FOR UPDATE;
 IF NOT private.admin_recent() THEN RAISE EXCEPTION 'Recent MFA required' USING ERRCODE='42501';END IF;
 IF key IS NULL OR decision IS NULL OR decision NOT IN('APPROVED','REJECTED') OR mode NOT IN('SUGGESTED','OVERRIDE') THEN RAISE EXCEPTION 'Invalid review' USING ERRCODE='22023';END IF;
 IF mode='OVERRIDE' THEN
  IF jsonb_typeof(data->'value') IS DISTINCT FROM 'string' OR data->>'value' !~ '^[0-9]{1,14}([.][0-9]{1,6})?$' THEN RAISE EXCEPTION 'Exact decimal seconds required' USING ERRCODE='22023';END IF;
  canonical=canonical||jsonb_build_object('value',(data->>'value')::numeric(20,6)::text);
 END IF;
 fp=private.work_fingerprint(canonical||jsonb_build_object('reason',note));
 IF s.review_receipts ? key::text THEN IF s.review_receipts->key::text->>'fingerprint'<>fp THEN RAISE EXCEPTION 'Retry conflict' USING ERRCODE='40001';END IF;RETURN target;END IF;
 IF s.version IS DISTINCT FROM (data->>'expectedVersion')::int THEN RAISE EXCEPTION 'Version conflict' USING ERRCODE='40001';END IF;
 IF s.clocked_out_at IS NULL OR EXISTS(SELECT 1 FROM attendance_adjustments WHERE target_shift_id=target AND status='PENDING') THEN RAISE EXCEPTION 'Closed shift without pending correction required' USING ERRCODE='22023';END IF;
 at_time=private.security_now();flags=private.attendance_flags(target,at_time);suggestion=private.attendance_suggested(target);
 IF decision='REJECTED' OR mode='OVERRIDE' OR cardinality(flags)>0 THEN PERFORM private.attendance_note(note);ELSIF note='' THEN note='Accepted suggested attendance time';END IF;
 IF cardinality(flags)>0 AND NOT coalesce((data->>'acknowledgeFlags')::boolean,false) THEN RAISE EXCEPTION 'Review and acknowledge every flag' USING ERRCODE='22023';END IF;
 value=CASE WHEN mode='OVERRIDE' THEN (data->>'value')::numeric ELSE suggestion END;
 IF value IS NULL OR value<0 OR value>private.attendance_gross(s,at_time) THEN RAISE EXCEPTION 'Approved value outside gross attendance' USING ERRCODE='22023';END IF;
 before_values=private.attendance_snapshot(target);
 UPDATE attendance_shifts SET approval_status=decision,approved_payable_seconds=CASE WHEN decision='APPROVED' THEN value END,suggested_at_review=suggestion,review_mode=mode,reviewed_by=actor,reviewed_at=at_time,review_reason=note,acknowledged_flags=review_scope.flags,flags=review_scope.flags,
 review_receipts=review_receipts||jsonb_build_object(key::text,jsonb_build_object('fingerprint',fp,'decision',decision,'at',at_time)),version=version+1,updated_at=at_time WHERE id=target;
 PERFORM private.attendance_audit('attendance.'||lower(decision),jsonb_build_object('shift_id',target,'employee_id',who,'mode',mode,'reason',note,'before',before_values,'after',private.attendance_snapshot(target)));RETURN target;
END $$;
COMMIT;
