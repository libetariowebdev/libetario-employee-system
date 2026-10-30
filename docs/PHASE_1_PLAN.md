# Phase 1 plan — Foundation

Status: full-system design reference. The owner approved Phase 1 with the migration boundary below on 30 October 2026.

Only users, employee_profiles, policy_versions, company_settings, employee_schedule_history/days, employee_rate_history, sessions, security_throttles, auth_events, audit_log, and credential_resets migrate in Phase 1. All other tables below are future design only. Prove restricted-runtime-role RLS on profiles and rates before extending it to the other Phase 1 tables. Hosting is local only pending a concrete host selection. Employees may read their own rate history.

Source: `docs/BLUEPRINT.md`, Master Development Blueprint v1.0, 30 October 2026. The attached original was copied byte-for-byte into this repository. The workspace was empty and no applicable `AGENTS.md` was found.

## Scope and sequence

1. Set up Next.js App Router, TypeScript, Tailwind, Prisma, a dedicated PostgreSQL database, local database tooling, `.env.example`, and test tooling. Select supported dependency versions at implementation time and commit the lockfile.
2. Implement only the approved Phase 1 subset with Prisma migrations and reviewed SQL for PostgreSQL-specific constraints, row security, permissions, and audit protection. Retain the complete structural model below as design only.
3. Implement password login using email or username, Argon2id hashes, persisted opaque sessions, account disabling, password changes/resets, login throttling/lockout, CSRF checks, and append-only security/audit events.
4. Implement Administrator-only employee creation, editing, disabling, effective-dated rates, and schedules. Employees receive read-only access to their own profile, schedule, and rates. No public registration or employee directory.
5. Build responsive sidebar shells. The administrator sees real employee/account totals and profile-management links. The employee sees their own profile and schedule. Later features are labeled unavailable; no invented operational or financial figures.
6. Run the Phase 1 tests, migration checks, type checking, and production build. Report results, run instructions, gaps, and owner decisions. Stop before Phase 2 until the owner approves it.

Phase 1 sessions have ACCOUNT scope only. They cannot authorize duty, clock-in, timers, or payroll. Phase 2 adds the blueprint's complete duty authorization + optional PIN + TOTP flow. This follows the explicit phase gates and does not treat password-only authentication as secure duty login.

## Proposed folder structure

```text
src/
  app/
    (auth)/login/
    (auth)/change-password/
    (admin)/admin/{employees,settings}/
    (employee)/me/{profile,schedule}/
    api/{auth,admin,me}/
  components/{ui,layout,employees}/
  server/
    auth/                 # passwords, sessions, throttling, CSRF
    authorization/        # role/ownership guards and request context
    dal/                  # scoped, server-only database access
    services/             # transactional employee/profile operations
    validation/
    audit/
  lib/{money,time,config}/
prisma/
  schema.prisma
  migrations/             # Prisma DDL plus explicit SQL constraints/RLS
  seed.ts
tests/{unit,integration,e2e}/
scripts/                  # local setup, checks, backup/restore helpers
docs/{BLUEPRINT,ASSUMPTIONS,PHASE_1_PLAN}.md
README.md
.env.example
compose.yaml
```

Route groups organize UI only; they do not grant authorization. Sensitive modules use `server-only`. Protected responses are private and uncached. Mutations validate input, session, role, ownership, and CSRF on the server before entering a transaction.

## Complete proposed database schema

This is the target schema for the whole blueprint, not a claim that later workflows are implemented in Phase 1.

### Notation and common rules

