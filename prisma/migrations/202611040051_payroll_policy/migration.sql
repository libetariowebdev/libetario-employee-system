BEGIN;
CREATE FUNCTION private.payroll_note(value text, minimum integer DEFAULT 10)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
 IF value IS NULL OR length(btrim(value)) NOT BETWEEN minimum AND 2000 THEN
  RAISE EXCEPTION 'A reason and supporting evidence are required' USING ERRCODE='22023';
 END IF;
 RETURN btrim(value);
END $$;

CREATE FUNCTION private.payroll_policy_valid(cfg jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE field text; val jsonb; allowed jsonb='{
 "source":["APPROVED_ATTENDANCE"], "breaks":["CONFIRM_CAPTURED"], "overnight":["REVIEWED_SPLIT"],
 "paidDay":["ANY_POSITIVE","MINIMUM_SECONDS"], "partialDay":["PRORATE","FULL","ZERO"],
 "lateness":["NO_ADJUSTMENT","REVIEW"], "overtime":["MANUAL","NONE"], "restDay":["MANUAL","NONE"],
 "holiday":["MANUAL","NONE"], "premium":["MANUAL","NONE"], "allowance":["MANUAL","NONE"], "bonus":["MANUAL","NONE"],
 "deductions":["CATALOG","NONE"], "contributions":["CATALOG","NONE"], "withholding":["CATALOG","NONE"], "loans":["CATALOG","NONE"],
 "timeRounding":["NONE","HALF_UP","HALF_EVEN","FLOOR","CEIL","TRUNCATE"],
 "moneyRounding":["NONE","HALF_UP","HALF_EVEN","FLOOR","CEIL","TRUNCATE"],
 "zeroNet":["REVIEW_NO_DISBURSEMENT"]
}'; method jsonb;
BEGIN
 IF cfg IS NULL OR jsonb_typeof(cfg)<>'object' THEN RETURN false; END IF;
 FOR field,val IN SELECT * FROM jsonb_each(cfg) LOOP
  IF allowed ? field THEN
   IF NOT ((allowed->field) @> jsonb_build_array(val)) THEN RETURN false; END IF;
  ELSIF field IN ('weekday','paydayOffset','timeUnitSeconds','moneyUnitCentavos','minimumDaySeconds') THEN
   IF jsonb_typeof(val)<>'number' OR val::text !~ '^[0-9]{1,6}$' OR
      (val::text::int NOT BETWEEN CASE field WHEN 'paydayOffset' THEN 0 ELSE 1 END AND
       CASE field WHEN 'weekday' THEN 7 WHEN 'paydayOffset' THEN 28 WHEN 'timeUnitSeconds' THEN 3600 WHEN 'moneyUnitCentavos' THEN 10000 ELSE 86400 END)
   THEN RETURN false; END IF;
  ELSIF field='minimumPay' THEN
   IF jsonb_typeof(val)<>'string' OR (cfg->>field <> 'NONE' AND cfg->>field !~ '^[0-9]{1,12}\.[0-9]{2}$') THEN RETURN false; END IF;
  ELSIF field='paymentMethods' THEN
   IF jsonb_typeof(val)<>'array' OR jsonb_array_length(val) NOT BETWEEN 1 AND 12 THEN RETURN false; END IF;
   FOR method IN SELECT jsonb_array_elements(val) LOOP
    IF jsonb_typeof(method)<>'object' OR
      NOT (method ?& ARRAY['code','reference','dateRule']) OR
      method-ARRAY['code','reference','dateRule']<>'{}' OR
      coalesce(method->>'code','') !~ '^[A-Z][A-Z0-9_]{0,31}$' OR
      coalesce(method->>'reference','') NOT IN ('EXACT_ALNUM','UPPER_ALNUM','DIGITS') OR
      coalesce(method->>'dateRule','') NOT IN ('ON_OR_AFTER_CUTOFF','ON_OR_AFTER_PAYDAY')
    THEN RETURN false; END IF;
   END LOOP;
   IF (SELECT count(DISTINCT v->>'code') FROM jsonb_array_elements(val) v)<>jsonb_array_length(val) THEN RETURN false; END IF;
  ELSE RETURN false;
  END IF;
 END LOOP;
 RETURN true;
END $$;

