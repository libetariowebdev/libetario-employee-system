BEGIN;

ALTER TABLE policy_versions ADD COLUMN pay_effective_date date, ADD COLUMN pay_reason text,
 ADD CHECK ((pay_effective_date IS NULL AND pay_reason IS NULL) OR
   (policy_key='PAY' AND pay_effective_date IS NOT NULL AND pay_reason IS NOT NULL AND length(btrim(pay_reason)) BETWEEN 10 AND 2000));
CREATE UNIQUE INDEX pay_policy_effective ON policy_versions(pay_effective_date) WHERE pay_effective_date IS NOT NULL;
DROP POLICY policy_create ON policy_versions;
CREATE POLICY policy_create ON policy_versions FOR INSERT TO libetario_runtime
 WITH CHECK(private.is_admin() AND created_by=private.actor() AND policy_key<>'PAY' AND
   (policy_key<>'SECURITY' OR private.admin_recent()));
REVOKE UPDATE(pay_policy_id) ON company_settings FROM libetario_runtime;

CREATE TABLE earning_types (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 code text NOT NULL CHECK(code ~ '^[A-Z][A-Z0-9_]{0,31}$'),
 revision integer NOT NULL CHECK(revision>0),
 effective_date date NOT NULL,
 label text NOT NULL CHECK(length(btrim(label)) BETWEEN 1 AND 100),
 category text NOT NULL CHECK(category IN ('REGULAR','PREMIUM','ALLOWANCE','BONUS','ADJUSTMENT')),
 enabled boolean NOT NULL,
 rule jsonb NOT NULL CHECK(rule = CASE WHEN category='REGULAR' THEN '{"mode":"REGULAR"}'::jsonb ELSE '{"mode":"MANUAL"}'::jsonb END),
 actor_id uuid NOT NULL REFERENCES users(id),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 10 AND 2000),
 created_at timestamptz NOT NULL DEFAULT private.security_now(),
 UNIQUE(code,revision), UNIQUE(code,effective_date)
);
CREATE TABLE deduction_types (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 code text NOT NULL CHECK(code ~ '^[A-Z][A-Z0-9_]{0,31}$'),
 revision integer NOT NULL CHECK(revision>0),
 effective_date date NOT NULL,
 label text NOT NULL CHECK(length(btrim(label)) BETWEEN 1 AND 100),
 category text NOT NULL CHECK(category IN ('STATUTORY','CONTRIBUTION','WITHHOLDING','LOAN','OTHER','ADJUSTMENT')),
 enabled boolean NOT NULL,
 employee_id uuid REFERENCES employee_profiles(user_id),
 designation text CHECK(length(btrim(designation)) BETWEEN 1 AND 100),
 rule jsonb NOT NULL CHECK(coalesce(rule='{"mode":"MANUAL"}'::jsonb OR
   (jsonb_typeof(rule->'amount')='string' AND rule->>'amount' ~ '^[0-9]{1,12}\.[0-9]{2}$'
    AND rule=jsonb_build_object('mode','FIXED','amount',rule->>'amount')),false)),
 actor_id uuid NOT NULL REFERENCES users(id),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 10 AND 2000),
 created_at timestamptz NOT NULL DEFAULT private.security_now(),
 CHECK(num_nonnulls(employee_id,designation)=1),
 UNIQUE(code,revision), UNIQUE(code,effective_date)
);
CREATE INDEX ON deduction_types(employee_id);