- Every table has a UUID primary key `id` unless a different primary key is explicitly given. UUIDs do not replace access checks.
- All columns are NOT NULL unless suffixed `?`. All persisted instants use `timestamptz`; local duty/payroll/calendar dates use PostgreSQL `date`. Creation instants default to database time. Mutable records also have `updated_at` and an integer `version` for optimistic concurrency.
- `FK table.column` means an actual foreign key. Deletes use RESTRICT; no cascading removal of employment, time, audit, or payroll history. Each FK receives a supporting index unless already covered by an index prefix. Composite ownership keys are specified below.
- `UQ(...)` means an actual unique constraint/index. All statuses and categories below are database enums or CHECK-constrained values; arbitrary text is not accepted as a status.
- Monetary amounts use `numeric(18,2)`; rates use `numeric(18,4)`. Fractional quantities use `numeric(18,8)`; durations use integer seconds. PHP is the only currency, enforced by CHECK. Decimal inputs/outputs cross JSON boundaries as strings. No JavaScript Number arithmetic for money.
- Effective intervals are half-open `[effective_from,effective_to)`; NULL end means indefinite. `effective_to > effective_from` when present. SQL exclusion constraints reject overlap per employee.
- JSONB is used for versioned policy/snapshot/event payloads, with application schemas and database object/required-field checks. Identity, ownership, money, states, and relational links remain typed columns.

### Identity, employees, schedules, and settings

| Table | Columns and relational constraints |
| --- | --- |
| `users` | `id`, `email`, `username`, `password_hash`, `role` ADMINISTRATOR/EMPLOYEE, `disabled_at?`, `must_change_password`, `authorization_version bigint`, `password_changed_at`, timestamps/version. UQ canonical lowercase email; UQ canonical lowercase username. Username excludes `@` to make email/username lookup unambiguous. Password/PIN/security fields never appear in employee DTOs. |
| `employee_profiles` | `user_id` PK/FK users.id; `employee_number` UQ, `legal_name`, `display_name`, `contact?`, `designation`, `start_date`, `employment_status` ACTIVE/INACTIVE, timestamps/version. Designation grants no permissions. |
| `policy_versions` | `id`, `policy_key`, `revision` positive integer, `configuration jsonb`, `created_by` FK users.id, `created_at`. UQ(policy_key, revision). Append-only, schema-validated policy versions cover security, work, and pay rules. |
| `company_settings` | `id` fixed singleton, `company_name`, `timezone` CHECK Asia/Manila, `currency` CHECK PHP, `security_policy_id`, `work_policy_id`, `pay_policy_id` each FK policy_versions.id; timestamps/version. Validate referenced policy keys in a constraint trigger. |
| `employee_schedule_history` | `id`, `employee_id` FK employee_profiles.user_id, `effective_from`, `effective_to?`, `expected_daily_seconds`, `work_policy_id` FK policy_versions.id, `created_by` FK users.id, timestamps/version. Positive expected seconds; exclusion constraint on employee + effective date range. |
| `employee_schedule_days` | PK(`schedule_id`,`weekday`); `schedule_id` FK employee_schedule_history.id, ISO `weekday` CHECK 1..7, `working_day`, `start_local? time`, `end_local? time`, `ends_next_day`, `paid_break_seconds`, `unpaid_break_seconds`. Nonnegative breaks, valid start/end pair for working days, and positive scheduled duration. |
| `employee_rate_history` | `id`, `employee_id` FK employee_profiles.user_id, `basis` DAILY/HOURLY, `amount numeric(18,4)` CHECK >= 0, `currency` CHECK PHP, `effective_from`, `effective_to?`, `expected_daily_seconds` CHECK > 0, `pay_policy_id` FK policy_versions.id, `created_by` FK users.id, timestamps/version. UQ(employee_id, effective_from); exclusion constraint on employee + effective date range. No inferred wage or statutory rate. |
| `holiday_calendar` | `id`, `local_date`, `name`, `classification`, `pay_policy_id` FK policy_versions.id, `created_by` FK users.id, timestamps/version. UQ(local_date, classification). No automatic premium inferred from a date or label. |
| `earning_types` | `id`, `code` UQ, `name`, `category` REGULAR/OVERTIME/PREMIUM/BONUS/ALLOWANCE/ADJUSTMENT, `configuration jsonb`, `enabled`, `created_by` FK users.id, timestamps/version. Configuration is a validated rule description, never executable code. |
| `deduction_types` | `id`, `code` UQ, `name`, `category` STATUTORY/OTHER, `configuration jsonb`, `enabled`, `created_by` FK users.id, timestamps/version. Initially empty; no Philippine statutory percentages or amounts seeded. |

