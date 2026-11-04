BEGIN;
ALTER TABLE duty_authorizations ADD CONSTRAINT duty_attendance_parent UNIQUE(id,employee_id,duty_date);
ALTER TABLE employee_schedule_history ADD CONSTRAINT schedule_attendance_parent UNIQUE(id,employee_id);
CREATE TABLE attendance_shifts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),employee_id uuid NOT NULL REFERENCES employee_profiles(user_id) ON DELETE RESTRICT,
 duty_id uuid NOT NULL,duty_authorization_version integer NOT NULL CHECK(duty_authorization_version>0),duty_date date NOT NULL,
 grant_from timestamptz NOT NULL,grant_until timestamptz NOT NULL CHECK(grant_until>grant_from),shift_number integer NOT NULL CHECK(shift_number>0),
 recorded_in_at timestamptz,recorded_out_at timestamptz,system_closed_at timestamptz,
 clocked_in_at timestamptz NOT NULL,clocked_out_at timestamptz,source text NOT NULL CHECK(source IN('EMPLOYEE','CORRECTION')),
 close_source text,close_reason text,closed_by uuid REFERENCES users(id),origin_adjustment_id uuid,
 policy_id uuid NOT NULL REFERENCES policy_versions(id),schedule_id uuid,weekday integer,
 policy_snapshot jsonb NOT NULL CHECK(jsonb_typeof(policy_snapshot)='object'),schedule_snapshot jsonb,
 flags text[] NOT NULL DEFAULT '{}',acknowledged_flags text[] NOT NULL DEFAULT '{}',
 approval_status text NOT NULL DEFAULT 'PENDING' CHECK(approval_status IN('PENDING','APPROVED','REJECTED')),
 approved_payable_seconds numeric(20,6),suggested_at_review numeric(20,6),review_mode text,
 reviewed_by uuid REFERENCES users(id),reviewed_at timestamptz,review_reason text,
 clock_in_key uuid,clock_in_fingerprint text,clock_out_key uuid,clock_out_fingerprint text,review_receipts jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT private.security_now(),updated_at timestamptz NOT NULL DEFAULT private.security_now(),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 UNIQUE(id,employee_id),UNIQUE(duty_id,shift_number),UNIQUE(employee_id,clock_in_key),UNIQUE(employee_id,clock_out_key),
 FOREIGN KEY(duty_id,employee_id,duty_date) REFERENCES duty_authorizations(id,employee_id,duty_date) ON DELETE RESTRICT,
 FOREIGN KEY(schedule_id,employee_id) REFERENCES employee_schedule_history(id,employee_id) ON DELETE RESTRICT,
 FOREIGN KEY(schedule_id,weekday) REFERENCES employee_schedule_days(schedule_id,weekday) ON DELETE RESTRICT,
 CHECK((schedule_id IS NULL)=(weekday IS NULL)),CHECK(weekday IS NULL OR weekday BETWEEN 1 AND 7),
 CHECK(clocked_out_at IS NULL OR clocked_out_at>=clocked_in_at),CHECK(clocked_in_at>=grant_from AND clocked_in_at<grant_until),
 CHECK(clocked_out_at IS NULL OR clocked_out_at<=grant_until),
 CHECK((clocked_out_at IS NULL AND close_source IS NULL AND close_reason IS NULL) OR (clocked_out_at IS NOT NULL AND close_source IN('EMPLOYEE','SYSTEM','CORRECTION') AND length(close_reason)>0)),
 CHECK((source='EMPLOYEE' AND recorded_in_at IS NOT NULL AND origin_adjustment_id IS NULL) OR (source='CORRECTION' AND recorded_in_at IS NULL AND recorded_out_at IS NULL AND origin_adjustment_id IS NOT NULL)),
 CHECK(approved_payable_seconds IS NULL OR (approved_payable_seconds>=0 AND approved_payable_seconds<=extract(epoch FROM clocked_out_at-clocked_in_at))),
 CHECK((approval_status='PENDING' AND approved_payable_seconds IS NULL AND reviewed_by IS NULL AND reviewed_at IS NULL AND review_reason IS NULL) OR
 (approval_status IN('APPROVED','REJECTED') AND clocked_out_at IS NOT NULL AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND length(btrim(review_reason)) BETWEEN 10 AND 2000 AND ((approval_status='APPROVED' AND approved_payable_seconds IS NOT NULL) OR (approval_status='REJECTED' AND approved_payable_seconds IS NULL)))),
 EXCLUDE USING gist(employee_id WITH =,tstzrange(clocked_in_at,clocked_out_at,'[)') WITH &&) DEFERRABLE INITIALLY IMMEDIATE
);
CREATE UNIQUE INDEX attendance_one_open ON attendance_shifts(employee_id) WHERE clocked_out_at IS NULL;
CREATE INDEX ON attendance_shifts(duty_date,employee_id);CREATE INDEX ON attendance_shifts(approval_status,duty_date);
CREATE INDEX ON attendance_shifts(policy_id);CREATE INDEX ON attendance_shifts(schedule_id);CREATE INDEX ON attendance_shifts(reviewed_by);CREATE INDEX ON attendance_shifts(closed_by);
CREATE TABLE attendance_adjustments(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),employee_id uuid NOT NULL REFERENCES employee_profiles(user_id),duty_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN('AMEND_SHIFT','ADD_MISSING_SHIFT')),target_shift_id uuid,
 requested_by uuid NOT NULL REFERENCES users(id),reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 10 AND 2000),
 target_version integer,original_values jsonb NOT NULL,proposed_values jsonb NOT NULL,grant_snapshot jsonb NOT NULL,
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN('PENDING','APPROVED','REJECTED')),
 reviewed_by uuid REFERENCES users(id),reviewed_at timestamptz,review_reason text,
 applied_shift_id uuid,applied_before jsonb,applied_after jsonb,request_key uuid NOT NULL,fingerprint text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT private.security_now(),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 UNIQUE(id,employee_id),UNIQUE(requested_by,request_key),
 FOREIGN KEY(duty_id,employee_id) REFERENCES duty_authorizations(id,employee_id),
 FOREIGN KEY(target_shift_id,employee_id) REFERENCES attendance_shifts(id,employee_id),
 FOREIGN KEY(applied_shift_id,employee_id) REFERENCES attendance_shifts(id,employee_id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((kind='AMEND_SHIFT' AND target_shift_id IS NOT NULL AND target_version>0) OR (kind='ADD_MISSING_SHIFT' AND target_shift_id IS NULL AND target_version IS NULL)),
 CHECK(jsonb_typeof(original_values)='object' AND jsonb_typeof(proposed_values)='object' AND jsonb_typeof(grant_snapshot)='object'),
 CHECK((status='PENDING' AND reviewed_by IS NULL AND reviewed_at IS NULL AND review_reason IS NULL AND applied_shift_id IS NULL) OR
 (status IN('APPROVED','REJECTED') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND length(btrim(review_reason)) BETWEEN 10 AND 2000 AND ((status='APPROVED' AND applied_shift_id IS NOT NULL AND applied_before IS NOT NULL AND applied_after IS NOT NULL) OR (status='REJECTED' AND applied_shift_id IS NULL))))
);
CREATE UNIQUE INDEX attendance_one_pending_amend ON attendance_adjustments(target_shift_id) WHERE status='PENDING' AND kind='AMEND_SHIFT';
CREATE INDEX ON attendance_adjustments(employee_id,created_at);CREATE INDEX ON attendance_adjustments(status,created_at);CREATE INDEX ON attendance_adjustments(duty_id);CREATE INDEX ON attendance_adjustments(applied_shift_id);CREATE INDEX ON attendance_adjustments(reviewed_by);
ALTER TABLE attendance_shifts ADD CONSTRAINT shift_correction_origin FOREIGN KEY(origin_adjustment_id,employee_id) REFERENCES attendance_adjustments(id,employee_id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX ON attendance_shifts(origin_adjustment_id);
CREATE TABLE attendance_breaks(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),shift_id uuid NOT NULL,employee_id uuid NOT NULL,
 recorded_start timestamptz,recorded_end timestamptz,started_at timestamptz NOT NULL,ended_at timestamptz,
 code text NOT NULL,paid boolean NOT NULL,recorded_code text NOT NULL,recorded_paid boolean NOT NULL,
 allowance_seconds integer CHECK(allowance_seconds>=0),policy_id uuid NOT NULL REFERENCES policy_versions(id),
 source text NOT NULL CHECK(source IN('EMPLOYEE','CORRECTION')),origin_adjustment_id uuid,last_adjustment_id uuid,
 is_voided boolean NOT NULL DEFAULT false,end_reason text,ended_by uuid REFERENCES users(id),
 start_key uuid,end_key uuid,start_fingerprint text,end_fingerprint text,
 created_at timestamptz NOT NULL DEFAULT private.security_now(),updated_at timestamptz NOT NULL DEFAULT private.security_now(),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 UNIQUE(id,shift_id,employee_id),UNIQUE(employee_id,start_key),UNIQUE(employee_id,end_key),
 FOREIGN KEY(shift_id,employee_id) REFERENCES attendance_shifts(id,employee_id),
 FOREIGN KEY(origin_adjustment_id,employee_id) REFERENCES attendance_adjustments(id,employee_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(last_adjustment_id,employee_id) REFERENCES attendance_adjustments(id,employee_id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(ended_at IS NULL OR ended_at>=started_at),CHECK((ended_at IS NULL)=(end_reason IS NULL)),
 CHECK((source='EMPLOYEE' AND recorded_start IS NOT NULL AND origin_adjustment_id IS NULL) OR (source='CORRECTION' AND recorded_start IS NULL AND recorded_end IS NULL AND origin_adjustment_id IS NOT NULL)),
 CHECK(NOT is_voided OR (last_adjustment_id IS NOT NULL AND ended_at IS NOT NULL)),
 EXCLUDE USING gist(shift_id WITH =,tstzrange(started_at,ended_at,'[)') WITH &&) WHERE(NOT is_voided) DEFERRABLE INITIALLY IMMEDIATE
);
CREATE UNIQUE INDEX attendance_one_open_break ON attendance_breaks(shift_id) WHERE ended_at IS NULL AND NOT is_voided;
CREATE INDEX ON attendance_breaks(employee_id);CREATE INDEX ON attendance_breaks(policy_id);CREATE INDEX ON attendance_breaks(origin_adjustment_id);CREATE INDEX ON attendance_breaks(last_adjustment_id);CREATE INDEX ON attendance_breaks(ended_by);
CREATE FUNCTION private.attendance_visible(employee uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT private.work_actor() IS NOT NULL AND (private.is_admin() OR employee=private.work_actor())
$$;
REVOKE ALL ON FUNCTION private.attendance_visible(uuid) FROM PUBLIC;GRANT EXECUTE ON FUNCTION private.attendance_visible(uuid) TO libetario_runtime;
ALTER TABLE attendance_shifts ENABLE ROW LEVEL SECURITY;ALTER TABLE attendance_breaks ENABLE ROW LEVEL SECURITY;ALTER TABLE attendance_adjustments ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_attendance ON attendance_shifts FOR SELECT TO libetario_runtime USING(private.attendance_visible(employee_id));
CREATE POLICY own_break ON attendance_breaks FOR SELECT TO libetario_runtime USING(private.attendance_visible(employee_id));
CREATE POLICY own_adjustment ON attendance_adjustments FOR SELECT TO libetario_runtime USING(private.attendance_visible(employee_id));
REVOKE ALL ON attendance_shifts,attendance_breaks,attendance_adjustments FROM PUBLIC,libetario_runtime,libetario_auth;
GRANT SELECT ON attendance_shifts,attendance_breaks,attendance_adjustments TO libetario_runtime;
CREATE TRIGGER attendance_shifts_retain BEFORE DELETE OR TRUNCATE ON attendance_shifts FOR EACH STATEMENT EXECUTE FUNCTION private.immutable();
CREATE TRIGGER attendance_breaks_retain BEFORE DELETE OR TRUNCATE ON attendance_breaks FOR EACH STATEMENT EXECUTE FUNCTION private.immutable();
CREATE TRIGGER attendance_adjustments_retain BEFORE DELETE OR TRUNCATE ON attendance_adjustments FOR EACH STATEMENT EXECUTE FUNCTION private.immutable();
COMMIT;