CREATE TABLE payroll_periods (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 start_date date NOT NULL,
 end_date date NOT NULL CHECK(end_date=start_date+7),
 payday date NOT NULL CHECK(payday BETWEEN end_date AND end_date+28),
 cutoff_policy_id uuid NOT NULL REFERENCES policy_versions(id),
 state text NOT NULL DEFAULT 'DRAFT' CHECK(state IN ('DRAFT','APPROVED')),
 roster uuid[] NOT NULL CHECK(cardinality(roster) BETWEEN 1 AND 100),
 created_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT private.security_now(),
 approved_by uuid REFERENCES users(id),
 approved_at timestamptz,
 manifest text,
 receipts jsonb NOT NULL DEFAULT '{}',
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 CHECK((state='APPROVED')=(approved_at IS NOT NULL AND approved_by IS NOT NULL AND manifest IS NOT NULL)),
 UNIQUE(start_date,end_date),
 EXCLUDE USING gist(daterange(start_date,end_date,'[)') WITH &&)
);
CREATE TABLE payroll_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 period_id uuid NOT NULL REFERENCES payroll_periods(id),
 employee_id uuid NOT NULL REFERENCES employee_profiles(user_id),
 revision integer NOT NULL CHECK(revision>0),
 predecessor_id uuid,
 state text NOT NULL DEFAULT 'DRAFT' CHECK(state IN ('DRAFT','APPROVED','VOIDED','ADJUSTED','PAID')),
 currency text NOT NULL DEFAULT 'PHP' CHECK(currency='PHP'),
 gross numeric(20,2) NOT NULL DEFAULT 0 CHECK(gross>=0 AND gross<'Infinity'::numeric),
 deductions numeric(20,2) NOT NULL DEFAULT 0 CHECK(deductions>=0 AND deductions<'Infinity'::numeric),
 net numeric(20,2) NOT NULL DEFAULT 0 CHECK(net=gross-deductions),
 issues jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(issues)='array'),
 source_digest text,
 snapshot jsonb,
 snapshot_digest text,
 created_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT private.security_now(),
 approved_by uuid REFERENCES users(id),
 approved_at timestamptz,
 receipts jsonb NOT NULL DEFAULT '{}',
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 CHECK((revision=1)=(predecessor_id IS NULL)),
 CHECK((state<>'DRAFT')=(snapshot IS NOT NULL AND snapshot_digest IS NOT NULL AND approved_at IS NOT NULL AND approved_by IS NOT NULL)),
 CHECK(state='DRAFT' OR (net>=0 AND issues='[]')),
 UNIQUE(id,employee_id), UNIQUE(id,period_id,employee_id), UNIQUE(period_id,employee_id,revision),
 FOREIGN KEY(predecessor_id,period_id,employee_id) REFERENCES payroll_lines(id,period_id,employee_id)
);
CREATE UNIQUE INDEX payroll_one_draft ON payroll_lines(period_id,employee_id) WHERE state='DRAFT';
CREATE UNIQUE INDEX payroll_one_obligation ON payroll_lines(period_id,employee_id) WHERE state IN ('APPROVED','PAID');
CREATE UNIQUE INDEX payroll_one_replacement ON payroll_lines(predecessor_id) WHERE predecessor_id IS NOT NULL;
CREATE INDEX ON payroll_lines(employee_id,approved_at DESC);
ALTER TABLE employee_rate_history ADD UNIQUE(id,employee_id);

CREATE TABLE payroll_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 line_id uuid NOT NULL,
 employee_id uuid NOT NULL,
 sequence integer NOT NULL CHECK(sequence>0),
 service_date date NOT NULL,
 earning_id uuid REFERENCES earning_types(id),
 deduction_id uuid REFERENCES deduction_types(id),
 rate_id uuid,
 pay_policy_id uuid NOT NULL REFERENCES policy_versions(id),
 description text NOT NULL,
 amount numeric(20,2) NOT NULL CHECK(amount>=0 AND amount<'Infinity'::numeric),
 detail jsonb NOT NULL CHECK(jsonb_typeof(detail)='object'),
 UNIQUE(line_id,sequence), UNIQUE(id,line_id,employee_id),
 FOREIGN KEY(line_id,employee_id) REFERENCES payroll_lines(id,employee_id),
 FOREIGN KEY(rate_id,employee_id) REFERENCES employee_rate_history(id,employee_id),
 CHECK(num_nonnulls(earning_id,deduction_id)=1), CHECK(rate_id IS NULL OR earning_id IS NOT NULL)
);
CREATE TABLE payroll_item_attendance (
 item_id uuid NOT NULL,
 line_id uuid NOT NULL,
 employee_id uuid NOT NULL,
 shift_id uuid NOT NULL,
 shift_version integer NOT NULL CHECK(shift_version>0),
 duty_date date NOT NULL,
 service_date date NOT NULL,
 bounds tstzrange NOT NULL CHECK(NOT isempty(bounds) AND lower_inc(bounds) AND NOT upper_inc(bounds)),
 allocated_seconds numeric(20,6) NOT NULL CHECK(allocated_seconds>=0 AND allocated_seconds<=extract(epoch FROM upper(bounds)-lower(bounds))),
 evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object'),
 PRIMARY KEY(item_id,shift_id,service_date),
 FOREIGN KEY(item_id,line_id,employee_id) REFERENCES payroll_items(id,line_id,employee_id),
 FOREIGN KEY(shift_id,employee_id) REFERENCES attendance_shifts(id,employee_id),
 UNIQUE(line_id,shift_id,service_date)
);
CREATE INDEX ON payroll_item_attendance(shift_id,service_date);