Administrative actor FKs reference real users. Server guards and database constraint triggers require the actor to be an enabled administrator when creating administrative records. Historical records remain valid if that actor is later disabled.

### Authentication, duty, and audit

| Table | Columns and relational constraints |
| --- | --- |
| `sessions` | `id`, `user_id` FK users.id, `token_hash` UQ, `csrf_token_hash`, `scope` ACCOUNT/DUTY, `authorization_version`, `duty_id?`, `created_at`, `last_seen_at`, `idle_expires_at`, `absolute_expires_at`, `revoked_at?`, `revocation_reason?`. CHECK expiry ordering; ACCOUNT requires NULL duty, DUTY requires duty. Composite FK(duty_id,user_id) to duty_authorizations(id,employee_id). Only hashes of random session tokens are stored. |
| `auth_challenges` | `id`, `user_id` FK users.id, `challenge_token_hash` UQ, `purpose` DUTY_LOGIN/MFA_ENROLLMENT/RECOVERY, `duty_id?`, `password_verified_at`, `pin_verified_at?`, `expires_at`, `consumed_at?`, `failed_attempts`. Composite duty/employee FK; finite expiry; atomic single consumption. A challenge is not a duty session. |
| `mfa_enrollments` | `id`, `user_id` FK users.id UQ, `ciphertext bytea`, `nonce bytea`, `tag bytea`, `encryption_key_id`, `algorithm` CHECK SHA1, `digits` CHECK 6, `period_seconds` CHECK 30, `pending_expires_at?`, `confirmed_at?`, `last_accepted_step bigint?`, `revoked_at?`, timestamps/version. Encrypt using authenticated encryption and user-bound associated data; do not persist the QR or plaintext secret. |
| `employee_pins` | `user_id` PK/FK users.id, `pin_hash`, `changed_at`. No reversible or plaintext PIN storage. |
| `recovery_codes` | `id` random public lookup identifier, `enrollment_id` FK mfa_enrollments.id, `code_hash`, `created_at`, `consumed_at?`. Argon2id hash of the secret portion; atomic NULL-to-consumed update allows one use only. |
| `credential_resets` | `id`, `user_id` FK users.id, `requested_by` FK users.id, `kind` PASSWORD/PIN/AUTHENTICATOR, `verification_note`, `token_hash?` UQ when present, `expires_at`, `consumed_at?`, `created_at`. Identity verification and reason are mandatory; reset invalidates sessions. MFA recovery is a Phase 2 workflow. |
| `security_throttles` | PK(`scope`,`subject_digest`); scope LOGIN_ACCOUNT/LOGIN_NETWORK/PIN/TOTP/RECOVERY, keyed digest of normalized account/network identifier, `window_started_at`, `failure_count` CHECK >= 0, `locked_until?`, `updated_at`. Persisted atomic counters work across app instances and for nonexistent accounts. |
| `auth_events` | `id`, `user_id?` FK users.id, `session_id?` FK sessions.id, `event_type`, `outcome`, `subject_digest?`, `network_digest?`, `occurred_at`, `metadata jsonb`. Append-only. Unknown-account failures need no fake user FK. Never store submitted credentials, raw tokens, or TOTP values. |
| `duty_authorizations` | `id`, `employee_id` FK employee_profiles.user_id, `duty_date`, `status` ACTIVATED/COMPLETED/REVOKED, `granted_by` FK users.id, `granted_at`, `revoked_by?` FK users.id, `revoked_at?`, `reason?`, `valid_until`, timestamps/version. UQ(employee_id,duty_date), UQ(id,employee_id). Revocation fields are all present together. Regrant is an audited state transition of the same daily authorization. |
| `audit_log` | `id`, `actor_user_id?` FK users.id, `session_id?` FK sessions.id, `action`, `occurred_at`, `request_id`, `payload jsonb`. Append-only protected events retain before/after snapshots and reasons. Payload object labels are historical descriptions, not polymorphic foreign keys used for authorization. No secrets in payloads; compensation events are admin-only. |

