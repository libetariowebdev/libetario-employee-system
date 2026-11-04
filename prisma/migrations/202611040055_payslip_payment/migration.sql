BEGIN;

CREATE TABLE payments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 line_id uuid NOT NULL UNIQUE REFERENCES payroll_lines(id),
 payment_date date NOT NULL,
 method text NOT NULL CHECK(method ~ '^[A-Z][A-Z0-9_]{0,31}$'),
 normalized_reference text NOT NULL CHECK(normalized_reference ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$'),
 amount numeric(20,2) NOT NULL CHECK(amount>0 AND amount<'Infinity'::numeric),
 reference_policy_id uuid NOT NULL REFERENCES policy_versions(id),
 recorded_by uuid NOT NULL REFERENCES users(id),
 recorded_at timestamptz NOT NULL DEFAULT private.security_now(),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 10 AND 2000),
 operation_key uuid NOT NULL UNIQUE,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 UNIQUE(method,normalized_reference), UNIQUE(id,line_id)
);
CREATE TABLE payslips (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 line_id uuid NOT NULL REFERENCES payroll_lines(id),
 version int NOT NULL,
 reference text NOT NULL UNIQUE CHECK(reference ~ '^[a-f0-9]{32}$'),
 file_id uuid NOT NULL UNIQUE REFERENCES file_objects(id),
 event text NOT NULL,
 payment_id uuid,
 issued_by uuid NOT NULL REFERENCES users(id),
 issued_at timestamptz NOT NULL DEFAULT private.security_now(),
 line_digest text NOT NULL CHECK(line_digest ~ '^[a-f0-9]{64}$'),
 template_digest text NOT NULL CHECK(template_digest ~ '^[a-f0-9]{64}$'),
 has_logo boolean NOT NULL,
 UNIQUE(line_id,version), UNIQUE(line_id,event),
 FOREIGN KEY(payment_id,line_id) REFERENCES payments(id,line_id),
 CHECK((event='APPROVAL' AND version=1 AND payment_id IS NULL) OR
       (event='PAYMENT' AND version=2 AND payment_id IS NOT NULL))
);
ALTER TABLE file_objects ALTER COLUMN project_id DROP NOT NULL,
 ADD COLUMN purpose text NOT NULL DEFAULT 'WORK',
 ADD CONSTRAINT file_purpose CHECK(
  (purpose='WORK' AND project_id IS NOT NULL) OR
  (purpose='PAYSLIP' AND project_id IS NULL AND membership_version IS NULL
    AND declared_media_type='application/pdf' AND state='AVAILABLE'));

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payslips ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON payments,payslips FROM PUBLIC,libetario_auth,libetario_runtime;
CREATE POLICY payment_admin ON payments FOR SELECT TO libetario_runtime USING(private.is_admin());
GRANT SELECT(id,line_id,payment_date,method,amount,recorded_at) ON payments TO libetario_runtime;

CREATE FUNCTION private.can_payslip_line(target uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM payroll_lines l CROSS JOIN private.identity() i
  WHERE l.id=target AND l.state<>'DRAFT' AND NOT i.must_change_password
   AND (i.role='ADMINISTRATOR' OR (i.role='EMPLOYEE' AND i.user_id=l.employee_id)))
$$;
CREATE POLICY payslip_read ON payslips FOR SELECT TO libetario_runtime USING(private.can_payslip_line(line_id));
GRANT SELECT(id,line_id,version,reference,event,issued_at) ON payslips TO libetario_runtime;

CREATE TRIGGER payment_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON payments
 FOR EACH STATEMENT EXECUTE FUNCTION private.immutable();
CREATE TRIGGER payslip_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON payslips
 FOR EACH STATEMENT EXECUTE FUNCTION private.immutable();
CREATE TRIGGER payroll_line_no_truncate BEFORE TRUNCATE ON payroll_lines
 FOR EACH STATEMENT EXECUTE FUNCTION private.immutable();

