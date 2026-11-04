BEGIN;
CREATE FUNCTION private.attendance_row(target uuid,at_time timestamptz) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.attendance_shifts%ROWTYPE;result jsonb;
BEGIN
 SELECT * INTO s FROM attendance_shifts WHERE id=target;
 IF s.id IS NULL OR NOT private.attendance_visible(s.employee_id) THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
 SELECT jsonb_build_object('shift',(to_jsonb(s)-'review_receipts')||jsonb_build_object('approved_payable_seconds',s.approved_payable_seconds::text,'suggested_at_review',s.suggested_at_review::text),
 'employee',jsonb_build_object('id',p.user_id,'name',p.display_name,'number',p.employee_number),
 'breaks',coalesce((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.started_at,b.id) FROM attendance_breaks b WHERE b.shift_id=target),'[]'),
 'flags',private.attendance_flags(target,at_time),'grossSeconds',private.attendance_gross(s,at_time)::text,
 'paidBreakSeconds',coalesce((SELECT sum(extract(epoch FROM greatest(b.started_at,coalesce(b.ended_at,least(at_time,s.grant_until)))-b.started_at)) FROM attendance_breaks b WHERE b.shift_id=target AND b.paid AND NOT b.is_voided),0)::text,
 'unpaidBreakSeconds',coalesce((SELECT sum(extract(epoch FROM greatest(b.started_at,coalesce(b.ended_at,least(at_time,s.grant_until)))-b.started_at)) FROM attendance_breaks b WHERE b.shift_id=target AND NOT b.paid AND NOT b.is_voided),0)::text,
 'suggestedSeconds',private.attendance_suggested(target)::text,'asOf',at_time) INTO result FROM employee_profiles p WHERE p.user_id=s.employee_id;
 RETURN result;
