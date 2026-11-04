BEGIN;
CREATE FUNCTION private.payroll_line_summary(l payroll_lines) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('id',l.id,'periodId',l.period_id,'employeeId',l.employee_id,'revision',l.revision,'state',l.state,
  'version',l.version,'predecessorId',l.predecessor_id,'gross',l.gross::text,'deductions',l.deductions::text,'net',l.net::text,
  'approvedAt',l.approved_at,'issues',l.issues,'snapshotDigest',l.snapshot_digest,
  'employee',CASE WHEN l.state='DRAFT' THEN
   (SELECT ep.employee_number||' · '||ep.display_name FROM employee_profiles ep WHERE ep.user_id=l.employee_id)
   ELSE (l.snapshot->'employee'->>'number')||' · '||(l.snapshot->'employee'->>'name') END)
$$;

CREATE FUNCTION private.payroll_read(view_name text, target uuid DEFAULT NULL, page_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid=private.actor(); is_admin boolean=private.is_admin(); l payroll_lines; pp payroll_periods; pol policy_versions;
 result jsonb; details jsonb; offset_rows int=greatest(0,least(coalesce(page_offset,0),50000)); drift boolean;
BEGIN
 IF actor IS NULL OR NOT EXISTS(SELECT 1 FROM private.identity() i WHERE i.user_id=actor AND NOT i.must_change_password)
 THEN RAISE EXCEPTION 'Account access required' USING ERRCODE='42501'; END IF;
 IF view_name NOT IN ('own','own-line') AND NOT is_admin THEN
  RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501'; END IF;
 IF view_name='settings' THEN
  SELECT p.* INTO pol FROM company_settings s JOIN policy_versions p ON p.id=s.pay_policy_id WHERE s.id=1;
  IF pol.id IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
  RETURN jsonb_build_object('id',pol.id,'effectiveDate',pol.pay_effective_date,'revision',pol.revision,
   'configuration',CASE WHEN pol.pay_effective_date IS NULL THEN '{}'::jsonb ELSE pol.configuration END,
   'missing',private.payroll_missing(CASE WHEN pol.pay_effective_date IS NOT NULL THEN pol.configuration END),
   'weekdayLocked',EXISTS(SELECT 1 FROM payroll_periods),
   'regularConfigured',EXISTS(SELECT 1 FROM (SELECT enabled FROM earning_types WHERE code='REGULAR'
    AND effective_date<=private.payroll_day(private.security_now()) ORDER BY effective_date DESC LIMIT 1) x WHERE enabled),
   'earnings',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM (SELECT * FROM earning_types ORDER BY code,effective_date DESC LIMIT 250) x),
   'deductions',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM (SELECT * FROM deduction_types ORDER BY code,effective_date DESC LIMIT 250) x));
 ELSIF view_name='directory' THEN
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('id',user_id,'name',display_name,'number',employee_number,
   'status',employment_status,'startDate',start_date)),'[]') FROM
   (SELECT * FROM employee_profiles ORDER BY display_name,user_id OFFSET offset_rows LIMIT 100) ep);
 ELSIF view_name='periods' THEN
  RETURN (SELECT coalesce(jsonb_agg(to_jsonb(x)-ARRAY['receipts','roster','create_key','create_fingerprint']),'[]') FROM
   (SELECT * FROM payroll_periods ORDER BY start_date DESC OFFSET offset_rows LIMIT 50) x);
 ELSIF view_name='period' THEN
  SELECT * INTO pp FROM payroll_periods WHERE id=target;
  IF pp.id IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
  RETURN (to_jsonb(pp)-ARRAY['receipts','create_key','create_fingerprint'])||
   jsonb_build_object('reviewManifest',CASE WHEN pp.state='DRAFT' THEN private.payroll_manifest(pp.id) END,
    'cutoffPassed',private.security_now()>=private.payroll_midnight(pp.end_date),
    'lines',(SELECT coalesce(jsonb_agg(private.payroll_line_summary(x) ORDER BY employee_id,revision),'[]') FROM payroll_lines x WHERE period_id=target));
 ELSIF view_name='own' THEN
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('id',x.id,'state',x.state,'revision',x.revision,'gross',x.gross::text,
   'deductions',x.deductions::text,'net',x.net::text,'approvedAt',x.approved_at,'startDate',x.snapshot->'startDate',
   'endDate',x.snapshot->'endDate','payday',x.snapshot->'payday')),'[]') FROM
   (SELECT * FROM payroll_lines WHERE employee_id=actor AND state<>'DRAFT' ORDER BY approved_at DESC,id OFFSET offset_rows LIMIT 50) x);
 ELSIF view_name IN ('line','own-line') THEN
  SELECT * INTO l FROM payroll_lines WHERE id=target AND (view_name='line' OR (employee_id=actor AND state<>'DRAFT'));
  IF l.id IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
  IF view_name='own-line' THEN
   RETURN jsonb_build_object('id',l.id,'state',l.state,'revision',l.revision,'approvedAt',l.approved_at,'gross',l.gross::text,
    'deductions',l.deductions::text,'net',l.net::text,'startDate',l.snapshot->'startDate','endDate',l.snapshot->'endDate',
    'payday',l.snapshot->'payday','employee',l.snapshot->'employee','items',(
    SELECT coalesce(jsonb_agg(jsonb_build_object('sequence',i->'sequence','date',i->'date','description',i->'description',
     'kind',i->'kind','amount',i->'amount','detail',(i->'detail')-ARRAY['sourceLineId','adjustmentId','ratePolicy','rateVersion']) ORDER BY (i->>'sequence')::int),'[]')
    FROM jsonb_array_elements(l.snapshot->'items') i));
  END IF;
  SELECT * INTO pp FROM payroll_periods WHERE id=l.period_id;
  drift=l.state IN ('APPROVED','PAID') AND (
    EXISTS(SELECT 1 FROM payroll_item_attendance a JOIN attendance_shifts s ON s.id=a.shift_id WHERE a.line_id=l.id AND a.shift_version<>s.version)
    OR EXISTS(SELECT 1 FROM attendance_adjustments a JOIN duty_authorizations d ON d.id=a.duty_id
     WHERE a.employee_id=l.employee_id AND d.duty_date BETWEEN pp.start_date-1 AND pp.end_date-1
      AND (a.status='PENDING' OR a.status='APPROVED' AND a.reviewed_at>l.approved_at))
    OR EXISTS(SELECT 1 FROM attendance_shifts s WHERE s.employee_id=l.employee_id AND s.created_at>=l.approved_at
       AND s.clocked_in_at<private.payroll_midnight(pp.end_date) AND coalesce(s.clocked_out_at,s.grant_until)>private.payroll_midnight(pp.start_date)
       AND NOT EXISTS(SELECT 1 FROM payroll_item_attendance a WHERE a.line_id=l.id AND a.shift_id=s.id)));
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',i.id,'sequence',i.sequence,'date',i.service_date,'description',i.description,
    'kind',CASE WHEN i.earning_id IS NULL THEN 'DEDUCTION' ELSE 'EARNING' END,'amount',i.amount::text,'detail',i.detail,
    'attendance',(SELECT coalesce(jsonb_agg(evidence ORDER BY shift_id),'[]') FROM payroll_item_attendance a WHERE a.item_id=i.id))
    ORDER BY i.sequence),'[]') INTO details FROM payroll_items i WHERE i.line_id=l.id;
  RETURN private.payroll_line_summary(l)||jsonb_build_object('startDate',pp.start_date,'endDate',pp.end_date,'payday',pp.payday,
   'periodState',pp.state,'sourceChanged',drift,'items',details,'snapshot',l.snapshot,
   'adjustments',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.created_at,a.id),'[]') FROM payroll_adjustments a WHERE a.line_id=l.id),
   'laterPeriodCorrections',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'lineId',a.line_id,'reason',a.reason)),'[]')
    FROM payroll_adjustments a JOIN payroll_periods source_period ON source_period.id=a.period_id
    WHERE a.employee_id=l.employee_id AND a.kind='CORRECTION_NEEDED' AND source_period.end_date<=pp.start_date
     AND NOT EXISTS(SELECT 1 FROM payroll_adjustments used WHERE used.related_adjustment_id=a.id)),
   'workHolidays',(SELECT coalesce(p.configuration->'holidayDates',p.configuration->'attendance'->'holidayDates','[]') FROM
    company_settings s JOIN policy_versions p ON p.id=s.work_policy_id WHERE s.id=1));
 END IF;
 RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';
END $$;

REVOKE ALL ON FUNCTION private.payroll_line_summary(public.payroll_lines),private.payroll_read(text,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.payroll_read(text,uuid,integer) TO libetario_runtime;
COMMIT;
