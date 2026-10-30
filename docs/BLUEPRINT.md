# LIBETARIO | INTERNAL DEVELOPMENT BLUEPRINT

**Employee Management, Duty Access, Task Tracking & Weekly Payroll**

MASTER DEVELOPMENT BLUEPRINT | Version 1.0 | 30 October 2026

Prepared for: Assigned system developer • Business owner: Libetario Digital Marketing Services

---

## 1. Purpose and non-negotiable scope

Build one production-ready, mobile-responsive web application that lets an administrator authorize daily employee duty, assign website/design/development/editing tasks, audit individual task durations, review attendance, configure different employee pay rates, approve weekly payroll and issue secure PDF payslips. Deliver working backend/database logic, not static screens.

Roles: Administrator and Employee. Employee designations (Designer, Developer, Editor) are profile categories, not automatic administrator privileges.

Initial deployment is a standalone web application unless the owner explicitly authorizes integration with an existing system. Provide a documented integration path, without touching a live client or invoicing database by default.

Philippine local time: Asia/Manila for display, daily duty, schedules and pay periods; persist timezone-aware timestamps (prefer UTC internally).

All monetary data is in PHP with fixed decimal handling; never use floating-point arithmetic for payroll.

## 2. Roles and permissions

| Area | Administrator | Employee |
| --- | --- | --- |
| Accounts / rates | Create, update, disable; set salary and schedules | View own profile, not others' rates |
| Daily duty | Authorize, revoke, bulk activate; view log | See own status; cannot self-authorize |
| Tasks | Create, allocate, edit, review, approve | See authorized assignments; log time; submit |
| Attendance | Review, correct with audit trail | Clock in/out; request correction |
| Payroll / payslips | Prepare, adjust, approve, mark paid, export | View/download only own finalized payslips |
| Reports | All authorized workforce reports | Own work and attendance history |

Enforce authorization at API/server and database-access layers; hiding menus is not sufficient. Administrators cannot silently impersonate an employee or change existing pay periods without a recorded corrective action.

## 3. Administrator dashboard and employee dashboard

### Administrator landing page

- Employees activated today / currently clocked in / currently on a task; missing clock-outs and security alerts.
- Projects active, tasks pending, underway, for review, revisions and approved; overdue tasks.
- Today's and this week's total recorded task time, attendance time, pending payroll and amounts paid.
- Quick actions: Activate Duty, New Project, Assign Task, Review Submission, Payroll Review, Export.

### Employee landing page

- Daily duty status, Clock In/Clock Out, current task timer and daily attendance.
- My assigned tasks, tasks shared with selected employees or all employees, due dates, revisions and submissions.
- My task durations, attendance records, daily work report, weekly payroll status and my issued payslips.

When no duty is activated, restrict working access and explain status. Allow access to necessary non-working functions (such as requesting duty access or viewing old payslips) only if separately permitted by policy.

## 4. Employee account management

- Employee ID, legal/display name, email, contact, designation, start date, status, schedule, salary basis and effective-dated rate.
- Daily or hourly salary basis; configurable expected hours, paid/unpaid breaks, wage rounding and payroll cutoff.
- Administrator manages activations, credentials reset and secure authenticator recovery. Employee self-service changes must be appropriately verified.
- Retain history when account is deactivated; do not delete paid payroll or approved time records.

## 5. Admin-controlled daily duty and secure sign-in

### Approved login policy

1. Administrator grants a duty authorization for an employee on a particular duty date (optionally bulk activate scheduled staff).
2. Employee enters their own username/email and password; system verifies the account.
3. Employee enters their own separate secret PIN/code, if enabled by the owner (store hashed, rate-limit attempts).
4. Employee submits a current 6-digit code from a previously enrolled Google Authenticator or Microsoft Authenticator app (standards-based TOTP).
5. Server validates duty authorization, credentials, PIN and TOTP before issuing a short-lived duty-capable session.
6. Employee selects Clock In separately. Authentication alone must not count as paid time.
7. Employee Clocks Out; the session/duty state is finalized according to policy. Fresh admin authorization is needed for the next duty date.

### TOTP onboarding and recovery

- Provide one-time QR enrollment, confirm first valid TOTP, then store each employee's TOTP secret encrypted and protected. Never log the enrollment QR or secret.
- Code typically changes every 30 seconds; allow only small clock drift, rate-limit failures and prevent reuse within accepted time steps.
- Generate single-use recovery codes with hashed storage, and implement admin-assisted, identity-verified authenticator reset with audit logs.
- Do NOT display the OTP on the same login screen. Account password and TOTP are distinct factors; personal PIN is an additional secret, not an independent device factor.
- Admin revocation must invalidate currently active duty permissions/sessions, not just hide the UI.
- Handle date rollover and overnight shifts explicitly: link the shift to its authorized duty date instead of abruptly losing valid time entries at midnight.

### Duty statuses and logs

Not Scheduled → Activated → Clocked In / On Duty → Clocked Out / Duty Completed; Disabled/Revoked as alternate states. Record grant/revoke time, authorizing administrator, login attempts, MFA success, Clock In, Clock Out, session expiry, and any exception with timestamps.