END $$;
CREATE FUNCTION private.attendance_filter_ids(filters jsonb,clean_only boolean DEFAULT false) RETURNS uuid[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid=private.work_actor();first_day date=coalesce((filters->>'from')::date,(private.security_now() AT TIME ZONE 'Asia/Manila')::date);last_day date=coalesce((filters->>'to')::date,first_day);who uuid=(filters->>'employeeId')::uuid;cfg jsonb;ids uuid[];
BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION 'Work permission required' USING ERRCODE='42501';END IF;
 IF who IS NOT NULL AND NOT private.attendance_visible(who) THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
 cfg=private.attendance_policy();IF last_day<first_day OR last_day-first_day>=31 OR first_day<'2000-01-01' OR last_day>='2100-01-01' THEN RAISE EXCEPTION 'Use a date range of at most 31 days' USING ERRCODE='22023';END IF;
 SELECT coalesce(array_agg(s.id ORDER BY s.id),'{}') INTO ids FROM attendance_shifts s WHERE s.duty_date BETWEEN first_day AND last_day AND private.attendance_visible(s.employee_id) AND (who IS NULL OR s.employee_id=who)
 AND (coalesce(filters->>'status','ALL')='ALL' OR s.approval_status=filters->>'status')
 AND (NOT coalesce((filters->>'flagged')::boolean,false) OR cardinality(private.attendance_flags(s.id,private.security_now()))>0)
 AND (NOT clean_only OR (s.clocked_out_at IS NOT NULL AND s.approval_status='PENDING' AND cardinality(private.attendance_flags(s.id,private.security_now()))=0 AND NOT EXISTS(SELECT 1 FROM attendance_adjustments a WHERE a.target_shift_id=s.id AND a.status='PENDING')));
 RETURN ids;
END $$;
CREATE FUNCTION private.attendance_list(filters jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE ids uuid[];at_time timestamptz=private.security_now();page_number integer=coalesce((filters->>'page')::int,1);items jsonb;
BEGIN
 IF page_number NOT BETWEEN 1 AND 100000 THEN RAISE EXCEPTION 'Invalid page' USING ERRCODE='22023';END IF;
 ids=private.attendance_filter_ids(filters);
 SELECT coalesce(jsonb_agg(private.attendance_row(x.id,at_time) ORDER BY x.duty_date DESC,x.clocked_in_at DESC,x.id),'[]') INTO items FROM (SELECT id,duty_date,clocked_in_at FROM attendance_shifts WHERE id=ANY(ids) ORDER BY duty_date DESC,clocked_in_at DESC,id LIMIT 50 OFFSET (page_number-1)*50)x;
 RETURN jsonb_build_object('items',items,'total',cardinality(ids),'page',page_number,'asOf',at_time);
END $$;
CREATE FUNCTION private.attendance_settings() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN IF private.work_actor() IS NULL THEN RAISE EXCEPTION 'Work permission required' USING ERRCODE='42501';END IF;RETURN private.attendance_policy();END $$;
CREATE FUNCTION private.set_attendance_policy(expected uuid,cfg jsonb,note text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid;p public.policy_versions%ROWTYPE;added uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(72426820::bigint);actor=private.lock_work(true);PERFORM private.attendance_note(note);
 IF NOT private.admin_recent() OR NOT private.attendance_policy_valid(cfg) THEN RAISE EXCEPTION 'Recent MFA and valid configuration required' USING ERRCODE='42501';END IF;
 PERFORM 1 FROM company_settings WHERE id=1 FOR UPDATE;
 SELECT p0.* INTO p FROM company_settings c JOIN policy_versions p0 ON p0.id=c.work_policy_id WHERE c.id=1;
 IF p.id IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Policy changed' USING ERRCODE='40001';END IF;
 INSERT INTO policy_versions(policy_key,revision,configuration,created_by) SELECT 'WORK',max(revision)+1,p.configuration||jsonb_build_object('attendance',cfg),actor FROM policy_versions WHERE policy_key='WORK' RETURNING id INTO added;
 UPDATE company_settings SET work_policy_id=added,version=version+1,updated_at=private.security_now() WHERE id=1;
 PERFORM private.attendance_audit('attendance.policy_changed',jsonb_build_object('previous_policy_id',expected,'policy_id',added,'reason',note));
END $$;
CREATE FUNCTION private.attendance_duties(day date,employee uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid=private.work_actor();who uuid=coalesce(employee,actor);result jsonb;
BEGIN
 IF actor IS NULL OR NOT private.attendance_visible(who) THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'duty_date',duty_date,'status',status,'valid_from',valid_from,'valid_until',valid_until,'authorization_version',authorization_version)),'[]') INTO result FROM duty_authorizations WHERE employee_id=who AND duty_date=day;RETURN result;
END $$;
CREATE FUNCTION private.attendance_review(target uuid,data jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
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
 UPDATE attendance_shifts SET approval_status=decision,approved_payable_seconds=CASE WHEN decision='APPROVED' THEN value END,suggested_at_review=suggestion,review_mode=mode,reviewed_by=actor,reviewed_at=at_time,review_reason=note,acknowledged_flags=flags,flags=flags,
 review_receipts=review_receipts||jsonb_build_object(key::text,jsonb_build_object('fingerprint',fp,'decision',decision,'at',at_time)),version=version+1,updated_at=at_time WHERE id=target;
 PERFORM private.attendance_audit('attendance.'||lower(decision),jsonb_build_object('shift_id',target,'employee_id',who,'mode',mode,'reason',note,'before',before_values,'after',private.attendance_snapshot(target)));RETURN target;
END $$;
CREATE FUNCTION private.attendance_bulk_preview(filters jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE ids uuid[];cfg jsonb;result jsonb;
BEGIN
 IF NOT private.is_admin() OR NOT private.admin_recent() THEN RAISE EXCEPTION 'Recent administrator MFA required' USING ERRCODE='42501';END IF;
 cfg=private.attendance_policy();IF coalesce((filters->>'to')::date,(filters->>'from')::date)-(filters->>'from')::date>=(cfg->>'bulkMaxDays')::int THEN RAISE EXCEPTION 'Bulk date range too large' USING ERRCODE='22023';END IF;
 ids=private.attendance_filter_ids(filters,true);IF cardinality(ids)>(cfg->>'bulkMaxShifts')::int THEN RAISE EXCEPTION 'Bulk limit exceeded; narrow filters' USING ERRCODE='22023';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'version',s.version,'suggestedSeconds',private.attendance_suggested(s.id)::text) ORDER BY s.id),'[]') INTO result FROM attendance_shifts s WHERE id=ANY(ids);
 RETURN jsonb_build_object('eligible',result,'excluded',cardinality(private.attendance_filter_ids(filters,false))-cardinality(ids),'asOf',private.security_now());
