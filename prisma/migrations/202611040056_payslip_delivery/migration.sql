BEGIN;

CREATE FUNCTION private.payslip_meta(s payslips) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('reference',s.reference,'event',s.event,'version',s.version,'issuedAt',s.issued_at,'hasLogo',s.has_logo)
$$;

CREATE FUNCTION private.payslip_read(target uuid, page_offset int) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE who uuid=private.actor(); is_admin boolean=private.is_admin(); l payroll_lines; pp payroll_periods; p payments; cfg jsonb;
BEGIN
 IF who IS NULL OR NOT EXISTS(SELECT 1 FROM private.identity() WHERE NOT must_change_password)
 THEN RAISE EXCEPTION 'Account access required' USING ERRCODE='42501'; END IF;
 IF target IS NULL THEN
  RETURN (SELECT coalesce(jsonb_agg(x.data ORDER BY x.stamp DESC,x.id),'[]') FROM (
   SELECT s.id,s.issued_at stamp,private.payslip_meta(s)||jsonb_build_object('lineId',pl.id,
    'startDate',pl.snapshot->>'startDate','endDate',pl.snapshot->>'endDate','net',pl.net::text,
    'lineState',pl.state,'employee',pl.snapshot->'employee'->>'name') data
   FROM payslips s JOIN payroll_lines pl ON pl.id=s.line_id
   WHERE (is_admin OR pl.employee_id=who) AND pl.state<>'DRAFT'
   ORDER BY s.issued_at DESC,s.id OFFSET greatest(0,least(page_offset,50000)) LIMIT 50) x);
 END IF;
 IF NOT private.can_payslip_line(target) THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
 SELECT * INTO l FROM payroll_lines WHERE id=target;
 SELECT * INTO pp FROM payroll_periods WHERE id=l.period_id;
 SELECT * INTO p FROM payments WHERE line_id=target;
 cfg=(private.payroll_policy_at(private.payroll_day(private.security_now()))).configuration;
 RETURN jsonb_build_object('state',l.state,'version',l.version,'periodVersion',pp.version,'net',l.net::text,
  'today',private.payroll_day(private.security_now()),'cutoff',pp.end_date,'payday',pp.payday,
  'paymentDate',p.payment_date,'payment',CASE WHEN is_admin AND p.id IS NOT NULL THEN
   jsonb_build_object('date',p.payment_date,'method',p.method,'reference',p.normalized_reference,'amount',p.amount::text) END,
  'frozenMethods',CASE WHEN is_admin THEN l.snapshot->'cutoffPolicy'->'configuration'->'paymentMethods' END,
  'paymentPolicyReady',is_admin AND cardinality(private.payroll_missing(cfg))=0,
  'payslips',(SELECT coalesce(jsonb_agg(private.payslip_meta(s) ORDER BY s.version),'[]') FROM payslips s WHERE line_id=target));
END $$;

