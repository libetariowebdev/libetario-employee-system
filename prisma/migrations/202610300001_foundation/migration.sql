CREATE EXTENSION IF NOT EXISTS btree_gist;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
GRANT USAGE ON SCHEMA public,private TO libetario_runtime,libetario_auth;

CREATE TYPE "Role" AS ENUM ('ADMINISTRATOR','EMPLOYEE');
CREATE TYPE "RateBasis" AS ENUM ('DAILY','HOURLY');
CREATE TYPE "EmploymentStatus" AS ENUM ('ACTIVE','INACTIVE');

CREATE TABLE users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL UNIQUE, username text NOT NULL UNIQUE,
 password_hash text NOT NULL, role "Role" NOT NULL DEFAULT 'EMPLOYEE', disabled_at timestamptz,
 must_change_password boolean NOT NULL DEFAULT true, authorization_version integer NOT NULL DEFAULT 1,
 password_changed_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
 CHECK(email=lower(btrim(email)) AND position('@' in email)>1),
 CHECK(username=lower(btrim(username)) AND username ~ '^[a-z0-9_.-]{3,40}$'), CHECK(authorization_version>0)
);
CREATE TABLE employee_profiles (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
 employee_number text NOT NULL UNIQUE, legal_name text NOT NULL, display_name text NOT NULL, contact text,
 designation text NOT NULL, start_date date NOT NULL, employment_status "EmploymentStatus" NOT NULL DEFAULT 'ACTIVE',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
 CHECK(length(btrim(employee_number))>0), CHECK(length(btrim(legal_name))>0), CHECK(length(btrim(display_name))>0)
);
CREATE TABLE policy_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), policy_key text NOT NULL CHECK(policy_key IN ('SECURITY','WORK','PAY')),
 revision integer NOT NULL CHECK(revision>0), configuration jsonb NOT NULL CHECK(jsonb_typeof(configuration)='object'),
 created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(policy_key,revision)
);
CREATE INDEX ON policy_versions(created_by);
CREATE TABLE company_settings (
 id integer PRIMARY KEY DEFAULT 1 CHECK(id=1), company_name text NOT NULL, timezone text NOT NULL DEFAULT 'Asia/Manila' CHECK(timezone='Asia/Manila'),
 currency text NOT NULL DEFAULT 'PHP' CHECK(currency='PHP'),
 security_policy_id uuid NOT NULL REFERENCES policy_versions(id) ON DELETE RESTRICT,
 work_policy_id uuid NOT NULL REFERENCES policy_versions(id) ON DELETE RESTRICT,
 pay_policy_id uuid NOT NULL REFERENCES policy_versions(id) ON DELETE RESTRICT,
 updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1
);
CREATE INDEX ON company_settings(security_policy_id); CREATE INDEX ON company_settings(work_policy_id); CREATE INDEX ON company_settings(pay_policy_id);
CREATE TABLE employee_schedule_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), employee_id uuid NOT NULL REFERENCES employee_profiles(user_id) ON DELETE RESTRICT,
 effective_from date NOT NULL, effective_to date, expected_daily_seconds integer NOT NULL CHECK(expected_daily_seconds>0 AND expected_daily_seconds<=86400),
 work_policy_id uuid NOT NULL REFERENCES policy_versions(id) ON DELETE RESTRICT, created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
 CHECK(effective_to IS NULL OR effective_to>effective_from), UNIQUE(employee_id,effective_from),
 EXCLUDE USING gist(employee_id WITH =, daterange(effective_from,effective_to,'[)') WITH &&)
);
CREATE INDEX ON employee_schedule_history(work_policy_id); CREATE INDEX ON employee_schedule_history(created_by);
CREATE TABLE employee_schedule_days (
 schedule_id uuid NOT NULL REFERENCES employee_schedule_history(id) ON DELETE RESTRICT, weekday integer NOT NULL CHECK(weekday BETWEEN 1 AND 7),
 working_day boolean NOT NULL, start_local time, end_local time, ends_next_day boolean NOT NULL DEFAULT false,
 paid_break_seconds integer NOT NULL DEFAULT 0 CHECK(paid_break_seconds>=0), unpaid_break_seconds integer NOT NULL DEFAULT 0 CHECK(unpaid_break_seconds>=0),
 PRIMARY KEY(schedule_id,weekday),
 CHECK((working_day AND start_local IS NOT NULL AND end_local IS NOT NULL AND (ends_next_day OR end_local>start_local)) OR (NOT working_day AND start_local IS NULL AND end_local IS NULL)),
 CHECK(paid_break_seconds+unpaid_break_seconds<=86400)
);
CREATE TABLE employee_rate_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), employee_id uuid NOT NULL REFERENCES employee_profiles(user_id) ON DELETE RESTRICT,
 basis "RateBasis" NOT NULL, amount numeric(18,4) NOT NULL CHECK(amount>=0), currency text NOT NULL DEFAULT 'PHP' CHECK(currency='PHP'),
 effective_from date NOT NULL, effective_to date, expected_daily_seconds integer NOT NULL CHECK(expected_daily_seconds>0 AND expected_daily_seconds<=86400),
 pay_policy_id uuid NOT NULL REFERENCES policy_versions(id) ON DELETE RESTRICT, created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
 CHECK(effective_to IS NULL OR effective_to>effective_from), UNIQUE(employee_id,effective_from),
 EXCLUDE USING gist(employee_id WITH =, daterange(effective_from,effective_to,'[)') WITH &&)
);
CREATE INDEX ON employee_rate_history(pay_policy_id); CREATE INDEX ON employee_rate_history(created_by);
CREATE TABLE sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 token_hash text NOT NULL UNIQUE CHECK(length(token_hash)=64), csrf_token_hash text NOT NULL CHECK(length(csrf_token_hash)=64),
 scope text NOT NULL DEFAULT 'ACCOUNT' CHECK(scope='ACCOUNT'), authorization_version integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
 idle_expires_at timestamptz NOT NULL, absolute_expires_at timestamptz NOT NULL, revoked_at timestamptz, revocation_reason text,
 CHECK(idle_expires_at>created_at AND absolute_expires_at>=idle_expires_at)
);
CREATE INDEX ON sessions(user_id); CREATE INDEX ON sessions(absolute_expires_at);
CREATE TABLE security_throttles (
 scope text NOT NULL, subject_digest text NOT NULL, window_started_at timestamptz NOT NULL DEFAULT now(),
 failure_count integer NOT NULL DEFAULT 0 CHECK(failure_count>=0), locked_until timestamptz, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(scope,subject_digest)
);
CREATE TABLE auth_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
 session_id uuid REFERENCES sessions(id) ON DELETE RESTRICT, event_type text NOT NULL, outcome text NOT NULL,
 subject_digest text, network_digest text, occurred_at timestamptz NOT NULL DEFAULT now(), metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX ON auth_events(user_id,occurred_at); CREATE INDEX ON auth_events(session_id);