The runtime role has no UPDATE/DELETE/TRUNCATE permission on audit or auth events; defensive triggers reject changes. DBA/migration credentials are separate and are never used by request handlers. Disabling an account, resetting credentials, or revoking duty updates the authorization version and revokes affected sessions in the same transaction. Every request checks persisted session/account state.

### Projects, assignments, submissions, and protected files

| Table | Columns and relational constraints |
| --- | --- |
| `projects` | `id`, `code` UQ, `name`, `client_label?`, `website_url?`, `description`, `start_date?`, `deadline_at?`, `priority` LOW/NORMAL/HIGH/URGENT, `status` PLANNING/ACTIVE/ON_HOLD/COMPLETED/CANCELLED, `created_by` FK users.id, timestamps/version. No connection to a live client/invoicing database. |
| `tasks` | `id`, `task_number` UQ, `project_id` FK projects.id, `parent_task_id?` FK tasks.id, `title`, `instructions`, `references jsonb`, `due_at?`, `priority` LOW/NORMAL/HIGH/URGENT, `status` PENDING/IN_PROGRESS/SUBMITTED/REVISION_REQUIRED/APPROVED/CANCELLED, `assignment_mode` INDIVIDUAL/SELECTED/ALL_ACTIVE, `collaboration_mode` SHARED/COPIES, `created_by` FK users.id, timestamps/version. No self-parent; copies reference the original. Individual assignment cardinality and valid transitions enforced transactionally and by deferred constraint triggers. |
| `task_assignments` | `id`, `task_id` FK tasks.id, `employee_id` FK employee_profiles.user_id, `assigned_by` FK users.id, `assigned_at`, `status` PENDING/IN_PROGRESS/SUBMITTED/REVISION_REQUIRED/APPROVED/CANCELLED, `revoked_at?`, timestamps/version. UQ(task_id,employee_id), UQ(id,employee_id), UQ(id,task_id). ALL_ACTIVE is materialized as explicit eligible employee rows; broadcasts do not create payable time. Shared completion counts the task once. |
| `task_comments` | `id`, `task_id` FK tasks.id, `author_id` FK users.id, `body`, `created_at`. Append-only; author access to task checked on insertion. |
| `task_submissions` | `id`, `assignment_id` FK task_assignments.id, `revision_number` CHECK > 0, `notes`, `urls jsonb`, `submitted_at`. UQ(assignment_id,revision_number). Assignment identifies the submitting employee. Submission history is immutable. |
| `task_reviews` | `id`, `submission_id` FK task_submissions.id UQ, `reviewer_id` FK users.id, `decision` APPROVED/REVISION_REQUIRED, `reason`, `reviewed_at`. Nonblank reason required when returning revisions. Append-only. |
| `file_objects` | `id`, `storage_key` UQ, `original_name`, `media_type`, `size_bytes` CHECK > 0, `sha256`, `uploaded_by` FK users.id, `state` QUARANTINED/AVAILABLE/REJECTED, `created_at`. Private storage; random storage keys are not URLs. Upload limits, signature/type validation, sanitized names, and authorization are mandatory before availability. |
| `project_files` | PK(project_id,file_id); FKs projects.id and file_objects.id; file_id UQ. |
| `task_files` | PK(task_id,file_id); FKs tasks.id and file_objects.id; file_id UQ. |
| `submission_files` | PK(submission_id,file_id); FKs task_submissions.id and file_objects.id; file_id UQ. |

A deferred constraint trigger gives each available file exactly one owning project/task/submission/payslip. Access is derived through that typed owner, never a caller-supplied owner ID. Sensitive downloads return authorized file streams. No upload or file-serving feature is exposed in Phase 1.

### Time, attendance, corrections, and daily reports