CREATE FUNCTION private.payslip_source(target uuid, event_name text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE l payroll_lines; p payments; s payslips;
BEGIN
 IF NOT private.is_admin() THEN RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501'; END IF;
 SELECT * INTO l FROM payroll_lines WHERE id=target AND state<>'DRAFT';
 IF l.id IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
 IF event_name NOT IN ('APPROVAL','PAYMENT') OR event_name IS NULL THEN
  RAISE EXCEPTION 'Invalid payslip event' USING ERRCODE='22023'; END IF;
 SELECT * INTO s FROM payslips WHERE line_id=target AND event=event_name;
 IF s.id IS NOT NULL THEN RETURN jsonb_build_object('published',private.payslip_meta(s)); END IF;
 IF event_name='PAYMENT' THEN
  SELECT * INTO p FROM payments WHERE line_id=l.id AND l.state='PAID';
  IF p.id IS NULL OR NOT EXISTS(SELECT 1 FROM payslips WHERE line_id=l.id AND event='APPROVAL')
  THEN RAISE EXCEPTION 'Issue the approved payslip and record payment first' USING ERRCODE='40001'; END IF;
 END IF;
 RETURN jsonb_build_object('digest',l.snapshot_digest,'snapshot',l.snapshot,
  'paymentId',p.id,'paymentDate',p.payment_date);
END $$;

-- The publish transaction holds this lock across its short storage promotion and
-- commit. The offline orphan operator takes the same lock before deleting a key.
CREATE FUNCTION private.payslip_storage_lock(key text, proof text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT private.is_admin() THEN RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501'; END IF;
 PERFORM private.assert_upload_proof(proof);
 IF key IS NULL OR key !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid storage key' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('payslip:'||key,0));
END $$;

CREATE FUNCTION private.payslip_publish(target uuid, data jsonb, proof text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE l payroll_lines; f uuid; s payslips; sid uuid; who uuid; pol uuid; source jsonb;
 event_name text=data->>'event'; ref text=data->>'reference'; key text=data->>'key';
 bytes bigint=(data->>'size')::bigint; stamp timestamptz;
BEGIN
 PERFORM private.payslip_storage_lock(key,proof);
 SELECT * INTO l FROM payroll_lines WHERE id=target;
 IF l.id IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
 who=private.lock_work(true,ARRAY[l.employee_id]);
 PERFORM 1 FROM payroll_periods WHERE id=l.period_id FOR UPDATE;
 SELECT * INTO STRICT l FROM payroll_lines WHERE id=target FOR UPDATE;
 source=private.payslip_source(target,event_name);
 IF source ? 'published' THEN RETURN jsonb_build_object('published',source->'published','created',false); END IF;
 IF l.snapshot_digest IS DISTINCT FROM data->>'digest' OR source->>'paymentId' IS DISTINCT FROM data->>'paymentId' OR
  key=ref OR coalesce(data->>'hasLogo','') NOT IN ('true','false')
 THEN RAISE EXCEPTION 'Payslip inputs changed' USING ERRCODE='40001'; END IF;
 SELECT session_id INTO STRICT sid FROM private.identity();
 SELECT (l.snapshot->'cutoffPolicy'->>'id')::uuid INTO pol;
 stamp=private.security_now();
 INSERT INTO file_objects(storage_key,display_name,declared_media_type,detected_media_type,reserved_bytes,
  size_bytes,sha256,purpose,uploaded_by,upload_session_id,state,validation_policy_id,upload_completed_at,validated_at,validation_outcome)
 VALUES(key,'payslip-'||ref||'.pdf','application/pdf','application/pdf',bytes,bytes,data->>'sha256',
  'PAYSLIP',who,sid,'AVAILABLE',pol,stamp,stamp,'VALIDATED') RETURNING id INTO f;
 INSERT INTO payslips(line_id,version,reference,file_id,event,payment_id,issued_by,line_digest,template_digest,has_logo)
 VALUES(l.id,CASE WHEN event_name='APPROVAL' THEN 1 ELSE 2 END,ref,f,event_name,(source->>'paymentId')::uuid,
  who,l.snapshot_digest,data->>'templateDigest',(data->>'hasLogo')::boolean) RETURNING * INTO s;
 PERFORM private.write_audit('payroll.payslip_issued',jsonb_build_object('lineId',l.id,'payslipId',s.id,'event',event_name,
  'lineDigest',s.line_digest,'sha256',data->>'sha256'));
 RETURN jsonb_build_object('published',private.payslip_meta(s),'created',true);
END $$;

CREATE FUNCTION private.payslip_locator(ref text) RETURNS TABLE(storage_key text,display_name text,size_bytes bigint,sha256 text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF private.actor() IS NULL OR NOT EXISTS(SELECT 1 FROM private.identity() WHERE NOT must_change_password)
 THEN RAISE EXCEPTION 'Account access required' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT f.storage_key,f.display_name,f.size_bytes,f.sha256 FROM payslips s
 JOIN file_objects f ON f.id=s.file_id AND f.purpose='PAYSLIP' AND f.state='AVAILABLE'
 WHERE s.reference=ref AND private.can_payslip_line(s.line_id);
 IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
END $$;

CREATE FUNCTION private.payroll_export(report_kind text, first_day date, last_day date, employee uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE payload jsonb;
BEGIN
 IF NOT private.is_admin() THEN RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501'; END IF;
 IF first_day IS NULL OR last_day IS NULL OR last_day-first_day NOT BETWEEN 0 AND 30
 THEN RAISE EXCEPTION 'Choose a date range of 1 to 31 days' USING ERRCODE='22023'; END IF;
 IF report_kind='ZIP' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('reference',x.reference,'size',x.size_bytes) ORDER BY x.start_date,x.line_id,x.event),'[]')
  INTO payload FROM (
   SELECT s.reference,f.size_bytes,pp.start_date,l.id line_id,e.event
   FROM payroll_periods pp JOIN payroll_lines l ON l.period_id=pp.id AND l.state<>'DRAFT'
   CROSS JOIN LATERAL (SELECT 'APPROVAL'::text event UNION ALL SELECT 'PAYMENT' WHERE l.state='PAID') e
   LEFT JOIN payslips s ON s.line_id=l.id AND s.event=e.event
   LEFT JOIN file_objects f ON f.id=s.file_id AND f.purpose='PAYSLIP'
   WHERE pp.start_date BETWEEN first_day AND last_day AND (employee IS NULL OR l.employee_id=employee)
   ORDER BY pp.start_date,l.id,e.event LIMIT 101
  ) x;
 ELSIF report_kind='CSV' THEN
  SELECT coalesce(jsonb_agg(x.cells ORDER BY x.start_date,x.id),'[]') INTO payload FROM (
   SELECT pp.start_date,l.id,jsonb_build_array(pp.start_date,pp.end_date,pp.payday,
    coalesce(l.snapshot->'employee'->>'number',ep.employee_number),coalesce(l.snapshot->'employee'->>'name',ep.legal_name),
    l.revision,CASE WHEN l.state='PAID' THEN 'APPROVED' ELSE l.state END,
    CASE WHEN l.state='PAID' THEN 'PAID' WHEN l.state='APPROVED' AND l.net=0 THEN 'NO_DISBURSEMENT'
         WHEN l.state='APPROVED' THEN 'UNPAID' ELSE 'NOT_APPLICABLE' END,
    private.payroll_day(l.approved_at),p.payment_date,p.method,l.gross::text,l.deductions::text,l.net::text,'PHP') cells
   FROM payroll_periods pp JOIN payroll_lines l ON l.period_id=pp.id
   JOIN employee_profiles ep ON ep.user_id=l.employee_id LEFT JOIN payments p ON p.line_id=l.id
   WHERE pp.start_date BETWEEN first_day AND last_day AND (employee IS NULL OR l.employee_id=employee)
   ORDER BY pp.start_date,l.id LIMIT 50001
  ) x;
 ELSE RAISE EXCEPTION 'Invalid export' USING ERRCODE='22023'; END IF;
 RETURN payload;
END $$;

REVOKE ALL ON FUNCTION private.payslip_meta(public.payslips),private.payslip_read(uuid,int),private.payslip_source(uuid,text),
 private.payslip_storage_lock(text,text),private.payslip_publish(uuid,jsonb,text),private.payslip_locator(text),
 private.payroll_export(text,date,date,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.payslip_read(uuid,int),private.payslip_source(uuid,text),
 private.payslip_storage_lock(text,text),private.payslip_publish(uuid,jsonb,text),private.payslip_locator(text),
 private.payroll_export(text,date,date,uuid) TO libetario_runtime;
-- Name the local adjustment kind separately from the retained ledger column.
CREATE OR REPLACE FUNCTION private.payroll_line_command(target uuid,data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE l payroll_lines; pp payroll_periods; src payroll_lines; related payroll_adjustments; prior payroll_adjustments;
 actor uuid; action text=data->>'action'; reason text; evidence_note text; adjustment_kind text; result uuid=target; fp text;
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
  adjustment_kind=action;
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
   adjustment_kind='MANUAL'; after_values=jsonb_build_object('kind','ZERO_REVIEW','totals',l.gross::text||'/'||l.deductions::text);
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
  VALUES(l.id,pp.id,l.employee_id,adjustment_kind,shift_key,shift_ver,src.id,related.id,actor,reason,evidence_note,before_values,after_values,key,fp);
  IF l.state='DRAFT' OR action='REPLACE' THEN PERFORM private.payroll_rebuild(result); END IF;
 END IF;
 PERFORM private.write_audit('payroll.'||lower(action),jsonb_build_object('lineId',l.id,'result',result,'reason',reason,
  'evidence',evidence_note,'before',before_values,'change',after_values,'after',
  (SELECT jsonb_build_object('state',state,'gross',gross::text,'deductions',deductions::text,'net',net::text,'version',version)
   FROM payroll_lines WHERE id=result)));
 RETURN result;
END $$;

COMMIT;
