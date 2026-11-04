BEGIN;
ALTER TABLE payroll_periods ADD COLUMN create_key uuid NOT NULL UNIQUE, ADD COLUMN create_fingerprint text NOT NULL;

CREATE FUNCTION private.payroll_manifest(target uuid) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT private.work_fingerprint(coalesce(jsonb_agg(jsonb_build_array(employee_id,id,version,source_digest) ORDER BY employee_id),'[]'))
 FROM payroll_lines WHERE period_id=target AND state='DRAFT'
$$;
CREATE FUNCTION private.payroll_prepare(data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE day date=(data->>'startDate')::date; key uuid=(data->>'operationKey')::uuid; people uuid[];
 pp payroll_periods; pol policy_versions; actor uuid; l uuid; emp uuid; fp text;
BEGIN
 IF NOT private.is_admin() THEN RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501'; END IF;
 IF day IS NULL OR day NOT BETWEEN '2000-01-01' AND '2099-12-24' OR key IS NULL OR
   jsonb_typeof(data->'employeeIds') IS DISTINCT FROM 'array' OR jsonb_array_length(data->'employeeIds') NOT BETWEEN 1 AND 100
 THEN RAISE EXCEPTION 'Provide a weekly start and up to 100 employees' USING ERRCODE='22023'; END IF;
 SELECT array_agg(DISTINCT v::uuid ORDER BY v::uuid) INTO people FROM jsonb_array_elements_text(data->'employeeIds') v;
 actor=private.lock_work(true,people);
 fp=private.work_fingerprint(jsonb_build_object('date',day,'employees',people,'actor',actor));
 SELECT * INTO pp FROM payroll_periods WHERE create_key=key;
 IF pp.id IS NOT NULL THEN
  IF pp.create_fingerprint<>fp THEN RAISE EXCEPTION 'Retry conflict' USING ERRCODE='40001'; END IF;
  RETURN pp.id;
 END IF;
 pol=private.payroll_policy_at(day);
 IF pol.id IS NULL OR pol.configuration->>'weekday' IS NULL OR pol.configuration->>'paydayOffset' IS NULL THEN
  RAISE EXCEPTION 'Configure cutoff weekday and payday before creating a period' USING ERRCODE='P0422';
 END IF;
 IF extract(isodow FROM day)<>(pol.configuration->>'weekday')::int THEN
  RAISE EXCEPTION 'Start date must match the configured cutoff weekday' USING ERRCODE='22023';
 END IF;
 IF (SELECT count(*) FROM employee_profiles WHERE user_id=ANY(people) AND start_date<day+7)<>cardinality(people) THEN
  RAISE EXCEPTION 'Invalid employee selection' USING ERRCODE='22023';
 END IF;
 INSERT INTO payroll_periods(start_date,end_date,payday,cutoff_policy_id,roster,created_by,create_key,create_fingerprint)
 VALUES(day,day+7,day+7+(pol.configuration->>'paydayOffset')::int,pol.id,people,actor,key,fp) RETURNING * INTO pp;
 -- The inserted period is private to this transaction and no other request
 -- can take its lock. The relevant user rows were locked before insertion.
 FOREACH emp IN ARRAY people LOOP
  INSERT INTO payroll_lines(period_id,employee_id,revision,created_by) VALUES(pp.id,emp,1,actor) RETURNING id INTO l;
  PERFORM private.payroll_rebuild(l);
 END LOOP;
 PERFORM private.write_audit('payroll.period_prepared',jsonb_build_object('periodId',pp.id,'start',day,'employees',people));
 RETURN pp.id;
END $$;

CREATE FUNCTION private.payroll_freeze_line(target uuid, actor uuid, stamp timestamptz) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE l payroll_lines; pp payroll_periods; emp employee_profiles; snap jsonb; detail jsonb;
BEGIN
 SELECT * INTO STRICT l FROM payroll_lines WHERE id=target;
 SELECT * INTO STRICT pp FROM payroll_periods WHERE id=l.period_id;
 SELECT * INTO STRICT emp FROM employee_profiles WHERE user_id=l.employee_id;
 IF l.state<>'DRAFT' OR l.issues<>'[]' OR l.net<0 OR stamp<private.payroll_midnight(pp.end_date) OR
    EXISTS(SELECT 1 FROM payroll_item_attendance a JOIN payroll_lines x ON x.id=a.line_id
     JOIN payroll_item_attendance b ON a.shift_id=b.shift_id AND a.bounds && b.bounds
     WHERE b.line_id=l.id AND x.period_id<>pp.id AND x.state IN ('APPROVED','PAID'))
 THEN RAISE EXCEPTION 'Resolve payroll review issues before approval' USING ERRCODE='P0422'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',i.id,'sequence',i.sequence,'date',i.service_date,'description',i.description,
  'kind',CASE WHEN i.earning_id IS NULL THEN 'DEDUCTION' ELSE 'EARNING' END,'amount',i.amount::text,'detail',i.detail,
  'policy',to_jsonb(p),'earning',to_jsonb(e),'deduction',to_jsonb(d),
  'rate',CASE WHEN r.id IS NOT NULL THEN to_jsonb(r)||jsonb_build_object('amount',r.amount::text) END,
  'attendance',(SELECT coalesce(jsonb_agg(a.evidence ORDER BY a.shift_id,a.service_date),'[]') FROM payroll_item_attendance a WHERE a.item_id=i.id))
  ORDER BY i.sequence),'[]') INTO detail FROM payroll_items i JOIN policy_versions p ON p.id=i.pay_policy_id
  LEFT JOIN earning_types e ON e.id=i.earning_id LEFT JOIN deduction_types d ON d.id=i.deduction_id
  LEFT JOIN employee_rate_history r ON r.id=i.rate_id WHERE i.line_id=l.id;
 snap=jsonb_build_object('employee',jsonb_build_object('id',emp.user_id,'number',emp.employee_number,'name',emp.legal_name,'position',emp.designation),
  'company',(SELECT company_name FROM company_settings WHERE id=1),'currency','PHP','startDate',pp.start_date,'endDate',pp.end_date,'payday',pp.payday,
  'approvedAt',stamp,'approvedBy',actor,'cutoffPolicy',(SELECT to_jsonb(p) FROM policy_versions p WHERE p.id=pp.cutoff_policy_id),
  'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY d) FROM generate_series(0,6) g
    CROSS JOIN LATERAL (SELECT pp.start_date+g AS d) date_entry CROSS JOIN LATERAL private.payroll_policy_at(d) p),
  'gross',l.gross::text,'deductions',l.deductions::text,'net',l.net::text,'items',detail,'sourceDigest',l.source_digest,
  'adjustments',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.created_at,a.id),'[]') FROM payroll_adjustments a WHERE a.line_id=l.id));
 UPDATE payroll_lines SET state='APPROVED',approved_at=stamp,approved_by=actor,snapshot=snap,
  snapshot_digest=private.work_fingerprint(snap),version=version+1 WHERE id=target;