CREATE OR REPLACE FUNCTION private.payroll_protect_line() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF OLD.state<>'DRAFT' THEN
  IF TG_OP='UPDATE' AND OLD.state='APPROVED'
    AND (NEW.state IN ('VOIDED','ADJUSTED') OR
      (NEW.state='PAID' AND EXISTS(SELECT 1 FROM payments p WHERE p.line_id=OLD.id AND p.amount=OLD.net)))
    AND to_jsonb(OLD)-ARRAY['state','version']=to_jsonb(NEW)-ARRAY['state','version']
    AND NEW.version=OLD.version+1 THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Frozen payroll line' USING ERRCODE='42501';
 END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Payroll lines are retained' USING ERRCODE='42501'; END IF;
 IF NEW.state NOT IN ('DRAFT','APPROVED') THEN
  RAISE EXCEPTION 'Invalid payroll state transition' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION private.payment_matches_line() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM payroll_lines WHERE id=NEW.line_id AND state='PAID' AND net=NEW.amount)
 THEN RAISE EXCEPTION 'Payment requires the exact paid payroll line' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payment_matches_line AFTER INSERT ON payments
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.payment_matches_line();

CREATE OR REPLACE FUNCTION private.file_owner_constraint() RETURNS trigger LANGUAGE plpgsql
 SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE target uuid; f file_objects; n int; pid uuid; slip boolean;
BEGIN
 IF TG_TABLE_NAME='file_objects' THEN target=NEW.id; ELSE target=NEW.file_id; END IF;
 SELECT * INTO STRICT f FROM file_objects WHERE id=target FOR UPDATE;
 SELECT count(*),min(owner_project::text)::uuid,bool_or(is_slip) INTO n,pid,slip FROM (
  SELECT p.project_id owner_project,false is_slip FROM project_files p WHERE p.file_id=target
  UNION ALL SELECT t.project_id,false FROM task_files x JOIN tasks t ON t.id=x.task_id WHERE x.file_id=target
  UNION ALL SELECT t.project_id,false FROM submission_files x JOIN task_submissions s ON s.id=x.submission_id
   JOIN task_assignments a ON a.id=s.assignment_id JOIN tasks t ON t.id=a.task_id WHERE x.file_id=target
  UNION ALL SELECT NULL,true FROM payslips x WHERE x.file_id=target
 ) owners;
 IF n<>1 OR pid IS DISTINCT FROM f.project_id OR slip IS DISTINCT FROM (f.purpose='PAYSLIP')
    OR (slip AND NOT EXISTS(SELECT 1 FROM payslips s JOIN payroll_lines l ON l.id=s.line_id
      WHERE s.file_id=f.id AND f.display_name='payslip-'||s.reference||'.pdf'
       AND l.snapshot_digest=s.line_digest AND l.state<>'DRAFT'))
 THEN RAISE EXCEPTION 'Exactly one matching typed file owner required' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payslip_file_owner_check AFTER INSERT ON payslips
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.file_owner_constraint();
ALTER POLICY file_read ON file_objects USING(purpose='WORK' AND private.can_file(id));
CREATE FUNCTION private.keep_file_purpose() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.purpose<>OLD.purpose THEN RAISE EXCEPTION 'Immutable file purpose' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER file_purpose_immutable BEFORE UPDATE OF purpose ON file_objects
 FOR EACH ROW EXECUTE FUNCTION private.keep_file_purpose();