CREATE TABLE payroll_adjustments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 line_id uuid NOT NULL,
 period_id uuid NOT NULL,
 employee_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('MANUAL','REMOVE_MANUAL','SOURCE','VOID','REPLACE','CORRECTION_NEEDED','POST_CORRECTION')),
 source_shift_id uuid,
 source_shift_version integer,
 source_line_id uuid,
 related_adjustment_id uuid REFERENCES payroll_adjustments(id),
 actor_id uuid NOT NULL REFERENCES users(id),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 10 AND 2000),
 evidence text NOT NULL CHECK(length(btrim(evidence)) BETWEEN 1 AND 2000),
 before_values jsonb NOT NULL,
 after_values jsonb NOT NULL,
 operation_key uuid NOT NULL,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT private.security_now(),
 FOREIGN KEY(line_id,period_id,employee_id) REFERENCES payroll_lines(id,period_id,employee_id),
 FOREIGN KEY(source_line_id,employee_id) REFERENCES payroll_lines(id,employee_id),
 FOREIGN KEY(source_shift_id,employee_id) REFERENCES attendance_shifts(id,employee_id),
 CHECK((kind='SOURCE')=(source_shift_id IS NOT NULL AND source_shift_version IS NOT NULL)),
 CHECK((kind='POST_CORRECTION')=(related_adjustment_id IS NOT NULL)),
 UNIQUE(line_id,operation_key)
);
CREATE UNIQUE INDEX payroll_source_review ON payroll_adjustments(source_shift_id,source_shift_version) WHERE kind='SOURCE';
CREATE UNIQUE INDEX payroll_post_once ON payroll_adjustments(related_adjustment_id) WHERE kind='POST_CORRECTION';
CREATE INDEX ON payroll_adjustments(employee_id,created_at);
CREATE INDEX ON payroll_adjustments(line_id,kind);

DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['earning_types','deduction_types','payroll_periods','payroll_lines','payroll_items','payroll_item_attendance','payroll_adjustments'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY payroll_admin ON %I FOR SELECT TO libetario_runtime USING(private.is_admin())',t);
 END LOOP;
END $$;
-- Use explicit, redacted read functions for employee access. Only the safe line
-- columns can be queried directly, with ownership still enforced by RLS.
CREATE POLICY payroll_own ON payroll_lines FOR SELECT TO libetario_runtime
 USING (state IN ('APPROVED','VOIDED','ADJUSTED','PAID') AND EXISTS(
  SELECT 1 FROM private.identity() i WHERE i.user_id=employee_id AND i.role='EMPLOYEE' AND NOT i.must_change_password));
GRANT SELECT(id,period_id,employee_id,revision,state,currency,gross,deductions,net,approved_at)
 ON payroll_lines TO libetario_runtime;
CREATE TRIGGER payroll_earning_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON earning_types FOR EACH STATEMENT EXECUTE FUNCTION private.immutable();
CREATE TRIGGER payroll_deduction_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON deduction_types FOR EACH STATEMENT EXECUTE FUNCTION private.immutable();
CREATE TRIGGER payroll_adjustment_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON payroll_adjustments FOR EACH STATEMENT EXECUTE FUNCTION private.immutable();

CREATE FUNCTION private.payroll_protect_line() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF OLD.state<>'DRAFT' THEN
  IF TG_OP='UPDATE' AND OLD.state='APPROVED' AND NEW.state IN ('VOIDED','ADJUSTED')
    AND to_jsonb(OLD)-ARRAY['state','version']=to_jsonb(NEW)-ARRAY['state','version']
    AND NEW.version=OLD.version+1 THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Frozen payroll line' USING ERRCODE='42501';
 END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Payroll lines are retained' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER payroll_line_frozen BEFORE UPDATE OR DELETE ON payroll_lines FOR EACH ROW EXECUTE FUNCTION private.payroll_protect_line();
CREATE FUNCTION private.payroll_protect_sources() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF (SELECT state FROM payroll_lines WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.line_id ELSE NEW.line_id END)<>'DRAFT'
    OR (TG_OP='UPDATE' AND (OLD.line_id<>NEW.line_id OR OLD.employee_id<>NEW.employee_id)) THEN
  RAISE EXCEPTION 'Frozen payroll source' USING ERRCODE='42501';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER payroll_items_frozen BEFORE INSERT OR UPDATE OR DELETE ON payroll_items FOR EACH ROW EXECUTE FUNCTION private.payroll_protect_sources();
CREATE TRIGGER payroll_links_frozen BEFORE INSERT OR UPDATE OR DELETE ON payroll_item_attendance FOR EACH ROW EXECUTE FUNCTION private.payroll_protect_sources();
CREATE TRIGGER payroll_period_frozen BEFORE UPDATE OR DELETE ON payroll_periods FOR EACH ROW
 WHEN (OLD.state='APPROVED') EXECUTE FUNCTION private.immutable();
REVOKE ALL ON FUNCTION private.payroll_protect_line(),private.payroll_protect_sources() FROM PUBLIC;
COMMIT;