| Table | Columns and relational constraints |
| --- | --- |
| `attendance_shifts` | `id`, `employee_id` FK employee_profiles.user_id, `duty_id`, `shift_number` positive, `clocked_in_at`, `clocked_out_at?`, `approval_status` PENDING/APPROVED/REJECTED, `approved_payable_seconds?`, `reviewed_by?` FK users.id, `reviewed_at?`, `policy_id` FK policy_versions.id, timestamps/version. Composite FK(duty_id,employee_id) to duty_authorizations(id,employee_id). UQ(duty_id,shift_number), UQ(id,employee_id), UQ(employee_id,clocked_in_at). Positive closed duration and nonnegative payable seconds. |
| `attendance_breaks` | `id`, `shift_id` FK attendance_shifts.id, `started_at`, `ended_at?`, `paid`, timestamps/version. Positive closed duration; exclusion constraint prevents overlapping breaks per shift. |
| `attendance_adjustments` | `id`, `shift_id` FK attendance_shifts.id, `requested_by` FK users.id, `reason`, `original_values jsonb`, `proposed_values jsonb`, `status` PENDING/APPROVED/REJECTED, `reviewed_by?` FK users.id, `review_reason?`, `created_at`, `reviewed_at?`. Original request is immutable; a single audited decision is allowed. Approved correction preserves original and new values. |
| `task_time_segments` | `id`, `employee_id` FK employee_profiles.user_id, `assignment_id`, `shift_id`, `started_at`, `ended_at?`, `kind` ORIGINAL/REVISION, `ended_reason?`, timestamps/version. Composite FK(assignment_id,employee_id) to task_assignments(id,employee_id); composite FK(shift_id,employee_id) to attendance_shifts(id,employee_id). Positive closed duration. |
| `task_segment_adjustments` | `id`, `segment_id` FK task_time_segments.id, `actor_id` FK users.id, `reason`, `original_start`, `original_end?`, `new_start`, `new_end?`, `created_at`. Append-only; applied atomically with the corrected segment and audit record. |
| `daily_reports` | `id`, `employee_id` FK employee_profiles.user_id, `report_date`, `work_in_progress`, `issues`, `notes`, `next_steps`, `submitted_at?`, timestamps/version. UQ(employee_id,report_date), UQ(id,employee_id). |
| `daily_report_entries` | `id`, `report_id`, `employee_id`, `project_id` FK projects.id, `assignment_id?`, `description`, `completed`. Composite FK(report_id,employee_id) to daily_reports(id,employee_id); composite FK(assignment_id,employee_id) to task_assignments(id,employee_id). Trigger verifies assignment belongs to project. |

Required SQL invariants:

- Partial UQ attendance_shifts(employee_id) WHERE clocked_out_at IS NULL: one open shift per employee.
- GiST exclusion on `(employee_id WITH =, tstzrange(clocked_in_at,clocked_out_at,'[)') WITH &&)`: no overlapping shifts, including open ones.
- Partial UQ task_time_segments(employee_id) WHERE ended_at IS NULL: one running task timer per employee.
- Equivalent GiST exclusion over segment timestamps: no overlapping task segments across any assignments/shifts.
- Database constraint triggers validate segments/breaks are contained in their owning shift; closing/correcting a shift cannot leave an open or out-of-bounds segment/break.
- Transactions lock the employee/duty/shift row, verify duty and server time, mutate time records, and append audit events together. Idempotency keys guard retryable clock/timer requests. No duration comes from a client counter.

### Weekly payroll, payslips, payments, and notifications