END $$;
CREATE FUNCTION private.attendance_bulk_approve(filters jsonb,expected jsonb,key uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE ids uuid[];fresh uuid[];who uuid;fp text;canonical jsonb;receipt text='bulk_'||key::text;item jsonb;n integer=0;matching integer;actor uuid=private.work_actor();cfg jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(72426820::bigint);
 IF NOT private.is_admin() OR NOT private.admin_recent() OR key IS NULL OR jsonb_typeof(expected) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Recent MFA and selection required' USING ERRCODE='42501';END IF;
 cfg=private.attendance_policy();
 IF jsonb_array_length(expected) NOT BETWEEN 1 AND (cfg->>'bulkMaxShifts')::int THEN RAISE EXCEPTION 'Invalid bulk size' USING ERRCODE='22023';END IF;
 SELECT array_agg((x->>'id')::uuid ORDER BY (x->>'id')::uuid),jsonb_agg(x ORDER BY (x->>'id')::uuid) INTO ids,canonical FROM jsonb_array_elements(expected)x;
 IF cardinality(ids)<>(SELECT count(DISTINCT x) FROM unnest(ids)x) THEN RAISE EXCEPTION 'Duplicate selection' USING ERRCODE='22023';END IF;
 fp=private.work_fingerprint(jsonb_build_object('filters',filters,'expected',canonical));
 PERFORM 1 FROM users WHERE id=actor OR id IN(SELECT employee_id FROM attendance_shifts WHERE id=ANY(ids)) ORDER BY id FOR UPDATE;
 PERFORM private.lock_work(true);
 IF NOT private.admin_recent() THEN RAISE EXCEPTION 'Recent MFA required' USING ERRCODE='42501';END IF;
 SELECT count(*) INTO matching FROM attendance_shifts s WHERE id=ANY(ids) AND s.review_receipts->receipt->>'fingerprint'=fp;
 IF matching=cardinality(ids) THEN RETURN jsonb_build_object('ids',to_jsonb(ids),'replayed',true);END IF;
 IF EXISTS(SELECT 1 FROM attendance_shifts s WHERE id=ANY(ids) AND s.review_receipts ? receipt) THEN RAISE EXCEPTION 'Bulk retry conflict' USING ERRCODE='40001';END IF;
 PERFORM 1 FROM duty_authorizations WHERE id IN(SELECT duty_id FROM attendance_shifts WHERE id=ANY(ids)) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM attendance_shifts WHERE id=ANY(ids) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM attendance_breaks WHERE shift_id=ANY(ids) ORDER BY id FOR UPDATE;
 PERFORM private.attendance_bulk_preview(filters);
 fresh=private.attendance_filter_ids(filters,true);
 IF fresh IS DISTINCT FROM ids THEN RAISE EXCEPTION 'Bulk selection changed; preview again' USING ERRCODE='40001';END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(canonical) LOOP
  PERFORM private.attendance_review((item->>'id')::uuid,jsonb_build_object('operationKey',key,'expectedVersion',(item->>'version')::int,'decision','APPROVED','mode','SUGGESTED','reason','Accepted clean shifts using suggested values','acknowledgeFlags',false));
  UPDATE attendance_shifts SET review_receipts=review_receipts||jsonb_build_object(receipt,jsonb_build_object('fingerprint',fp)) WHERE id=(item->>'id')::uuid;n=n+1;
 END LOOP;
 PERFORM private.attendance_audit('attendance.bulk_approved',jsonb_build_object('ids',ids,'filters',filters,'count',n,'mode','SUGGESTED'));
 RETURN jsonb_build_object('ids',to_jsonb(ids),'replayed',false);
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.attendance_row(uuid,timestamptz),private.attendance_list(jsonb),private.attendance_settings(),private.set_attendance_policy(uuid,jsonb,text),private.attendance_duties(date,uuid),private.attendance_review(uuid,jsonb),private.attendance_bulk_preview(jsonb),private.attendance_bulk_approve(jsonb,jsonb,uuid) TO libetario_runtime;
COMMIT;