## 6. Projects, assignments and shared tasks

- Project record: project/client, website URL, description, start date, deadline, priority, status, references and attachments.
- Task record: task ID, title, project, instructions, references, due date, priority, creator, creation time and assignment mode.
- Assignment modes: (A) Individual, (B) selected employees, (C) All Active Employees. Explicitly show all-employee tasks in each eligible employee dashboard.
- Support two distinct collaboration models: one shared task with contribution records per employee, OR separate per-employee copies. Default shared task with unique assignment/contribution entries; do not accidentally count one task multiple times as overall completed.
- Keep separate employee status and time contribution for a shared task. An all-employee broadcast is not automatically a paid task.
- Statuses: Pending, In Progress, Submitted for Review, Revision Required, Approved/Completed, Cancelled. Each change and comment is timestamped.
- Employee submits URLs/files/screenshots and notes; admin approves or returns revisions with a reason; log rework sessions separately.

## 7. Task timers and work accounting

- Employee must be authorized for duty and Clocked In to start a task timer.
- Start Task stores a server timestamp. Pause closes that segment; Resume opens a new segment. Stop or Submit closes the running segment.
- Only one active task timer per employee at once. Do not permit overlapping task segments; switching tasks requires closing previous segment.
- Clock Out closes or pauses active timer according to explicit policy and leaves a complete audit trail.
- Sum active segments for each employee-task pair, each project, day and week. Preserve original and revision time.
- Admin can review and correct disputed entries with a mandatory reason; keep original value, new value, actor and timestamp.
- Support multiple shifts and task sessions across different dates; calculate duration from timestamps, not from a client-side counter alone.

**Clarification:** a timer shows declared/recorded task time, not independent proof that the employee was actively productive. Attendance hours and task hours must remain distinct. A gap between them is a review signal, not an automatic pay deduction.

## 8. Attendance, scheduling and daily reports

- Capture actual Clock In, Clock Out, breaks where applicable, shift reference, daily duration, approved payable hours/days, and any lateness or missing punches.
- Employee may request attendance corrections; admin accepts/rejects with reason and immutable audit trail.
- Use approved attendance for draft payroll subject to configured pay policies; no automatic full-day payment merely from an app login.
- Daily report fields: date, projects handled, tasks completed, work in progress, issues, notes/next steps; admin can filter and export.
- Support configurable schedules, non-working days, holidays, authorized overtime and overnight shifts.

## 9. Individual salary rates and weekly payroll

### Administrator salary settings

- Each employee has their own daily or hourly rate, effective dates, expected hours and payroll configuration.
- Administrative controls for approved overtime, bonuses, allowances, deductions, holiday/rest-day premiums, statutory contributions and other legally applicable wage items.
- Do not hard-code one formula for all employment arrangements. Confirm classification and Philippine payroll compliance with the business owner/accountant before deployment.
- Keep rate history and snapshot applied rules/rates in every approved pay period.

### Calculation and review

For an eligible daily-rate arrangement, a simplified basic-pay example is approved paid days × applicable daily rate. For an eligible hourly-rate arrangement, basic pay is approved payable hours × hourly rate. Real computation must apply the configured treatment of partial days, holidays, breaks, overtime and legally required items. Net pay = gross earnings − allowable deductions.

- Admin selects a weekly cutoff and system calculates DRAFT per employee from approved attendance and applicable rate history.
- Show itemized days/hours, regular pay, premiums, allowances/bonuses, deductions, gross and net. Flag unresolved punches.
- Admin can approve justified adjustments; save reviewer, reason and before/after amounts.
- Approval freezes the payroll snapshot and generates a PDF payslip; only authorized correction/adjustment workflow changes prior approved records.
- Only mark PAID after actual payment, recording payment date, method and transaction reference. Prevent accidental duplicate payment marking or duplicate finalized periods.
- Statuses: Draft → Approved → Paid. Support separate Voided/Adjusted states if corrections are authorized; never silently overwrite approved paid records.

## 10. Weekly PDF payslip specifications

- Show company logo/name (Libetario Digital Marketing Services), employee name/ID/position, unique payslip reference, pay period and applicable rate basis.
- Include regular payable days/hours, basic pay, premiums/overtime, bonuses/allowances, itemized deductions, gross and net pay, approval/date and payment status/date if paid.
- Keep immutable versioned PDF tied to the finalized payroll record; secure access; employees can download only their own files.
- Provide admin batch export and individual download, with readable A4 layout and numeric formatting in PHP.
- Do not expose employees' payslips through public file URLs or predictable unauthenticated links.

## 11. Admin monitoring, reports and notifications

- Live work table: Employee | Duty Status | Current Task | Current Session | Total Task Time Today | Total Attendance Today | Deadline / Alerts.
- Filters by date, person, project, status and assignee. Task history: assigned at, started at, submitted at, approved at, hours by contributor, revision count and attachments.
- Daily/weekly/monthly task and attendance reports; payroll by employee and period; CSV and PDF exports with access controls.
- Notify for new assignment, deadline, revision, submitted work, approval, duty activation/revocation, missing punches and payslip available.
- Ensure live values are backed by server data; use polling or websockets if suitable, but avoid misleading fake "Live" figures.

