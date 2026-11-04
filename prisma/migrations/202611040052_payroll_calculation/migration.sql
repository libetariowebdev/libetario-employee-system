BEGIN;

CREATE FUNCTION private.payroll_day(t timestamptz) RETURNS date
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT (t AT TIME ZONE 'Asia/Manila')::date $$;
CREATE FUNCTION private.payroll_midnight(d date) RETURNS timestamptz
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT d::timestamp AT TIME ZONE 'Asia/Manila' $$;

CREATE FUNCTION private.payroll_slices(s public.attendance_shifts)
RETURNS TABLE(day date, bounds tstzrange, gross numeric, suggested numeric)
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT day, tstzrange(a,b,'[)'), extract(epoch FROM b-a),
  extract(epoch FROM b-a)-coalesce((
   SELECT sum(extract(epoch FROM least(b,x.ended_at)-greatest(a,x.started_at))) FROM attendance_breaks x
   WHERE x.shift_id=s.id AND NOT x.is_voided AND NOT x.paid AND x.started_at<b AND x.ended_at>a
  ),0)
 FROM generate_series(0,private.payroll_day(s.clocked_out_at)-private.payroll_day(s.clocked_in_at)) offset_day
 CROSS JOIN LATERAL (SELECT private.payroll_day(s.clocked_in_at)+offset_day AS day) calendar
 CROSS JOIN LATERAL (SELECT greatest(s.clocked_in_at,private.payroll_midnight(day)) AS a,
  least(s.clocked_out_at,private.payroll_midnight(day+1)) AS b) slice
 WHERE a<b
$$;

CREATE FUNCTION private.payroll_shift_issues(s public.attendance_shifts, review jsonb) RETURNS text[]
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
DECLARE flags text[]; s_count integer;
BEGIN
 IF s.clocked_out_at IS NULL THEN RETURN ARRAY['OPEN_SHIFT']; END IF;
 IF EXISTS(SELECT 1 FROM attendance_adjustments WHERE target_shift_id=s.id AND status='PENDING')
 THEN RETURN ARRAY['DISPUTED_SHIFT']; END IF;
 IF s.approval_status<>'APPROVED' OR s.approved_payable_seconds IS NULL THEN RETURN ARRAY['ATTENDANCE_NOT_APPROVED']; END IF;
 IF s.clocked_out_at<=s.clocked_in_at OR EXISTS(SELECT 1 FROM attendance_breaks WHERE shift_id=s.id AND NOT is_voided AND ended_at IS NULL)
 THEN RETURN ARRAY['INVALID_ATTENDANCE_INTERVAL']; END IF;
 flags=private.attendance_flags(s.id,private.security_now());
 IF flags && ARRAY['MISSING_CLOCK_OUT','MISSING_CLOCK_IN','SYSTEM_CLOSED','DUTY_WINDOW_EXPIRED','CLOCK_ANOMALY'] THEN
  IF NOT EXISTS(SELECT 1 FROM attendance_adjustments a WHERE a.status='APPROVED' AND a.applied_shift_id=s.id AND a.reviewed_at<=s.reviewed_at)
  THEN RETURN ARRAY['MISSING_OR_INVALID_PUNCH']; END IF;
 END IF;
 SELECT count(*) INTO s_count FROM private.payroll_slices(s);
 IF review IS NULL THEN
  IF cardinality(flags)>0 THEN RETURN ARRAY['UNRESOLVED_FLAGS']; END IF;
  IF s_count<>1 OR s.review_mode='OVERRIDE' OR s.approved_payable_seconds IS DISTINCT FROM private.attendance_suggested(s.id)
  THEN RETURN ARRAY['REVIEWED_ALLOCATION_REQUIRED']; END IF;
 END IF;
 RETURN '{}';
END $$;