CREATE FUNCTION private.payment_method(cfg jsonb, method_code text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT m FROM jsonb_array_elements(coalesce(cfg->'paymentMethods','[]')) m WHERE m->>'code'=method_code
$$;

CREATE FUNCTION private.payroll_record_payment(target uuid, data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE l payroll_lines; pp payroll_periods; p payments; pol policy_versions; actor uuid; fp text;
 day date=(data->>'date')::date; key uuid=(data->>'operationKey')::uuid; method_code text=data->>'method';
 raw_ref text=btrim(data->>'reference'); ref text; frozen jsonb; rules jsonb;
 amount_text text=data->>'amount'; amount_value numeric; note text;
BEGIN
 IF NOT private.is_admin() THEN RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501'; END IF;
 SELECT * INTO l FROM payroll_lines WHERE id=target;
 IF l.id IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
 actor=private.lock_work(true,ARRAY[l.employee_id]);
 SELECT * INTO STRICT pp FROM payroll_periods WHERE id=l.period_id FOR UPDATE;
 SELECT * INTO STRICT l FROM payroll_lines WHERE id=target FOR UPDATE;
 IF NOT private.admin_recent() THEN RAISE EXCEPTION 'Recent MFA required' USING ERRCODE='42501'; END IF;
 note=private.payroll_note(data->>'reason');
 IF key IS NULL OR day IS NULL OR method_code IS NULL OR raw_ref IS NULL OR
    jsonb_typeof(data->'amount') IS DISTINCT FROM 'string' OR
    jsonb_typeof(data->'expectedVersion') IS DISTINCT FROM 'number' OR
    jsonb_typeof(data->'expectedPeriodVersion') IS DISTINCT FROM 'number' OR
    raw_ref !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$' OR
    amount_text IS NULL OR amount_text !~ '^[0-9]{1,18}([.][0-9]{1,2})?$'
 THEN RAISE EXCEPTION 'Invalid payment fields' USING ERRCODE='22023'; END IF;
 amount_value=amount_text::numeric(20,2);
 frozen=private.payment_method(l.snapshot->'cutoffPolicy'->'configuration',method_code);
 ref=CASE frozen->>'reference' WHEN 'UPPER_ALNUM' THEN upper(raw_ref COLLATE "C") ELSE raw_ref END;
 fp=private.work_fingerprint(jsonb_build_object('line',target,'actor',actor,'date',day,
  'method',method_code,'reference',ref,'amount',amount_value::text,'reason',note,
  'lineVersion',data->'expectedVersion','periodVersion',data->'expectedPeriodVersion'));
 SELECT * INTO p FROM payments WHERE operation_key=key;
 IF FOUND THEN
  IF p.fingerprint<>fp THEN RAISE EXCEPTION 'Payment retry conflict' USING ERRCODE='40001'; END IF;
  RETURN p.id;
 END IF;
 IF l.state<>'APPROVED' OR pp.state<>'APPROVED' OR
    l.version IS DISTINCT FROM (data->>'expectedVersion')::int OR
    pp.version IS DISTINCT FROM (data->>'expectedPeriodVersion')::int
 THEN RAISE EXCEPTION 'Approved line changed' USING ERRCODE='40001'; END IF;
 IF l.net<=0 OR amount_value<>l.net THEN RAISE EXCEPTION 'Enter the exact positive net amount' USING ERRCODE='22023'; END IF;
 IF day>private.payroll_day(private.security_now()) OR day<pp.end_date
 THEN RAISE EXCEPTION 'Payment date is outside the permitted window' USING ERRCODE='22023'; END IF;
 pol=private.payroll_policy_at(day);
 IF pol.id IS NULL OR cardinality(private.payroll_missing(pol.configuration))<>0
 THEN RAISE EXCEPTION 'Configure the applicable PAY policy before recording payment' USING ERRCODE='P0422'; END IF;
 rules=private.payment_method(pol.configuration,method_code);
 IF rules IS NULL OR frozen IS NULL OR rules->>'reference' IS DISTINCT FROM frozen->>'reference'
 THEN RAISE EXCEPTION 'Payment method must be compatible with the approved policy' USING ERRCODE='22023'; END IF;
 IF (rules->>'reference'='DIGITS' AND ref !~ '^[0-9]{1,80}$') OR
    (day<pp.payday AND 'ON_OR_AFTER_PAYDAY' IN (rules->>'dateRule',frozen->>'dateRule'))
 THEN RAISE EXCEPTION 'Check the reference format and the approved payment date rule' USING ERRCODE='22023'; END IF;
 INSERT INTO payments(line_id,payment_date,method,normalized_reference,amount,reference_policy_id,recorded_by,reason,operation_key,fingerprint)
 VALUES(l.id,day,method_code,ref,amount_value,pol.id,actor,note,key,fp) RETURNING * INTO p;
 UPDATE payroll_lines SET state='PAID',version=version+1 WHERE id=l.id;
 PERFORM private.write_audit('payroll.payment_recorded',jsonb_build_object('paymentId',p.id,'lineId',l.id,
  'before','APPROVED','after','PAID','date',day,'method',method_code,'amount',amount_value::text,'reason',note,'policyId',pol.id));
 RETURN p.id;
END $$;

REVOKE ALL ON FUNCTION private.can_payslip_line(uuid),private.payment_matches_line(),
 private.keep_file_purpose(),private.payment_method(jsonb,text),private.payroll_record_payment(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.can_payslip_line(uuid),private.payroll_record_payment(uuid,jsonb) TO libetario_runtime;
COMMIT;