CREATE FUNCTION private.payroll_missing(cfg jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT ARRAY(SELECT name FROM unnest(ARRAY[
 'source','breaks','overnight','paidDay','partialDay','minimumPay','lateness','overtime','restDay','holiday',
 'premium','allowance','bonus','deductions','contributions','withholding','loans','timeRounding','moneyRounding',
 'weekday','paydayOffset','paymentMethods','zeroNet']) name WHERE NOT coalesce(cfg ? name,false))
 || CASE WHEN cfg->>'paidDay'='MINIMUM_SECONDS' AND NOT cfg ? 'minimumDaySeconds' THEN ARRAY['minimumDaySeconds'] ELSE '{}' END
 || CASE WHEN cfg->>'timeRounding'<>'NONE' AND NOT cfg ? 'timeUnitSeconds' THEN ARRAY['timeUnitSeconds'] ELSE '{}' END
 || CASE WHEN cfg->>'moneyRounding'<>'NONE' AND NOT cfg ? 'moneyUnitCentavos' THEN ARRAY['moneyUnitCentavos'] ELSE '{}' END
$$;

CREATE FUNCTION private.payroll_validate_policy_row() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.pay_effective_date IS NOT NULL AND NOT private.payroll_policy_valid(NEW.configuration) THEN
  RAISE EXCEPTION 'Invalid payroll policy' USING ERRCODE='22023';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER payroll_policy_shape BEFORE INSERT ON policy_versions FOR EACH ROW EXECUTE FUNCTION private.payroll_validate_policy_row();

CREATE FUNCTION private.payroll_policy_at(day date) RETURNS public.policy_versions
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT p FROM policy_versions p WHERE p.policy_key='PAY' AND p.pay_effective_date<=day
 ORDER BY p.pay_effective_date DESC LIMIT 1
$$;

CREATE FUNCTION private.payroll_configure(data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE current_id uuid; id_new uuid; actor_id uuid; cfg jsonb=data->'configuration'; reason text;
 day date=(data->>'effectiveDate')::date; old_cfg jsonb; method jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(72426820::bigint);
 actor_id=private.lock_work(true);
 IF NOT private.admin_recent() THEN RAISE EXCEPTION 'Recent MFA required' USING ERRCODE='42501'; END IF;
 reason=private.payroll_note(data->>'reason');
 SELECT pay_policy_id INTO current_id FROM company_settings WHERE id=1;
 IF current_id IS DISTINCT FROM (data->>'expectedId')::uuid THEN RAISE EXCEPTION 'Configuration changed' USING ERRCODE='40001'; END IF;
 IF day IS NULL OR day NOT BETWEEN '2000-01-01' AND '2099-12-31' OR NOT private.payroll_policy_valid(cfg)
 THEN RAISE EXCEPTION 'Invalid payroll policy' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM payroll_periods pp JOIN policy_versions p ON p.id=pp.cutoff_policy_id
    WHERE cfg->>'weekday' IS DISTINCT FROM p.configuration->>'weekday')
 THEN RAISE EXCEPTION 'Cutoff weekday is fixed once periods exist' USING ERRCODE='P0409'; END IF;
 SELECT configuration INTO old_cfg FROM policy_versions WHERE id=current_id;
 FOR method IN SELECT jsonb_array_elements(coalesce(cfg->'paymentMethods','[]')) LOOP
  IF EXISTS(SELECT 1 FROM policy_versions p CROSS JOIN LATERAL jsonb_array_elements(coalesce(p.configuration->'paymentMethods','[]')) m
   WHERE p.pay_effective_date IS NOT NULL AND m->>'code'=method->>'code' AND m->>'reference'<>method->>'reference')
  THEN RAISE EXCEPTION 'Use a new method code for a different reference format' USING ERRCODE='22023'; END IF;
 END LOOP;
 INSERT INTO policy_versions(policy_key,revision,configuration,created_by,pay_effective_date,pay_reason)
 SELECT 'PAY',coalesce(max(revision),0)+1,cfg,actor_id,day,reason FROM policy_versions WHERE policy_key='PAY' RETURNING id INTO id_new;
 UPDATE company_settings SET pay_policy_id=id_new,version=version+1,updated_at=private.security_now() WHERE id=1;
 PERFORM private.write_audit('payroll.policy',jsonb_build_object('id',id_new,'before',old_cfg,'after',cfg,'reason',reason,'effectiveDate',day));
 RETURN id_new;
END $$;

CREATE FUNCTION private.payroll_catalog(data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor_id uuid; target text=data->>'kind'; code_in text=upper(btrim(data->>'code'));
 category_in text=data->>'category'; day date=(data->>'effectiveDate')::date;
 note text; added uuid; previous jsonb; after_values jsonb; rev integer; cfg jsonb=data->'rule';
BEGIN
 PERFORM pg_advisory_xact_lock(72426820::bigint);
 actor_id=private.lock_work(true);
 IF NOT private.admin_recent() THEN RAISE EXCEPTION 'Recent MFA required' USING ERRCODE='42501'; END IF;
 note=private.payroll_note(data->>'reason');
 IF day IS NULL OR day NOT BETWEEN '2000-01-01' AND '2099-12-31' OR jsonb_typeof(data->'enabled') IS DISTINCT FROM 'boolean' THEN
  RAISE EXCEPTION 'Invalid catalog revision' USING ERRCODE='22023'; END IF;
 IF target='EARNING' THEN
  SELECT to_jsonb(e),revision INTO previous,rev FROM earning_types e WHERE code=code_in ORDER BY revision DESC LIMIT 1;
  IF category_in='REGULAR' AND code_in<>'REGULAR' OR code_in='REGULAR' AND category_in<>'REGULAR' THEN
   RAISE EXCEPTION 'Use the REGULAR code for regular earnings' USING ERRCODE='22023'; END IF;
  INSERT INTO earning_types AS e(code,revision,effective_date,label,category,enabled,rule,actor_id,reason)
  VALUES(code_in,coalesce(rev,0)+1,day,btrim(data->>'label'),category_in,(data->>'enabled')::boolean,cfg,actor_id,note)
  RETURNING id,to_jsonb(e) INTO added,after_values;
 ELSIF target='DEDUCTION' THEN
  SELECT to_jsonb(d),revision INTO previous,rev FROM deduction_types d WHERE code=code_in ORDER BY revision DESC LIMIT 1;
  INSERT INTO deduction_types AS d(code,revision,effective_date,label,category,enabled,employee_id,designation,rule,actor_id,reason)
  VALUES(code_in,coalesce(rev,0)+1,day,btrim(data->>'label'),category_in,(data->>'enabled')::boolean,
   (data->>'employeeId')::uuid,nullif(btrim(data->>'designation'),''),cfg,actor_id,note)
  RETURNING id,to_jsonb(d) INTO added,after_values;
 ELSE RAISE EXCEPTION 'Unknown catalog' USING ERRCODE='22023';
 END IF;
 PERFORM private.write_audit('payroll.catalog',jsonb_build_object('id',added,'kind',target,'reason',note,'before',previous,'after',after_values));
 RETURN added;
END $$;

-- Integer quotient and remainder avoid rounding a repeating decimal before a tie check.
CREATE FUNCTION private.payroll_quantize(n numeric,d numeric,unit numeric,mode text)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE denominator numeric=d*unit; whole numeric; rem numeric;
BEGIN
 IF n<0 OR d<=0 OR unit<=0 OR trunc(n)<>n OR trunc(d)<>d OR trunc(unit)<>unit THEN
  RAISE EXCEPTION 'Invalid exact payroll ratio' USING ERRCODE='22023';
 END IF;
 whole=div(n,denominator); rem=mod(n,denominator);
 IF mode='NONE' THEN RETURN CASE WHEN rem=0 THEN whole*unit END; END IF;
 IF mode='CEIL' AND rem>0 OR mode='HALF_UP' AND 2*rem>=denominator OR
    mode='HALF_EVEN' AND (2*rem>denominator OR 2*rem=denominator AND mod(whole,2)=1)
 THEN whole=whole+1;
 ELSIF mode NOT IN ('CEIL','HALF_UP','HALF_EVEN','FLOOR','TRUNCATE') THEN
  RAISE EXCEPTION 'Invalid rounding rule' USING ERRCODE='22023';
 END IF;
 RETURN whole*unit;
END $$;

REVOKE ALL ON FUNCTION private.payroll_note(text,integer),private.payroll_policy_valid(jsonb),private.payroll_missing(jsonb),
 private.payroll_validate_policy_row(),private.payroll_policy_at(date),private.payroll_configure(jsonb),
 private.payroll_catalog(jsonb),private.payroll_quantize(numeric,numeric,numeric,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.payroll_configure(jsonb),private.payroll_catalog(jsonb) TO libetario_runtime;
COMMIT;