END $$;

CREATE FUNCTION private.payroll_approve(period_key uuid,data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE pp payroll_periods; l payroll_lines; actor uuid; fp text; stamp timestamptz; old_digest text;
 key uuid=(data->>'operationKey')::uuid; presented text=data->>'manifest';
BEGIN
 IF NOT private.is_admin() THEN RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501'; END IF;
 SELECT * INTO pp FROM payroll_periods WHERE id=period_key;
 actor=private.payroll_lock_sources(period_key,pp.roster);
 SELECT * INTO STRICT pp FROM payroll_periods WHERE id=period_key;
 IF NOT private.admin_recent() THEN RAISE EXCEPTION 'Recent MFA required' USING ERRCODE='42501'; END IF;
 IF key IS NULL THEN RAISE EXCEPTION 'Operation key required' USING ERRCODE='22023'; END IF;
 fp=private.work_fingerprint(data||jsonb_build_object('actor',actor));
 IF pp.receipts ? key::text THEN
  IF pp.receipts->>key::text<>fp THEN RAISE EXCEPTION 'Retry conflict' USING ERRCODE='40001'; END IF;
  RETURN pp.id;
 END IF;
 IF pp.state<>'DRAFT' OR presented IS DISTINCT FROM private.payroll_manifest(pp.id) OR
    pp.version IS DISTINCT FROM (data->>'expectedVersion')::int
 THEN RAISE EXCEPTION 'Payroll review changed' USING ERRCODE='40001'; END IF;
 stamp=private.security_now();
 IF stamp<private.payroll_midnight(pp.end_date) THEN RAISE EXCEPTION 'Period cutoff has not passed' USING ERRCODE='P0422'; END IF;
 FOR l IN SELECT * FROM payroll_lines WHERE period_id=pp.id ORDER BY employee_id LOOP
  old_digest=l.source_digest;
  IF private.payroll_rebuild(l.id) IS DISTINCT FROM old_digest THEN
   RAISE EXCEPTION 'Attendance, rate or rules changed. Recalculate the draft.' USING ERRCODE='40001';
  END IF;
  PERFORM private.payroll_freeze_line(l.id,actor,stamp);
 END LOOP;
 UPDATE payroll_periods SET state='APPROVED',approved_by=actor,approved_at=stamp,manifest=presented,
  receipts=receipts||jsonb_build_object(key::text,fp),version=version+1 WHERE id=pp.id;
 PERFORM private.write_audit('payroll.period_approved',jsonb_build_object('periodId',pp.id,'manifest',presented));
 RETURN pp.id;
END $$;

CREATE FUNCTION private.payroll_review_source(l payroll_lines, data jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE s attendance_shifts; part record; allocations jsonb=data->'allocations'; input jsonb; output jsonb='[]'; t numeric=0; seconds numeric; n integer=0;
 pp payroll_periods; flags text[];
BEGIN
 SELECT * INTO pp FROM payroll_periods WHERE id=l.period_id;
 SELECT * INTO s FROM attendance_shifts WHERE id=(data->>'shiftId')::uuid AND employee_id=l.employee_id;
 IF s.id IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
 IF s.version IS DISTINCT FROM (data->>'shiftVersion')::int THEN RAISE EXCEPTION 'Shift changed' USING ERRCODE='40001'; END IF;
 IF cardinality(private.payroll_shift_issues(s,'{}'))>0 OR s.clocked_in_at>=private.payroll_midnight(pp.end_date) OR
   s.clocked_out_at<=private.payroll_midnight(pp.start_date) OR
   jsonb_typeof(allocations) IS DISTINCT FROM 'array' OR jsonb_array_length(allocations) NOT BETWEEN 1 AND 3
 THEN RAISE EXCEPTION 'Approved shift and exact reviewed allocations are required' USING ERRCODE='P0422'; END IF;
 flags=private.attendance_flags(s.id,private.security_now());
 IF to_jsonb(flags) IS DISTINCT FROM data->'flags' THEN RAISE EXCEPTION 'Review the current attendance flags' USING ERRCODE='40001'; END IF;
 FOR part IN SELECT * FROM private.payroll_slices(s) ORDER BY day LOOP
  SELECT v INTO input FROM jsonb_array_elements(allocations) v WHERE v->>'date'=part.day::text;
  IF input IS NULL OR jsonb_typeof(input->'seconds') IS DISTINCT FROM 'string' OR input->>'seconds' !~ '^[0-9]{1,6}([.][0-9]{1,6})?$' THEN
   RAISE EXCEPTION 'Each Manila date needs exact seconds' USING ERRCODE='22023'; END IF;
  seconds=(input->>'seconds')::numeric(20,6);
  IF seconds>(CASE WHEN s.review_mode='OVERRIDE' THEN part.gross ELSE part.suggested END) THEN
   RAISE EXCEPTION 'Allocation exceeds the interval' USING ERRCODE='22023'; END IF;
  t=t+seconds; n=n+1;
  output=output||jsonb_build_array(jsonb_build_object('date',part.day,'seconds',seconds::text,'bounds',part.bounds::text));
 END LOOP;
 IF t<>s.approved_payable_seconds OR n<>jsonb_array_length(allocations) THEN
  RAISE EXCEPTION 'Allocations must add up to the approved shift' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object('allocations',output,'flags',flags,'approvedSeconds',s.approved_payable_seconds::text,'shiftVersion',s.version);
END $$;

CREATE FUNCTION private.payroll_line_command(target uuid,data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE l payroll_lines; pp payroll_periods; src payroll_lines; related payroll_adjustments; prior payroll_adjustments;
 actor uuid; action text=data->>'action'; reason text; evidence_note text; kind text; result uuid=target; fp text;
 key uuid=(data->>'operationKey')::uuid; before_values jsonb; after_values jsonb; old_digest text;
 day date; amount numeric; canonical jsonb=data; shift_key uuid; shift_ver integer;
BEGIN
 IF NOT private.is_admin() THEN RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501'; END IF;
 SELECT * INTO l FROM payroll_lines WHERE id=target;
 IF l.id IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
 actor=private.payroll_lock_sources(l.period_id,ARRAY[l.employee_id]);
 SELECT * INTO STRICT l FROM payroll_lines WHERE id=target;
 SELECT * INTO STRICT pp FROM payroll_periods WHERE id=l.period_id;
 IF action IS NULL OR action NOT IN ('RECALCULATE','SOURCE','MANUAL','REMOVE_MANUAL','ZERO_REVIEW','VOID','REPLACE','APPROVE_REPLACEMENT','CORRECTION_NEEDED','POST_CORRECTION')
   OR key IS NULL THEN RAISE EXCEPTION 'Invalid payroll operation' USING ERRCODE='22023'; END IF;
 IF action<>'RECALCULATE' AND NOT private.admin_recent() THEN RAISE EXCEPTION 'Recent MFA required' USING ERRCODE='42501'; END IF;
 IF action IN ('MANUAL','POST_CORRECTION') THEN
  IF jsonb_typeof(data->'amount') IS DISTINCT FROM 'string' OR data->>'amount' !~ '^[0-9]{1,12}([.][0-9]{1,2})?$' THEN
   RAISE EXCEPTION 'Use exact PHP amounts to centavos' USING ERRCODE='22023'; END IF;
  amount=(data->>'amount')::numeric(20,2); canonical=data||jsonb_build_object('amount',amount::text);
 END IF;
 IF action<>'RECALCULATE' THEN
  reason=private.payroll_note(data->>'reason'); evidence_note=private.payroll_note(data->>'evidence',1);
  canonical=canonical||jsonb_build_object('reason',reason,'evidence',evidence_note);
 END IF;
 fp=private.work_fingerprint(canonical||jsonb_build_object('actor',actor));
 SELECT * INTO prior FROM payroll_adjustments WHERE line_id=l.id AND operation_key=key;
 IF prior.id IS NOT NULL OR l.receipts ? key::text THEN
  IF coalesce(prior.fingerprint,l.receipts->>key::text)<>fp THEN RAISE EXCEPTION 'Retry conflict' USING ERRCODE='40001'; END IF;
  RETURN coalesce((prior.after_values->>'result')::uuid,target);
 END IF;
 IF l.version IS DISTINCT FROM (data->>'expectedVersion')::int THEN RAISE EXCEPTION 'Payroll line changed' USING ERRCODE='40001'; END IF;
 IF action IN ('VOID','REPLACE','CORRECTION_NEEDED') THEN
  IF l.state<>(CASE WHEN action='CORRECTION_NEEDED' THEN 'PAID' ELSE 'APPROVED' END) THEN
   RAISE EXCEPTION 'Line is not eligible for this disposition' USING ERRCODE='P0409'; END IF;
 ELSIF l.state<>'DRAFT' THEN RAISE EXCEPTION 'Draft required' USING ERRCODE='P0409'; END IF;
 before_values=jsonb_build_object('state',l.state,'gross',l.gross::text,'deductions',l.deductions::text,'net',l.net::text,'version',l.version);
 IF action='RECALCULATE' THEN
  PERFORM private.payroll_rebuild(l.id);
  UPDATE payroll_lines SET receipts=receipts||jsonb_build_object(key::text,fp) WHERE id=l.id;
 ELSIF action='APPROVE_REPLACEMENT' THEN
  SELECT * INTO src FROM payroll_lines WHERE id=l.predecessor_id;
  IF pp.state<>'APPROVED' OR src.state IS DISTINCT FROM 'APPROVED' THEN
   RAISE EXCEPTION 'Unpaid approved predecessor required' USING ERRCODE='P0409'; END IF;
  old_digest=l.source_digest;
  IF private.payroll_rebuild(l.id) IS DISTINCT FROM old_digest THEN
   RAISE EXCEPTION 'Recalculate the changed draft' USING ERRCODE='40001'; END IF;
  INSERT INTO payroll_adjustments(line_id,period_id,employee_id,kind,source_line_id,actor_id,reason,evidence,before_values,after_values,operation_key,fingerprint)
  VALUES(l.id,pp.id,l.employee_id,'REPLACE',src.id,actor,reason,evidence_note,before_values,
   jsonb_build_object('predecessor',src.id,'predecessorBefore',src.state,'predecessorAfter','ADJUSTED','state','APPROVED'),key,fp);
  UPDATE payroll_lines SET state='ADJUSTED',version=version+1 WHERE id=src.id;
  PERFORM private.payroll_freeze_line(l.id,actor,private.security_now());
 ELSE
  kind=action;
  IF action='SOURCE' THEN
   shift_key=(data->>'shiftId')::uuid; shift_ver=(data->>'shiftVersion')::int;
   after_values=private.payroll_review_source(l,data);
  ELSIF action IN ('MANUAL','POST_CORRECTION') THEN
   day=(data->>'date')::date;
   IF day IS NULL OR day<pp.start_date OR day>=pp.end_date OR coalesce(data->>'kind','') NOT IN ('EARNING','DEDUCTION') THEN
    RAISE EXCEPTION 'Manual item needs a service date and catalog type' USING ERRCODE='22023'; END IF;
   IF data->>'kind'='EARNING' THEN
    IF NOT EXISTS(SELECT 1 FROM earning_types WHERE id=(data->>'typeId')::uuid AND category<>'REGULAR' AND enabled AND effective_date<=day)
    THEN RAISE EXCEPTION 'Choose a manual earning type' USING ERRCODE='22023'; END IF;
   ELSIF NOT EXISTS(SELECT 1 FROM deduction_types WHERE id=(data->>'typeId')::uuid AND enabled AND rule->>'mode'='MANUAL' AND effective_date<=day
      AND (employee_id=l.employee_id OR designation=(SELECT designation FROM employee_profiles WHERE user_id=l.employee_id)))
   THEN RAISE EXCEPTION 'Choose a manual deduction applicable to this employee' USING ERRCODE='22023'; END IF;
   IF data->>'kind'='DEDUCTION' AND EXISTS(SELECT 1 FROM payroll_items WHERE line_id=l.id AND deduction_id=(data->>'typeId')::uuid) THEN
    RAISE EXCEPTION 'This deduction is already entered' USING ERRCODE='P0409'; END IF;
   IF action='POST_CORRECTION' THEN
    SELECT * INTO related FROM payroll_adjustments WHERE id=(data->>'correctionId')::uuid AND employee_id=l.employee_id AND kind='CORRECTION_NEEDED';
    SELECT * INTO src FROM payroll_lines WHERE id=related.line_id AND state='PAID';
    IF src.id IS NULL OR NOT EXISTS(SELECT 1 FROM payroll_periods WHERE id=src.period_id AND end_date<=pp.start_date) OR
     NOT EXISTS(SELECT 1 FROM earning_types WHERE data->>'kind'='EARNING' AND id=(data->>'typeId')::uuid AND category='ADJUSTMENT'
      UNION ALL SELECT 1 FROM deduction_types WHERE data->>'kind'='DEDUCTION' AND id=(data->>'typeId')::uuid AND category='ADJUSTMENT')
    THEN RAISE EXCEPTION 'Choose a reviewed paid correction from a prior period and an adjustment type' USING ERRCODE='P0422'; END IF;
   END IF;
   after_values=jsonb_build_object('kind',data->>'kind','typeId',(data->>'typeId')::uuid,'date',day,'amount',amount::text,
    'premiumKind',coalesce(data->>'premiumKind','premium'));
  ELSIF action='REMOVE_MANUAL' THEN
   SELECT * INTO prior FROM payroll_adjustments WHERE id=(data->>'manualId')::uuid AND line_id=l.id AND kind='MANUAL';
   IF prior.id IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
   before_values=before_values||jsonb_build_object('manual',prior.after_values);
   after_values=jsonb_build_object('manualId',prior.id,'removed',true);
  ELSIF action='ZERO_REVIEW' THEN
   IF l.net<>0 THEN RAISE EXCEPTION 'Zero net required' USING ERRCODE='P0422'; END IF;
   kind='MANUAL'; after_values=jsonb_build_object('kind','ZERO_REVIEW','totals',l.gross::text||'/'||l.deductions::text);
  ELSIF action='CORRECTION_NEEDED' THEN
   after_values=jsonb_build_object('review','LATER_PERIOD_REQUIRED','snapshotDigest',l.snapshot_digest);
  ELSIF action='REPLACE' THEN
   INSERT INTO payroll_lines(period_id,employee_id,revision,predecessor_id,created_by)
   VALUES(l.period_id,l.employee_id,l.revision+1,l.id,actor) RETURNING id INTO result;
   after_values=jsonb_build_object('result',result,'state','DRAFT');
  ELSE
   IF EXISTS(SELECT 1 FROM payroll_lines WHERE predecessor_id=l.id AND state='DRAFT') THEN
    RAISE EXCEPTION 'A replacement draft already exists' USING ERRCODE='P0409'; END IF;
   UPDATE payroll_lines SET state='VOIDED',version=version+1 WHERE id=l.id;
   after_values=jsonb_build_object('state','VOIDED');
  END IF;
  INSERT INTO payroll_adjustments(line_id,period_id,employee_id,kind,source_shift_id,source_shift_version,source_line_id,related_adjustment_id,
   actor_id,reason,evidence,before_values,after_values,operation_key,fingerprint)
  VALUES(l.id,pp.id,l.employee_id,kind,shift_key,shift_ver,src.id,related.id,actor,reason,evidence_note,before_values,after_values,key,fp);
  IF l.state='DRAFT' OR action='REPLACE' THEN PERFORM private.payroll_rebuild(result); END IF;
 END IF;
 PERFORM private.write_audit('payroll.'||lower(action),jsonb_build_object('lineId',l.id,'result',result,'reason',reason,
  'evidence',evidence_note,'before',before_values,'change',after_values,'after',
  (SELECT jsonb_build_object('state',state,'gross',gross::text,'deductions',deductions::text,'net',net::text,'version',version)
   FROM payroll_lines WHERE id=result)));
 RETURN result;
END $$;

REVOKE ALL ON FUNCTION private.payroll_manifest(uuid),private.payroll_prepare(jsonb),private.payroll_freeze_line(uuid,uuid,timestamptz),
 private.payroll_approve(uuid,jsonb),private.payroll_review_source(public.payroll_lines,jsonb),private.payroll_line_command(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.payroll_prepare(jsonb),private.payroll_approve(uuid,jsonb),private.payroll_line_command(uuid,jsonb) TO libetario_runtime;
COMMIT;