| Table | Columns and relational constraints |
| --- | --- |
| `payroll_periods` | `id`, `start_date`, `end_date_exclusive`, `pay_policy_id` FK policy_versions.id, `created_by` FK users.id, `created_at`. CHECK positive range; UQ(start_date,end_date_exclusive); GiST exclusion prevents overlapping canonical weekly periods for this standalone company. Corrective versions reuse the same canonical period. |
| `payroll_lines` | `id`, `period_id` FK payroll_periods.id, `employee_id` FK employee_profiles.user_id, `revision` positive, `supersedes_line_id?` FK payroll_lines.id, `status` DRAFT/APPROVED/PAID/VOIDED/ADJUSTED, `currency` CHECK PHP, `gross_amount`, `deduction_amount`, `net_amount`, `snapshot jsonb`, `prepared_by` FK users.id, `approved_by?` FK users.id, `approved_at?`, `correction_reason?`, timestamps/version. UQ(period_id,employee_id,revision), UQ(id,employee_id); partial UQ(period_id,employee_id) WHERE status IN (DRAFT,APPROVED,PAID). CHECK net = gross - deductions; gross/deductions nonnegative. Trigger requires superseded record to have the same period/employee. Negative net is a blocking review issue rather than a silent zero clamp. |
| `payroll_items` | `id`, `payroll_line_id` FK payroll_lines.id, `sequence`, `kind` EARNING/DEDUCTION, `earning_type_id?` FK earning_types.id, `deduction_type_id?` FK deduction_types.id, `rate_history_id?` FK employee_rate_history.id, `description`, `quantity numeric(18,8)`, `unit_rate numeric(18,4)`, `amount numeric(18,2)`, `rule_snapshot jsonb`. UQ(payroll_line_id,sequence); CHECK exactly the matching earning/deduction FK is present. Regular earnings require an applicable employee rate; item/line employee ownership is checked by trigger. |
| `payroll_item_attendance` | PK(payroll_item_id,shift_id); FKs payroll_items.id and attendance_shifts.id; `allocated_seconds` CHECK >= 0. Trigger requires same employee, approved attendance, and period-eligible allocation. |
| `payroll_adjustments` | `id`, `payroll_line_id` FK payroll_lines.id, `actor_id` FK users.id, `reason`, `original_values jsonb`, `new_values jsonb`, `created_at`. Append-only. Post-approval corrections create an explicit successor/adjustment record instead of editing frozen financial content. |
| `payslips` | `id`, `payroll_line_id` FK payroll_lines.id, `version` positive, `reference` UQ, `file_id` FK file_objects.id UQ, `generated_at`. UQ(payroll_line_id,version). Immutable versioned PDF content; owner comes only from payroll_line.employee_id. No public file path column. |
| `payroll_pdf_jobs` | `id`, `payroll_line_id` FK payroll_lines.id, `payslip_version` positive, `status` PENDING/RUNNING/SUCCEEDED/FAILED, `attempt_count` CHECK >= 0, `available_at`, `lease_expires_at?`, `last_error_code?`, `created_at`, `completed_at?`. UQ(payroll_line_id,payslip_version). Inserted with approval; bounded retries and leases make private PDF generation durable and idempotent without storing secrets in errors. |
| `payments` | `id`, `payroll_line_id` FK payroll_lines.id UQ, `paid_at`, `method`, `transaction_reference`, `amount`, `recorded_by` FK users.id, `recorded_at`. UQ(method,transaction_reference); nonblank reference; positive amount exactly matches the approved line net under the initial single-payment workflow. Zero/negative net requires explicit settlement policy, not a fabricated payment. Append-only; approval never inserts a payment. |
| `notifications` | `id`, `recipient_id` FK users.id, `event_type`, `safe_payload jsonb`, `created_at`, `read_at?`. Recipient-only reads; payload carries no other employee's rates or private records. |
| `operation_idempotency` | `id`, `actor_id` FK users.id, `operation`, `key`, `request_digest`, `result_reference?`, `created_at`, `expires_at`. UQ(actor_id,operation,key). Result reference is a non-authoritative retry receipt; service resolves the typed record and repeats authorization. Conflicting payload reuse is rejected. |

Approval locks the payroll period and employee line, validates item sums and source attendance/rates/policies, freezes a complete rules/rates/name snapshot, and records approval, PDF job, and audit atomically. Later edits to rate/policy records cannot affect the snapshot. PDF generation uses the durable job and an idempotent unique version; an external file write is not falsely treated as part of a database transaction. A finalized payslip becomes visible only after the private PDF is ready. Marking Paid inserts exactly one payment and performs the permitted state transition in one transaction. Financial columns/items of approved or paid lines cannot be updated/deleted by the runtime role; only controlled, audited status/correction transitions are allowed.

## Authorization and database isolation