## 12. Suggested database entities

| Entity | Main responsibility |
| --- | --- |
| users / employee_profiles | Credentials, role, designation, status, profile |
| employee_rate_history | Basis, amount, effective date, pay-policy settings |
| duty_authorizations | Employee, duty date, grant/revoke state, admin |
| mfa_enrollments / recovery_codes | Protected encrypted TOTP and hashed recovery data |
| auth_events / sessions | Authentication, security logs, expiry, revocation |
| projects / tasks | Project and task details |
| task_assignments | Who sees/owns each task; individual progress |
| task_time_segments | Server timestamps, pause/resume, corrected segment history |
| task_submissions / reviews | Links, attachments, revision decisions |
| attendance_shifts / adjustments | Clock events, payable time, corrections |
| daily_reports | Employee daily updates |
| payroll_periods / payroll_lines | Draft/approved pay data and all itemized components |
| payslips / payments | Immutable PDFs, disbursement status/reference |
| notifications / audit_log | Events, actor, details and actions |

Use real foreign keys, integrity constraints, unique indexes for duty and payroll cutoffs where appropriate, and transactional updates for clock-in/out, payroll approval and payment-state transitions. Audit logs should be append-only to ordinary app users.

## 13. Technical, security and UI delivery rules

- Responsive, accessible, clean admin and employee dashboards; straightforward sidebar and readable status indicators.
- Secure password hashing, encrypted TOTP secrets, protected file uploads, HTTPS, CSRF protection where applicable, robust API authorization, login throttling and session expiry.
- Validation against clock tampering, simultaneous active timers, duplicate shifts and double-generated payroll.
- Store time in a consistent timezone-aware format; PH presentation and correct cutoff handling; use decimal/cents for pay.
- Backups and restore instructions, environment-based secret storage, minimal employee-data exposure, least-privilege database credentials.
- Record retention, access restrictions and personal-data handling appropriate to Philippine data privacy obligations.
- Deliver actual source code, database migrations, setup/deployment steps, backup plan and concise admin/employee user guides.

## 14. One-developer build sequence and gates

| Phase | Required working deliverables | Exit test |
| --- | --- | --- |
| 1. Foundation | DB, roles, auth, employee profiles, clean dashboards | Different staff cannot view one another's records |
| 2. Duty security | Admin activation, secret code, TOTP enrollment, revocation | Unauthorized duty blocked, valid MFA works |
| 3. Projects/tasks | Create/assign all modes; task revisions/files | Each eligible employee sees correct tasks |
| 4. Time/attendance | Task timers, clock in/out, reports, corrections | Correct totals across pauses, rollover, multiple days |
| 5. Payroll/PDF | Rates, weekly calculations, review, PDF and pay history | Multiple rates and cutoff cases reconcile accurately |
| 6. QA/release | Regression/security/mobile testing, documentation | Owner-approved acceptance tests all pass |

## 15. Mandatory acceptance-test scenarios

1. Admin activates Employee A but not Employee B: A can perform secure duty login; B cannot clock in or access duty tools.
2. A wrong password, PIN or authenticator code fails; lockout, recovery and secret reset behave safely.
3. Previously approved employee gets revoked during an active session; authorization is promptly removed without erasing legitimate recorded time.
4. One shared task assigned to three employees: all can see it; each has distinct timer and contribution history; no double-counting.
5. Employee works on Task X, pauses, moves to Task Y, returns to X another day; segment sums are correct and never overlap.
6. Employee clocks out with running task; the segment is closed or paused and audit event captured.
7. Attendance 8 hours and task entries 6 hours are displayed separately; no unsupported pay deduction.
8. Different employees with distinct daily/hourly rates generate different, correct pay; changing a rate later does not change finalized history.
9. Admin corrects missed punch with reason and recalculates draft; approved payroll can only be corrected with controlled adjustment.
10. Approved payslip is downloadable by that employee only; a different employee is denied access, including guessed PDF URLs.
11. Marking payroll Approved does not mark it Paid; actual payment details are recorded once and historical snapshot remains correct.
12. Overnight shifts, weekend cutoffs, date rollover, missing punches, failed MFA, malformed file uploads and mobile browser sessions are tested.

## 16. Delivery and approval

Provide an implementable system, source code, schema/migrations, configuration notes, staging URL, sample test users (with temporary credentials delivered privately), security checklist, automated/manual test evidence, deployment instructions and post-launch bug-fix list. Demonstrate every core workflow to the administrator before production release.

Scope boundary: Leave integration with the existing Libetario Business System optional until the owner explicitly authorizes it. Payroll formula, worker classification, statutory obligations and employment policies require owner/accountant validation before any live employee payments.

---

Libetario Digital Marketing Services • Confidential internal specification