CREATE FUNCTION private.payroll_lock_sources(period_key uuid, who uuid[]) RETURNS uuid
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE actor uuid; pp payroll_periods;
BEGIN
 actor=private.lock_work(true,who);
 SELECT * INTO pp FROM payroll_periods WHERE id=period_key;
 IF pp.id IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
 -- A punch or correction for the same employee needs the same user lock.
 PERFORM 1 FROM duty_authorizations WHERE employee_id=ANY(who) AND duty_date BETWEEN pp.start_date-1 AND pp.end_date ORDER BY id FOR UPDATE;
 PERFORM 1 FROM attendance_shifts WHERE employee_id=ANY(who) AND duty_date BETWEEN pp.start_date-1 AND pp.end_date ORDER BY id FOR UPDATE;
 PERFORM 1 FROM attendance_breaks WHERE employee_id=ANY(who) AND shift_id IN (
   SELECT id FROM attendance_shifts WHERE employee_id=ANY(who) AND duty_date BETWEEN pp.start_date-1 AND pp.end_date)
 ORDER BY id FOR UPDATE;
 PERFORM 1 FROM attendance_adjustments WHERE employee_id=ANY(who) AND
   (grant_snapshot->>'dutyDate' BETWEEN (pp.start_date-1)::text AND pp.end_date::text OR duty_id IN
    (SELECT id FROM duty_authorizations WHERE employee_id=ANY(who) AND duty_date BETWEEN pp.start_date-1 AND pp.end_date))
 ORDER BY id FOR UPDATE;
 PERFORM 1 FROM payroll_periods WHERE id=period_key FOR UPDATE;
 PERFORM 1 FROM payroll_lines WHERE period_id=period_key AND employee_id=ANY(who) ORDER BY employee_id,revision FOR UPDATE;
 IF NOT private.is_admin() THEN RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501'; END IF;
 RETURN actor;
END $$;

-- Called only by guarded commands with source and line locks already held.
CREATE FUNCTION private.payroll_rebuild(target uuid) RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE l payroll_lines; pp payroll_periods; employee employee_profiles; service_day date; s attendance_shifts;
 pol policy_versions; cfg jsonb; rate employee_rate_history; earning earning_types; deduction deduction_types;
 sched employee_schedule_history; adj payroll_adjustments; review jsonb; item_id uuid;
 reasons jsonb='[]'; evidence jsonb; srcs jsonb; all_inputs jsonb='[]'; item_inputs jsonb; link_inputs jsonb;
 flags text[]; qty numeric; rounded numeric; n numeric; d numeric; cents numeric; units numeric; selected_seconds numeric;
 totals record; slice record; seq integer=0; saw_shift boolean; daily_regular numeric; minimum_amount numeric;
 gross_total numeric; deduction_total numeric; signature text; not_ready text[];