CREATE TABLE audit_log (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
 session_id uuid REFERENCES sessions(id) ON DELETE RESTRICT, action text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(),
 request_id text NOT NULL, payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object')
);
CREATE INDEX ON audit_log(actor_user_id,occurred_at); CREATE INDEX ON audit_log(session_id);
CREATE TABLE credential_resets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 requested_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT, kind text NOT NULL DEFAULT 'PASSWORD' CHECK(kind='PASSWORD'),
 verification_note text NOT NULL CHECK(length(btrim(verification_note)) BETWEEN 10 AND 500), token_hash text NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), CHECK(expires_at>created_at)
);
CREATE INDEX ON credential_resets(user_id); CREATE INDEX ON credential_resets(requested_by);

-- Context is an unguessable session-token hash, NOT a user-supplied user/role claim.
-- Fixed search_path and table-owner function execution prevent recursive RLS checks.
CREATE FUNCTION private.identity() RETURNS TABLE(user_id uuid, role "Role", must_change_password boolean, session_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT u.id,u.role,u.must_change_password,s.id FROM public.sessions s JOIN public.users u ON u.id=s.user_id
 WHERE s.token_hash=current_setting('app.session_hash',true) AND s.revoked_at IS NULL AND u.disabled_at IS NULL
 AND s.authorization_version=u.authorization_version AND s.idle_expires_at>statement_timestamp() AND s.absolute_expires_at>statement_timestamp()
$$;
CREATE FUNCTION private.actor() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ SELECT user_id FROM private.identity() $$;
CREATE FUNCTION private.is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT coalesce((SELECT role='ADMINISTRATOR' AND NOT must_change_password FROM private.identity()),false)
$$;
CREATE FUNCTION private.can_read(employee uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT coalesce((SELECT NOT must_change_password AND (user_id=employee OR role='ADMINISTRATOR') FROM private.identity()),false)
$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.identity(),private.actor(),private.is_admin(),private.can_read(uuid) TO libetario_runtime;

-- Checkpoint 1: runtime has NO access to the other tables yet.
ALTER TABLE employee_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_rate_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY profile_read ON employee_profiles FOR SELECT TO libetario_runtime USING(private.can_read(user_id));
CREATE POLICY profile_insert ON employee_profiles FOR INSERT TO libetario_runtime WITH CHECK(private.is_admin());
CREATE POLICY profile_update ON employee_profiles FOR UPDATE TO libetario_runtime USING(private.is_admin()) WITH CHECK(private.is_admin());
CREATE POLICY rate_read ON employee_rate_history FOR SELECT TO libetario_runtime USING(private.can_read(employee_id));
CREATE POLICY rate_insert ON employee_rate_history FOR INSERT TO libetario_runtime WITH CHECK(private.is_admin() AND created_by=private.actor());
CREATE POLICY rate_update ON employee_rate_history FOR UPDATE TO libetario_runtime USING(private.is_admin()) WITH CHECK(private.is_admin());
GRANT SELECT,INSERT,UPDATE ON employee_profiles,employee_rate_history TO libetario_runtime;
