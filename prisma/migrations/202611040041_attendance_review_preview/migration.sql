BEGIN;
CREATE OR REPLACE FUNCTION private.attendance_bulk_preview(filters jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE ids uuid[];cfg jsonb;result jsonb;first_day date=coalesce((filters->>'from')::date,(private.security_now() AT TIME ZONE 'Asia/Manila')::date);last_day date=coalesce((filters->>'to')::date,first_day);
BEGIN
 IF NOT private.is_admin() OR NOT private.admin_recent() THEN RAISE EXCEPTION 'Recent administrator MFA required' USING ERRCODE='42501';END IF;
 cfg=private.attendance_policy();IF last_day-first_day>=(cfg->>'bulkMaxDays')::int THEN RAISE EXCEPTION 'Bulk date range too large' USING ERRCODE='22023';END IF;
 ids=private.attendance_filter_ids(filters,true);IF cardinality(ids)>(cfg->>'bulkMaxShifts')::int THEN RAISE EXCEPTION 'Bulk limit exceeded; narrow filters' USING ERRCODE='22023';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'version',s.version,'employeeName',p.display_name,'employeeNumber',p.employee_number,'dutyDate',s.duty_date,'clockedInAt',s.clocked_in_at,'clockedOutAt',s.clocked_out_at,'suggestedSeconds',private.attendance_suggested(s.id)::text) ORDER BY s.duty_date,p.display_name,s.id),'[]') INTO result FROM attendance_shifts s JOIN employee_profiles p ON p.user_id=s.employee_id WHERE s.id=ANY(ids);
 RETURN jsonb_build_object('eligible',result,'excluded',cardinality(private.attendance_filter_ids(filters,false))-cardinality(ids),'asOf',private.security_now());
END $$;
-- Zero-duration break events remain evidence and require individual review.
CREATE FUNCTION private.attendance_zero_break_flag() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT NEW.is_voided AND NEW.ended_at=NEW.started_at THEN
  UPDATE attendance_shifts SET flags=ARRAY(SELECT DISTINCT unnest(flags||ARRAY['ZERO_DURATION_BREAK']) ORDER BY 1) WHERE id=NEW.shift_id;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER attendance_zero_break AFTER INSERT OR UPDATE ON attendance_breaks FOR EACH ROW EXECUTE FUNCTION private.attendance_zero_break_flag();
REVOKE ALL ON FUNCTION private.attendance_zero_break_flag() FROM PUBLIC,libetario_runtime,libetario_auth;
COMMIT;