BEGIN
 SELECT * INTO STRICT l FROM payroll_lines WHERE id=target;
 IF l.state<>'DRAFT' THEN RAISE EXCEPTION 'Draft required' USING ERRCODE='P0409'; END IF;
 SELECT * INTO STRICT pp FROM payroll_periods WHERE id=l.period_id;
 SELECT * INTO STRICT employee FROM employee_profiles WHERE user_id=l.employee_id;
 DELETE FROM payroll_item_attendance WHERE line_id=l.id;
 DELETE FROM payroll_items WHERE line_id=l.id;

 FOR service_day IN SELECT pp.start_date+i FROM generate_series(0,6) i LOOP
  IF employee.start_date>service_day THEN CONTINUE; END IF;
  pol=private.payroll_policy_at(service_day); cfg=pol.configuration;
  not_ready=private.payroll_missing(cfg);
  all_inputs=all_inputs||jsonb_build_array(jsonb_build_object('date',service_day,'policy',pol.id));
  IF cardinality(not_ready)>0 THEN
   reasons=reasons||jsonb_build_array(jsonb_build_object('code','PAY_POLICY_UNCONFIGURED','date',service_day,'missing',not_ready));
  END IF;
  SELECT * INTO rate FROM employee_rate_history r WHERE r.employee_id=l.employee_id AND r.effective_from<=service_day
    AND (r.effective_to IS NULL OR r.effective_to>service_day);
  SELECT * INTO sched FROM employee_schedule_history h WHERE h.employee_id=l.employee_id AND h.effective_from<=service_day
    AND (h.effective_to IS NULL OR h.effective_to>service_day);
  SELECT * INTO earning FROM earning_types e WHERE e.code='REGULAR' AND e.effective_date<=service_day ORDER BY e.effective_date DESC LIMIT 1;
  qty=0; saw_shift=false; srcs='[]';
  FOR s IN SELECT a.* FROM attendance_shifts a WHERE a.employee_id=l.employee_id
    AND (a.clocked_in_at<private.payroll_midnight(service_day+1) AND coalesce(a.clocked_out_at,a.grant_until)>private.payroll_midnight(service_day)
      OR a.clocked_out_at IS NULL AND a.duty_date=service_day
      OR a.clocked_out_at=a.clocked_in_at AND private.payroll_day(a.clocked_in_at)=service_day)
    ORDER BY a.id LOOP
   saw_shift=true;
   SELECT a.after_values INTO review FROM payroll_adjustments a WHERE a.kind='SOURCE' AND a.source_shift_id=s.id AND a.source_shift_version=s.version;
   flags=private.payroll_shift_issues(s,review);
   IF cardinality(flags)>0 THEN
    reasons=reasons||jsonb_build_array(jsonb_build_object('code',flags[1],'date',service_day,'shiftId',s.id,'shiftVersion',s.version,
     'flags',private.attendance_flags(s.id,private.security_now()),'approvedSeconds',s.approved_payable_seconds::text,
     'slices',(SELECT jsonb_agg(jsonb_build_object('date',p.day,'gross',p.gross::text,'suggested',p.suggested::text) ORDER BY p.day) FROM private.payroll_slices(s) p)));
    CONTINUE;
   END IF;
   SELECT * INTO slice FROM private.payroll_slices(s) b WHERE b.day=service_day;
   IF slice.bounds IS NULL THEN CONTINUE; END IF;
   SELECT (v->>'seconds')::numeric INTO selected_seconds FROM jsonb_array_elements(coalesce(review->'allocations','[]')) v WHERE v->>'date'=service_day::text;
   selected_seconds=coalesce(selected_seconds,slice.suggested);
   evidence=jsonb_build_object('shiftId',s.id,'version',s.version,'dutyDate',s.duty_date,
    'bounds',slice.bounds::text,'seconds',selected_seconds::text,'approvedSeconds',s.approved_payable_seconds::text,
    'reviewedAt',s.reviewed_at,'reviewedBy',s.reviewed_by,'reviewMode',s.review_mode,'reviewReason',s.review_reason,
    'recordedIn',s.recorded_in_at,'recordedOut',s.recorded_out_at,'effectiveIn',s.clocked_in_at,'effectiveOut',s.clocked_out_at,
    'schedule',s.schedule_snapshot,'attendancePolicy',s.policy_snapshot,'flags',private.attendance_flags(s.id,private.security_now()),
    'payrollReview',review,'breaks',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',b.id,'code',b.code,'paid',b.paid,
     'start',b.started_at,'end',b.ended_at,'version',b.version) ORDER BY b.id),'[]') FROM attendance_breaks b WHERE b.shift_id=s.id AND NOT b.is_voided));
   srcs=srcs||jsonb_build_array(evidence);
   qty=qty+selected_seconds;
  END LOOP;

  IF NOT saw_shift AND employee.employment_status='ACTIVE' AND EXISTS(
   SELECT 1 FROM employee_schedule_days sd WHERE sd.schedule_id=sched.id AND sd.weekday=extract(isodow FROM service_day) AND sd.working_day
  ) THEN reasons=reasons||jsonb_build_array(jsonb_build_object('code','MISSING_EXPECTED_PUNCH','date',service_day)); END IF;
  IF EXISTS(SELECT 1 FROM attendance_adjustments a JOIN duty_authorizations da ON da.id=a.duty_id
   WHERE a.employee_id=l.employee_id AND a.status='PENDING' AND da.duty_date=service_day)
  THEN reasons=reasons||jsonb_build_array(jsonb_build_object('code','ATTENDANCE_CORRECTION_PENDING','date',service_day)); END IF;
  IF rate.id IS NULL THEN reasons=reasons||jsonb_build_array(jsonb_build_object('code','RATE_UNCONFIGURED','date',service_day)); END IF;
  IF sched.id IS NULL THEN reasons=reasons||jsonb_build_array(jsonb_build_object('code','SCHEDULE_UNCONFIGURED','date',service_day)); END IF;
  IF earning.id IS NULL OR NOT earning.enabled THEN
   reasons=reasons||jsonb_build_array(jsonb_build_object('code','REGULAR_EARNING_UNCONFIGURED','date',service_day));
  END IF;
  all_inputs=all_inputs||jsonb_build_array(jsonb_build_object('date',service_day,'rate',to_jsonb(rate),'schedule',to_jsonb(sched),
   'earning',earning.id,'sources',srcs));
  IF jsonb_array_length(srcs)=0 OR rate.id IS NULL OR sched.id IS NULL OR earning.id IS NULL OR NOT earning.enabled
     OR cardinality(not_ready)>0 THEN CONTINUE; END IF;

  rounded=CASE WHEN cfg->>'timeRounding'='NONE' THEN qty*1000000 ELSE
   private.payroll_quantize(qty*1000000,1,(cfg->>'timeUnitSeconds')::numeric*1000000,cfg->>'timeRounding') END;
  n=rate.amount*10000; units=0;
  IF rate.basis='HOURLY' THEN
   n=n*rounded; d=360000000000; -- denominator converts microseconds and rate ten-thousandths to centavos
  ELSE
   d=100;
   IF rounded=0 OR cfg->>'paidDay'='MINIMUM_SECONDS' AND rounded<(cfg->>'minimumDaySeconds')::numeric*1000000
   THEN n=0;
   ELSIF rounded>=rate.expected_daily_seconds::numeric*1000000 OR cfg->>'partialDay'='FULL'
   THEN units=1;
   ELSIF cfg->>'partialDay'='PRORATE'
   THEN d=d*rate.expected_daily_seconds::numeric*1000000; n=n*rounded; units=rounded/(rate.expected_daily_seconds::numeric*1000000);
   ELSE n=0;
   END IF;
  END IF;
  cents=private.payroll_quantize(n,d,CASE WHEN cfg->>'moneyRounding'='NONE' THEN 1 ELSE (cfg->>'moneyUnitCentavos')::numeric END,cfg->>'moneyRounding');
  IF cents IS NULL THEN
   reasons=reasons||jsonb_build_array(jsonb_build_object('code','NON_CENT_EXACT','date',service_day)); CONTINUE;
  END IF;
  daily_regular=cents/100;
  minimum_amount=nullif(cfg->>'minimumPay','NONE')::numeric;
  IF minimum_amount IS NOT NULL AND rounded>0 THEN daily_regular=greatest(daily_regular,minimum_amount); END IF;
  seq=seq+1;
  INSERT INTO payroll_items(line_id,employee_id,sequence,service_date,earning_id,rate_id,pay_policy_id,description,amount,detail)
  VALUES(l.id,l.employee_id,seq,service_day,earning.id,rate.id,pol.id,earning.label,daily_regular,
   jsonb_build_object('basis',rate.basis,'rate',rate.amount::text,'rateVersion',rate.version,'ratePolicy',rate.pay_policy_id,
    'expectedSeconds',rate.expected_daily_seconds,'approvedSeconds',qty::text,'payableSeconds',(rounded/1000000)::numeric(20,6)::text,
    'dayNumerator',CASE WHEN rate.basis='DAILY' THEN CASE WHEN units=1 THEN '1' WHEN units>0 THEN rounded::text ELSE '0' END END,
    'dayDenominator',CASE WHEN rate.basis='DAILY' THEN CASE WHEN units=1 OR units=0 THEN '1' ELSE (rate.expected_daily_seconds::numeric*1000000)::text END END,
    'amountRatio',jsonb_build_array(n::text,d::text),'minimumPay',minimum_amount::text,'category','REGULAR'))
  RETURNING id INTO item_id;
  INSERT INTO payroll_item_attendance(item_id,line_id,employee_id,shift_id,shift_version,duty_date,service_date,bounds,allocated_seconds,evidence)
  SELECT item_id,l.id,l.employee_id,(v->>'shiftId')::uuid,(v->>'version')::int,(v->>'dutyDate')::date,service_day,
    (v->>'bounds')::tstzrange,(v->>'seconds')::numeric,v FROM jsonb_array_elements(srcs) v;
 END LOOP;

 -- Fixed deductions apply once for the week using the catalog revision effective
 -- on the last included service date. Employee or designation scope is explicit.
 service_day=pp.end_date-1; pol=private.payroll_policy_at(service_day); cfg=pol.configuration;
 IF cardinality(private.payroll_missing(cfg))=0 THEN
  FOR deduction IN SELECT d.* FROM (
   SELECT DISTINCT ON(code) * FROM deduction_types WHERE effective_date<=service_day ORDER BY code,effective_date DESC
  ) d WHERE d.enabled AND (d.employee_id=l.employee_id OR d.designation=employee.designation) ORDER BY d.code LOOP
   IF cfg->>(CASE deduction.category WHEN 'CONTRIBUTION' THEN 'contributions' WHEN 'WITHHOLDING' THEN 'withholding'
      WHEN 'LOAN' THEN 'loans' ELSE 'deductions' END) <> 'CATALOG' THEN CONTINUE; END IF;
   IF deduction.rule->>'mode'='FIXED' THEN
    seq=seq+1;
    INSERT INTO payroll_items(line_id,employee_id,sequence,service_date,deduction_id,pay_policy_id,description,amount,detail)
    VALUES(l.id,l.employee_id,seq,service_day,deduction.id,pol.id,deduction.label,(deduction.rule->>'amount')::numeric,
     jsonb_build_object('category',deduction.category,'rule','FIXED','catalogRevision',deduction.revision));
   END IF;
  END LOOP;
 END IF;

 FOR adj IN SELECT a.* FROM payroll_adjustments a WHERE a.line_id=l.id AND a.kind IN ('MANUAL','POST_CORRECTION')
  AND a.after_values->>'kind' IN ('EARNING','DEDUCTION')
  AND NOT EXISTS(SELECT 1 FROM payroll_adjustments removed WHERE removed.line_id=l.id AND removed.kind='REMOVE_MANUAL'
    AND removed.after_values->>'manualId'=a.id::text) ORDER BY a.created_at,a.id LOOP
  service_day=(adj.after_values->>'date')::date;
  pol=private.payroll_policy_at(service_day); cfg=pol.configuration;
  IF adj.after_values->>'kind'='EARNING' THEN
   SELECT * INTO earning FROM earning_types e WHERE e.id=(adj.after_values->>'typeId')::uuid;
   IF NOT earning.enabled OR earning.id IS DISTINCT FROM (SELECT e.id FROM earning_types e WHERE e.code=earning.code AND e.effective_date<=service_day ORDER BY e.effective_date DESC LIMIT 1)
      OR NOT coalesce(cfg->>(CASE WHEN earning.category='PREMIUM' THEN lower(adj.after_values->>'premiumKind') ELSE lower(earning.category) END)='MANUAL',
        earning.category='ADJUSTMENT') OR earning.category='REGULAR'
   THEN reasons=reasons||jsonb_build_array(jsonb_build_object('code','MANUAL_ITEM_REVIEW','adjustmentId',adj.id)); CONTINUE; END IF;
   deduction.id=NULL;
  ELSE
   earning.id=NULL;
   SELECT * INTO deduction FROM deduction_types d WHERE d.id=(adj.after_values->>'typeId')::uuid;
   IF NOT deduction.enabled OR deduction.rule->>'mode'<>'MANUAL' OR NOT coalesce(deduction.employee_id=l.employee_id OR deduction.designation=employee.designation,false)
     OR deduction.id IS DISTINCT FROM (SELECT d.id FROM deduction_types d WHERE d.code=deduction.code AND d.effective_date<=service_day ORDER BY d.effective_date DESC LIMIT 1)
     OR NOT coalesce(cfg->>(CASE deduction.category WHEN 'CONTRIBUTION' THEN 'contributions' WHEN 'WITHHOLDING' THEN 'withholding'
        WHEN 'LOAN' THEN 'loans' ELSE 'deductions' END)='CATALOG',false)
   THEN reasons=reasons||jsonb_build_array(jsonb_build_object('code','MANUAL_ITEM_REVIEW','adjustmentId',adj.id)); CONTINUE; END IF;
  END IF;
  IF cardinality(private.payroll_missing(cfg))>0 THEN CONTINUE; END IF;
  seq=seq+1;
  INSERT INTO payroll_items(line_id,employee_id,sequence,service_date,earning_id,deduction_id,pay_policy_id,description,amount,detail)
  VALUES(l.id,l.employee_id,seq,service_day,earning.id,deduction.id,pol.id,CASE WHEN earning.id IS NOT NULL THEN earning.label ELSE deduction.label END,
   (adj.after_values->>'amount')::numeric,jsonb_build_object('category',CASE WHEN earning.id IS NOT NULL THEN earning.category ELSE deduction.category END,
    'rule','MANUAL','adjustmentId',adj.id,'sourceLineId',adj.source_line_id));
 END LOOP;

 -- A reviewed manual deduction catalog item must either be entered or retired.
 FOR deduction IN SELECT d.* FROM (SELECT DISTINCT ON(code) * FROM deduction_types WHERE effective_date<=pp.end_date-1 ORDER BY code,effective_date DESC) d
  WHERE d.enabled AND d.rule->>'mode'='MANUAL' AND d.category<>'ADJUSTMENT' AND (d.employee_id=l.employee_id OR d.designation=employee.designation) LOOP
  cfg=(private.payroll_policy_at(pp.end_date-1)).configuration;
  IF cfg->>(CASE deduction.category WHEN 'CONTRIBUTION' THEN 'contributions' WHEN 'WITHHOLDING' THEN 'withholding' WHEN 'LOAN' THEN 'loans' ELSE 'deductions' END)='CATALOG'
   AND NOT EXISTS(SELECT 1 FROM payroll_items WHERE line_id=l.id AND deduction_id=deduction.id)
  THEN reasons=reasons||jsonb_build_array(jsonb_build_object('code','MANUAL_DEDUCTION_REQUIRED','typeId',deduction.id,'label',deduction.label)); END IF;
 END LOOP;

 SELECT coalesce(sum(amount) FILTER(WHERE earning_id IS NOT NULL),0),coalesce(sum(amount) FILTER(WHERE deduction_id IS NOT NULL),0)
 INTO gross_total,deduction_total FROM payroll_items WHERE line_id=l.id;
 IF gross_total<deduction_total THEN reasons=reasons||'[{"code":"NEGATIVE_NET"}]'::jsonb; END IF;
 IF gross_total=deduction_total AND NOT EXISTS(SELECT 1 FROM payroll_adjustments a WHERE a.line_id=l.id
    AND a.kind='MANUAL' AND a.after_values->>'kind'='ZERO_REVIEW'
    AND a.after_values->>'totals'=(gross_total::numeric(20,2)::text||'/'||deduction_total::numeric(20,2)::text))
 THEN reasons=reasons||'[{"code":"ZERO_NET_REVIEW"}]'::jsonb; END IF;
 SELECT coalesce(jsonb_agg((to_jsonb(i)-ARRAY['id','line_id','employee_id','amount'])||jsonb_build_object('amount',i.amount::text) ORDER BY sequence),'[]')
 INTO item_inputs FROM payroll_items i WHERE line_id=l.id;
 signature=private.work_fingerprint(jsonb_build_object('employee',to_jsonb(employee)-'contact','company',(SELECT company_name FROM company_settings WHERE id=1),
  'inputs',all_inputs,'items',item_inputs,'issues',reasons));
 UPDATE payroll_lines SET gross=gross_total,deductions=deduction_total,net=gross_total-deduction_total,issues=reasons,
  source_digest=signature,version=version+1 WHERE id=l.id;
 RETURN signature;
END $$;

REVOKE ALL ON FUNCTION private.payroll_day(timestamptz),private.payroll_midnight(date),private.payroll_slices(public.attendance_shifts),
 private.payroll_shift_issues(public.attendance_shifts,jsonb),private.payroll_lock_sources(uuid,uuid[]),private.payroll_rebuild(uuid) FROM PUBLIC;
COMMIT;