- Administrator-only services manage employees, schedules, rates, and settings. Employee services derive ownership from the verified session, never a submitted employee ID. Employee self-service editing is deferred until a verified workflow exists.
- Every API route, Server Action, and service checks authorization; protected DAL methods require a validated request context. DTOs select explicit permitted columns. Rate/audit/security data is never embedded in another employee's page or client payload.
- Employee-owned tables use PostgreSQL row-level security with default deny. Policies validate the active database-backed session and allow the owner or an enabled administrator. Shared-task data uses assignment eligibility, with each contribution restricted to its owner where appropriate.
- Prisma operations run in bounded transactions with transaction-local identity context; nothing sets identity globally on a pooled connection. Raw migration/admin clients cannot be imported by request code.
- Runtime credentials are non-owner, non-superuser, and NOBYPASSRLS. Apply FORCE ROW LEVEL SECURITY where appropriate. Narrow, fixed-search-path authentication functions provide only the unauthenticated credential/session operations needed for login; PUBLIC execution is revoked. The app never gets arbitrary credential-table SELECT access.
- Audit/security logs and compensation configuration are admin-only. Employees may view their own rate history; never another employee's profile, contact, schedule, rate, time, or payslip. Missing and unauthorized target IDs use indistinguishable responses.

The server/DAL boundary follows the [Next.js authentication guidance](https://nextjs.org/docs/app/guides/authentication). Database isolation and interval constraints follow [PostgreSQL row security](https://www.postgresql.org/docs/17/ddl-rowsecurity.html) and [range exclusion constraints](https://www.postgresql.org/docs/17/rangetypes.html).

## Phase 1 test and delivery gate

Run integration tests against a dedicated disposable PostgreSQL database using the actual restricted runtime role and real migrations, not a SQLite replacement or mocked Prisma authorization layer.

- Employee A cannot read/update B through pages, direct API requests, Server Actions, forged body/query IDs, DAL calls, or direct runtime-role queries with A's session context. Cover profile, rates, schedules, user details, and enumeration attempts. Reverse A/B as well; administrator access succeeds.
- Correct email/username/password login works. Wrong passwords and disabled accounts fail with generic responses. Persistent account/network throttling and timed lockout work under concurrent attempts. Logout, password reset/change, account disabling, idle expiry, absolute expiry, and replay of revoked session cookies deny subsequent access.
- CSRF missing/invalid token and hostile-origin mutations fail. Employee attempts to promote roles, set rates, create staff, or call admin actions fail. Dashboard responses do not leak another employee's data through caching.
- Employee creation/profile/rate/schedule updates enforce unique identifiers, valid intervals, no overlapping rates/schedules, transactional audit records, and history retention. Runtime audit UPDATE/DELETE/TRUNCATE fail.
- Money unit tests cover exact decimal parsing, addition, fractional-rate multiplication, configured rounding/ties, rejected float inputs, and serialization. Time tests cover Manila midnight versus UTC, week start/end boundaries, inclusive/exclusive cutoffs, and date-only handling. These are utilities, not a completed payroll calculator.
- Responsive browser checks cover both dashboard shells and mobile login/navigation. Run type checks, automated tests, clean database migration replay, and production build.
- Map blueprint Section 15 scenario 2 to the password/lockout portion and scenario 12 to Phase 1 mobile sessions/date utilities. Mark PIN/TOTP/recovery, actual duty revocation, task/time, payroll, and PDF cases as later-phase gates rather than claiming them passed. Profile/rate isolation is the explicit Section 14 Phase 1 exit test; payslip isolation is tested with real payslips in Phase 5.

Deliver source, migration files, lockfile, `.env.example`, a development-only seed (one admin and at least two employees), local setup/backup notes, and the test report. Fake temporary seed passwords appear only in the seed script and README; never in this plan, logs, or a production environment. Seed users must change their passwords. Seeding is blocked against production.

Use small commits for setup/documentation, schema/security constraints, authentication, employee management/UI, and tests/docs. Do not access an existing Libetario database. There will be no production deployment or Phase 2 work at this gate.
