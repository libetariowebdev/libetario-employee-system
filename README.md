# Libetario team workspace — Checkpoint 4b

Standalone employee-management foundation for Libetario Digital Marketing Services. Next.js App Router + TypeScript + Tailwind, PostgreSQL 18, Prisma 7 migrations, Argon2id passwords, persisted account sessions, server authorization and PostgreSQL row-level security.

Real account/profile/rate/schedule management includes encrypted authenticator enrollment, mandatory administrator TOTP, hashed employee PINs, recovery/reset and secure duty authorization/login. The workspace includes projects, shared tasks, immutable submissions/reviews, private files, attendance, task timers, and daily and weekly reports. The database has 34 application tables. Employees need active DUTY for work and attendance; MFA administrators use ACCOUNT without duty. Attendance begins with Clock In. Recording a task timer requires an explicit Start.

## Start locally

Requirements: Node.js 24 LTS, pnpm 11, Windows x64 (tested). Embedded PostgreSQL installs only into this checkout's dependencies and stores its isolated cluster in `.local/postgres`; it does not use an existing PostgreSQL service or Libetario database. PostgreSQL must be able to listen on loopback port 55432.

In this Codex workspace pnpm is bundled at the following path. If `pnpm` is already on your PATH, omit this session-local alias:

```powershell
Set-Alias pnpm 'C:\Users\Dell\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd'
```

On a fresh checkout, run:

```powershell
pnpm install
pnpm db:local
```

Keep that terminal running. In a second terminal in this directory:

```powershell
pnpm db:bootstrap
pnpm mfa:init-keys
pnpm db:migrate
pnpm db:generate
pnpm db:seed
$env:DOTENV_CONFIG_PATH = '.env.test.local'
node --import dotenv/config node_modules/prisma/build/index.js migrate deploy
node --import dotenv/config --import tsx prisma/seed.ts
Remove-Item Env:DOTENV_CONFIG_PATH
pnpm uploads:init-keys
pnpm dev
```

Open [the local workspace](http://127.0.0.1:3000). Use exactly this origin rather than `localhost` unless you also update `APP_ORIGIN`.

**For this already-prepared workspace:** bootstrap, migrations and seed have been completed. Preserve the ignored `.env` and `.local/` files. Start `pnpm db:local` if the database is stopped, then `pnpm dev`. Do not rerun bootstrap or seed over existing data: both refuse rather than replacing credentials/data. Stop each server with Ctrl+C in its owning terminal.

`db:bootstrap` creates only `libetario` and `libetario_test` in this dedicated cluster, generates random database passwords and a session secret, and writes ignored `.env` / `.env.test.local` files. `mfa:init-keys` adds separate random MFA keyrings to those files; it validates/preserves existing keys, refuses partial/invalid configuration and never prints keys. Never commit or share these files. `.env.example` contains configuration names only. The two app roles are non-owner, non-superuser, NOBYPASSRLS and have no membership in one another.

The fresh-checkout block migrates and seeds both empty databases before uploads:init-keys, because the upload verifier is bound to each database's company_settings row. Do not repeat either seed on existing data; tests use their own random fixtures after initial setup. The test database is isolated from development and uses its own private root and upload key.

For an existing Phase 1 checkout, preserve environment/data files, run `pnpm mfa:init-keys`, `pnpm db:migrate`, and `pnpm db:generate`. Apply migrations to the separate test database as shown below. The Phase 2a migration revokes pre-MFA sessions; administrators must sign in and enroll. Do not rerun bootstrap or the default seed.

Docker is an alternative to embedded PostgreSQL: use `compose.yaml` with a private `LOCAL_DB_PASSWORD`, then have the DBA provision the two app roles as described in [security/deployment notes](docs/SECURITY.md). The embedded bootstrap script is specifically for the embedded cluster; do not run it against a provider or existing database.

## Fake, temporary sample credentials

Development only; no real people or real payroll data. These credentials are defined only here and in `prisma/seed.ts`. Every seeded account must change its password before seeing protected records.

| Role          | Username          | Email                        | Temporary password             |
| ------------- | ----------------- | ---------------------------- | ------------------------------ |
| Administrator | `demo.admin`      | `admin@example.invalid`      | `FakeAdmin-ChangeMe-2026!`     |
| Employee A    | `demo.employee.a` | `employee.a@example.invalid` | `FakeEmployeeA-ChangeMe-2026!` |
| Employee B    | `demo.employee.b` | `employee.b@example.invalid` | `FakeEmployeeB-ChangeMe-2026!` |

Seed refuses production, remote hosts, unexpected database names, and databases containing accounts. It does not reset users on rerun. Initial passwords are never logged by the app. New employees created by an administrator receive a random temporary password in a one-time response and must change it. Deliver it privately; use the reset workflow if it is lost.

## Use the app

**Administrator:** sign in, change the temporary password, then sign in again. Before administrator access, enroll an authenticator with the one-time local QR and confirm its first code; save the ten recovery codes privately. Later sign-ins require password followed by current TOTP. The intermediate five-minute SETUP session cannot read employee records or use administrator tools, including through direct runtime-role queries. Use Employees to create staff or open a profile. Edit personal details and status with a reason. Add rates and schedules using effective dates later than the newest existing entry. Disable an account to revoke all sessions without deleting history. Account security shows real enrollment metadata and the latest security events and offers assisted reset. Audit trail shows the latest 50 changes. Settings appends immutable security-policy versions, requires recent MFA and rejects stale edits.

**Employee:** sign in and replace the temporary password. View your own profile, individual rate history and schedule. There is no employee directory or profile-edit endpoint. Change your password from My profile, or ask the administrator to verify your identity and issue a reset token.

Employees use Account security to enroll TOTP and save recovery codes. Setting/changing/replacing a forgotten six-digit PIN requires current password plus a fresh TOTP. PINs are Argon2id-hashed. SECURITY.pinEnabled ships **false**; duty sign-in enforces it when enabled. ACCOUNT sessions retain 15-minute idle/60-minute absolute defaults. SETUP is five minutes absolutely, with no sliding extension. Separate SECURITY defaults are dutyIdleMinutes=30 and dutyMaxHours=12, capped by the authorized duty window end; same-grant reauthentication requires current TOTP plus PIN when enabled, without repeating password login.

TOTP uses SHA1, six digits, 30-second periods and ±1-step drift. A consumed counter cannot be reused, including the enrollment-confirmation code. Wait for a fresh code before a second action. PIN/TOTP/recovery default to five failed attempts per account/factor in 15 minutes and a 15-minute lockout. SETUP is revoked on its fifth failure; reissuing it does not clear account/network counters. Network factor limit is 30 and recovery network limit is five. Security settings are versioned; unfinished SETUP capabilities are invalidated on a security-policy change.

**Reset:** administrator opens the employee profile, records how identity was verified, and issues a token. Every existing session and older reset token is invalidated immediately. The token is shown once for private delivery. Employee enters it at `/reset-password` with a new password, then signs in afresh. Default validity is 15 minutes. No email transport is claimed or configured.

An account with an unconfigured rate or schedule displays an explicit empty state. New profiles do not inherit a fictional wage or workweek. Money inputs are decimal strings; the exact four-decimal rate remains visible alongside the two-decimal PHP display. History end dates are exclusive.

## Projects and shared tasks

To upgrade a checkout that predates private uploads, preserve keys/data, run `pnpm install`, `pnpm db:migrate` and `pnpm db:generate`, migrate the dedicated test database as below, then run `pnpm uploads:init-keys`. That initializer adds a distinct random UPLOAD_VALIDATION_KEY and absolute PRIVATE_UPLOAD_ROOT to each ignored environment file and binds only a SHA-256 verifier in its database. It preserves existing configuration, prints no secret and requires migration-owner/local access. To upgrade an accepted 4a checkout, apply the new migrations and regenerate Prisma, then restart Next. Keep the existing keys and storage. The current schema has 49 migrations and 34 application tables.

**Administrator:** open Projects, create a project (ACTIVE by default; PLANNING selectable), then open it to create a shared task. Choose INDIVIDUAL, SELECTED or ALL_ACTIVE. ALL_ACTIVE captures enabled ACTIVE employees whose start date has arrived in Manila at creation; later hires/reactivations are never added automatically. Invalid recipients/capacity reject the whole operation. The default 500-recipient cap is editable through the versioned WORK task-capacity form with recent administrator MFA, expected policy ID and a reason. The recipient picker does not silently truncate the eligible directory.

Edit project/task briefs with reasons, manage explicit membership, or cancel/restore unfinished work. Withdrawal removes next-request access and retains the contribution identity/history. Reassign an INDIVIDUAL task by selecting the old withdrawal and new recipient together. If every assignment is withdrawn, the task becomes CANCELLED; on an ACTIVE project, select recipients and use Restore access & reopen task with a reason. A normally cancelled task with current members uses Restore to pending. No DELETE action erases history.

**Employee:** complete duty sign-in, then open My tasks at `/work/tasks` (also linked from the duty context). Only assigned tasks, minimal project data, own contribution/history and shared task comments are readable. This work layout uses DUTY independently of ACCOUNT expiry; profile/rates/security keep their existing account requirements. New/Updated indicators compare actual task/project/contribution versions with that employee's last list visit; the rendered list acknowledges only observed versions, so concurrent changes remain marked. This is a list indicator, not a notification service. List filters, pagination and explicit refresh use actual data.

Mark your own Pending contribution In progress and add plain-text comments. Projects outside ACTIVE show an explicit read-only explanation and reject progress, comments and submission/review writes on the server/database. Each task counts once toward a project's work denominator regardless of assignees; cancelled tasks are separate and empty projects show no countable work. Real reviews determine Approved / Completed, and project COMPLETED requires non-empty countable work with every task approved. COPIES and notifications are deferred by owner decision. Task time and attendance are independent records.

API surface: `/api/work/context`, `projects`, `projects/:id`, `tasks`, `tasks/:id`, `tasks/:id/progress`, `tasks/:id/members`, `tasks/:id/comments`, `seen` and administrator-only `admin-options` / `task-policy`, all under `/api/work/`. Mutations require the selected work session's CSRF and origin; JSON bodies max 128 KiB. Foreign and missing UUIDs return the same 404 for an otherwise valid work actor. RLS also applies to direct restricted-role SQL.

## Attendance clocks, breaks and review (checkpoint 4a)

Employees with current DUTY access open **Attendance** at /work/attendance, explicitly Clock In, choose a configured break code, End break and Clock Out. Sign-in never clocks in. Clock Out ends an open break at the same trusted instant. Multiple adjacent shifts are supported; overlapping shifts/breaks are forbidden in PostgreSQL. Times/durations come from the server, with exact fractional seconds and Manila presentation. Use **Refresh & check due records** for a fresh snapshot; the UI does not claim a live client counter. ACCOUNT alone cannot read attendance history or request corrections.

MEAL defaults to unpaid and SHORT to paid. Effective schedule allowances or explicit code allowances are snapshotted. Overages are flagged and never clipped or penalized further. The owner/accountant must confirm treatment and allowances before Phase 5. Missing schedules, zero-duration evidence, lateness, long shifts (>16h), missing Clock Out and system closures need individual review. Task time and attendance stay distinct; there is no gap-based deduction, payroll calculation or rounding in this checkpoint.

MFA administrators use /admin/attendance, select a duty-date range/employee and open a shift. **SUGGESTED** is effective elapsed minus actual unpaid breaks; it is a review aid. Explicitly accept it or override within zero through gross attendance seconds. An override/rejection needs a 10–2,000 character reason; flagged approval also needs acknowledgement and a reason. Review requires MFA verified within five minutes (Account security → Verify recent MFA). Approved seconds remain NULL until approval. Correcting attendance clears the approval while preserving previous review/audit evidence. Bulk preview/approval applies only to clean closed Pending shifts with no flags or pending correction; the displayed exact set/versions must still match at commit. Nothing is approved by previewing.

For an existing shift, **Request / propose an attendance correction** keeps actual punches and proposes effective endpoints and every break. Void an erroneous break explicitly. **Request a missing Clock In** first finds a real duty authorization, then files ADD_MISSING_SHIFT; absent actual punches remain NULL after approval. Administrators approve/reject with recent MFA and a mandatory reason. Claims outside the verified window remain recorded but cannot be applied to extend authorization; reject and resolve the historical grant before replacing the claim. Stale corrections cannot overwrite later punches. Correction approval does not approve payable seconds.

Duty revocation, disabling an account or making employment inactive closes its open shift/break atomically at the trusted event instant, retains evidence and flags review. Session expiry, logout and MFA/security invalidation remove tool access but do not invent Clock Out while the grant is valid. Same-grant reauthentication resumes access. Clock Out under the old valid grant is required before switching to a different grant. Overnight is off by default; an explicitly enabled, bounded carry retains the original duty/date, at most eight hours beyond midnight. The 16-hour flag does not truncate time.

Grant expiry closes at the exact saved valid_until, including after downtime. The server startup performs a bounded due check; authorized Refresh and employee mutations also reconcile. There is no background scheduler. An operator with migration credentials can explicitly run, in PowerShell:

~~~powershell
pnpm attendance:reconcile
pnpm attendance:reconcile --test
~~~

Each run processes at most the configured batch (default 100); repeat while due records remain. The command has no target/time arguments, refuses non-local/production targets without --allow-production and does not delete data. Read-only views cap open elapsed at the grant boundary even before materialized reconciliation. Back up all attendance/adjustment/audit rows together with the existing database and private-upload bytes; preserve environment/keyring backups separately as documented. Do not run trusted-clock tests while browser QA uses the test database.

## Task timers and reports (checkpoint 4b)

- **Employee timer:** Clock In, open an eligible assigned task in an ACTIVE project, and choose **Start timer**. Pause, Resume and Stop are available from the task and **Task time**. Use **Stop current timer and switch to this task** to make an atomic switch. The timer snapshot shows elapsed recorded intervals, including exact fractional seconds. Start break pauses a running timer. End break leaves it paused. Clock Out stops both running and paused timers.
- **Timer lifecycle:** Submit freezes the deliverable and stops its timer together. Work after a revision request is linked to the specific review. Withdrawal, cancellation, project hold and duty or account invalidation close the relevant timers with reasons. Restoration requires a fresh Start. Expired duty accrual is bounded by the saved grant even before the due check persists closure.
- **Corrections:** Administrators open a segment from **Time reports → Task segment sources** and review its recorded and effective endpoints. Correct only a closed segment in a stopped timer and closed shift. Recent MFA, expected versions and a reason are required. A shift correction that would leave a segment outside the shift or inside a break conflicts. Open the shift's pending correction and include explicitly reviewed segment edits to save both together.
- **Daily reports:** Open **Daily report**, choose the actual Manila date, save a draft and add entries from your own assignments. A meaningful non-work note or issue allows a report without a task entry. Submit freezes the report. A reported completion is employee narrative and does not change task approval or create time.
- **Live work and time reports:** Administrators can open **Live work** for the seven-column team snapshot. It refreshes every 15 seconds by default, shows when the data was fetched and displays errors or expired access. Polling never extends session life. Both roles have **Time reports**, with Day or Week groups and source detail. Weekly boundaries default to Monday in Manila. Report filters select matching rows, and the comparison keeps each employee's gross attendance, break totals and task totals separate. An 8-hour shift with 6 hours of recorded task time shows a 2-hour review signal. Stored shift approvals have a separate report by authorized duty date.
- **CSV:** Use **Download CSV** in Time reports. Filters are shared with the table. Date ranges are inclusive and capped at 31 days. Exports above 50,000 rows fail before streaming. Quoted text is escaped for spreadsheet formulas. Current access is checked between chunks. A revoked stream stops, though the application cannot recall bytes already delivered.

Timer and reporting policy is available under administrator **Time reports**. Recent MFA and a reason are required. It controls Switch behavior, week start, poll rate, report limits and daily entry limits. Attendance policy still supplies paid/unpaid break classifications. Payroll, payslips, monthly reports, PDF reports and notifications remain later work.

## Private submissions, reviews and files

Employees open their task, start their contribution, create a draft, edit notes/HTTP(S) URLs and upload private attachments. **Submit for review** saves and freezes notes, URLs and included AVAILABLE files in one transaction. Save draft is optional before submitting; uploading does not implicitly save unsent text. Exclude a failed/unwanted attachment while the draft is open; its permanent owner/history remains. A revision request has a 10–2,000 character reason. Start revision, then create a new draft; prior submitted content and decisions cannot change. Employees see only their own contribution's submissions, reviews and files. Shared comments remain visible to assigned peers.

Administrators use **Review queue** or task detail to review only the latest submitted revision. Choose APPROVED or REVISION_REQUIRED. Competing/stale decisions conflict. A shared task is APPROVED only when at least one required contribution exists and every required contribution is approved. APPROVED is terminal; follow-up work needs a new task. Withdrawing approved access preserves its required approved contribution; restoring access never changes the decision. Removing unfinished work excludes it from completion with an audit record.

Uploads accept PDF, PNG, JPEG and WebP, positive size up to 10 MiB/file. Allowed types and supported limits are validated versioned WORK.uploads settings on Projects, requiring recent administrator MFA and a reason. Images are fully decoded (8,192 pixels/axis, 20 MP); PDFs are structurally parsed (500 pages, bounded objects/streams). Encrypted, active/action/embedded-file PDFs, unsupported codecs, animated images, malformed/truncated content and appended polyglots are rejected. Ordinary text and JPEG-image PDFs are supported. Validation is not a malware-free guarantee.

Each authenticated upload request streams one raw file, not multipart: Content-Type, URL-encoded X-File-Name, exact X-Upload-Size and X-CSRF-Token headers. Names must have one matching extension; traversal, UNC/NTFS streams, reserved names and double extensions are rejected. Storage uses unrelated exclusive random keys. Actual bytes control limits even with false Content-Length. Quotas reserve before reading: default 10 files/draft, 100 MiB/uploader/Manila day, 1 GiB/project, 5 GiB/app. Failed/staged bytes count until physically removed. Attempts remain limited at 20 uploads and 120 downloads per user/15 minutes.

At most two request-bound validations run across app processes, using session advisory locks, with a 30-second deadline. The parser runs in a short-lived child with bounded memory and no database/key environment, awaited inside the request; there is no background worker, queue, extra role or lease/retry machinery. QUARANTINED becomes AVAILABLE only after validation, a private exclusive move and a live-scope database publication check. WORK policy or validator-key changes permanently reject pending uploads. Submission membership/version and duty are rechecked. Crashes fail closed; a future worker is deferred until volume warrants it.

Private bytes stay outside public/static hosting. Downloads stream through `/api/work/files/:id`, with current RLS/DUTY/MFA authorization and full size/hash verification before headers, attachment disposition, nosniff and no-store. No public URL, preview, range or HEAD download is supported. Every chunk rechecks authorization; withdrawing/restoring membership cannot revive an already-open stream. Data delivered before revocation cannot be recalled. Foreign/missing IDs return indistinguishable 404 to a valid work actor.

Use `pnpm uploads:cleanup` (or `pnpm uploads:cleanup --test`) as an explicit operator command for rejected/incomplete bytes older than 24 hours, at most 100 per invocation. It requires migration credentials, confines known paths, reconciles recognized interrupted hard-link promotion, retains rows/links/audit and never removes AVAILABLE content. `--file-id UUID` targets one eligible failed upload. There is no automatic cleanup daemon. Do not delete files manually to bypass quotas.

### Private storage backup and key rotation

The app identity must be the only ordinary account able to write PRIVATE_UPLOAD_ROOT; restrict its Windows ACL and prevent static serving/network shares. The default roots are `.local/private-uploads` and `.local/private-uploads-test`. The app rejects symlink/junction/hard-link escapes and public/drive/workspace roots, but filesystem ACL provisioning is an operator responsibility. Keep adequate free disk and quotas before real use.

**Back up private upload bytes together with the database.** Stop app writers and operator cleanup, take a consistent database dump plus the complete private root (objects and quarantine), record their common restore point, then resume. Preserve immutable file metadata, hashes and owner links; a database-only backup cannot restore attachments. Restore bytes and database from that same point, provision the private root/ACL, supply matching secrets, verify hashes and authorized downloads before reopening. A clean migration replay does not test backup restoration. A production restore rehearsal remains release work.

Back up UPLOAD_VALIDATION_KEY securely with environment configuration; keep the MFA keyring backed up **separately from the database** as described below. Losing the upload capability key does not decrypt or destroy existing bytes: stop writers, run `pnpm uploads:init-keys --rotate` with migration credentials to bind new keys in the local dev/test databases, restart all app processes with their matching environment, and reconcile failed pending uploads. This command rotates both local environment files, invalidates their pending uploads and leaves AVAILABLE objects unchanged. Preserve old backups before rotation. It never prints keys; do not pass secrets in command arguments. Remote/production use requires an explicit `--allow-production` operator flag and separately approved deployment. Losing the MFA keyring still forces authenticator re-enrollment.

Browser QA can optionally create clearly fake records in the dedicated test database only: `node --conditions=react-server --import tsx scripts/qa-work-fixture.ts`. It references the README seed example rather than storing another password; ignored .local/qa-work.json holds fake identifiers only. It is never imported by the app. No generated TOTP appears next to an input or in evidence screenshots.

## Duty authorization and secure access

Administrators open **Duty access**, select a Manila duty date, enter a reason and explicitly select employees to activate (maximum 100). Bulk activation is all-or-nothing; identical active windows are unchanged. Revoked grants require the separate **Regrant** action with a reason. Revoke increments the grant's authorization version, revokes bound DUTY sessions/challenges and audits in one transaction. Next-request access fails immediately after commit; no history is deleted. The dashboard shows real authorization records and a date/event/employee-filtered redacted security log, with explicit refresh/fetch time.

Employees open **Duty access** to view their own status/date and enter their current password. If PIN is enabled, it is a separate step; missing PIN blocks duty until configured in Account security. Enter the current code from the authenticator app after the optional PIN step. Successful PIN rotates challenge/CSRF; all stages share the original five-minute deadline. A TOTP used for enrollment, account reauthentication or another challenge cannot be reused. The app never displays a generated login TOTP. Successful duty authentication opens `/duty/context`; `/api/duty/context` and the page use the same server/DAL/database guard. ACCOUNT cookies cannot access it. Authentication alone creates no attendance or paid time; explicit attendance clocks are separate.

DUTY access uses a separate opaque cookie, with **30-minute idle** and **maximum twelve-hour absolute** server limits capped by the grant's valid_until. The cookie remains until the grant window ends only as a binding for same-grant reauthentication at `/duty/reauth`: current TOTP plus PIN when enabled, without another password. It cannot access protected data while expired. SECURITY/PIN changes revoke access and require fresh MFA under current requirements; grant revoke/regrant, logout, disabling, employment invalidation, account reset or factor-generation change cannot revive old tokens. Reauthentication rotates the duty handle and does not mint an ACCOUNT session. The account's own 15/60-minute limits remain independent. Sign out of duty from its protected context page, or sign out of the account workspace to clear both scopes.

Overnight is **disabled by default**. An administrator with recent MFA may append a WORK policy version permitting it, with a configurable carry ceiling of **1–8 hours** (default eight) after midnight. Each overnight grant still needs an explicit bounded end time; switching work policy does not extend an existing window. A grant first authenticated on its authorized date retains that date/version across Manila midnight and same-grant MFA reauthentication. Non-overnight access expires at midnight. There is no automatic next-date grant or new backdated start. Cleared handles or reset credentials may require fresh account/password login; a new start after the authorized date is denied. Attendance retains the original duty date and exact grant window; grant expiry reconciles open intervals at valid_until. No time is erased at midnight.

Backend connections explicitly use UTC; UI dates and windows use Asia/Manila. Test clock overrides are migration-owner fixtures in the dedicated local test database only, restored in finally. No HTTP field/header or production environment variable can change the clock. Run clock/rotation database tests and HTTP tests sequentially. The current checkpoint report and acceptance map distinguish passed duty-security portions from deferred time/upload/payroll work.

## Authenticator recovery and second administrator

At `/mfa/recovery`, password plus one unused recovery code **revokes** the old authenticator, every old recovery code and all sessions. It grants enrollment-only SETUP. Enroll a NEW generation, confirm its first TOTP and save fresh recovery codes before administrator access returns. Recovery never grants DUTY access. Codes are shown once, salted/hashed at rest and consumed transactionally. Regenerating them requires password + fresh TOTP and revokes the previous batch.

If both authenticator and codes are lost, a **different** MFA-authenticated administrator opens Account security, verifies identity and records a verification note and separate reason (10–500 characters each). Their TOTP proof must be at most five minutes old; use Verify recent MFA first if needed. The app immediately revokes the target's factor/codes/sessions and returns a private, one-time 15-minute reset token. The target submits password + token at `/mfa/recovery`, then enrolls/ confirms anew. A lost/expired recovery SETUP needs assisted reset because the old capabilities remain revoked. Password reset does not disable MFA.

Create a second administrator in this local-only deployment **explicitly**, using migration credentials from `.env`:

```powershell
pnpm db:seed --second-admin backup.admin backup.admin@example.invalid
```

This local seed mode requires an existing administrator, creates only the requested new administrator, refuses production/remote targets, and never updates existing credentials. Its random temporary password is displayed once in the private operator terminal. Do not capture terminal output; deliver privately. The new administrator must change that password and independently enroll/confirm TOTP. Do not leave a backup account using shared credentials.

For the last administrator who lost device and codes, the server operator can use:

```powershell
pnpm mfa:reset-admin --username backup.admin
```

This CLI requires `MIGRATION_DATABASE_URL` and verifies it is the table-owner authority. It is not imported by request handlers and has no web endpoint. It prints the target database/account, requires the exact `RESET username` confirmation, verification note and reason, and appends a CLI/operator audit event. It revokes MFA/codes/sessions and outputs a private one-time reset token; password, role and enabled status stay unchanged. It refuses production (`NODE_ENV=production`), remote hosts or unrecognized database names unless explicitly passed `--allow-production`; application-role credentials are always refused. The flag permits the target only: the interactive confirmation is still mandatory. No production use is authorized in this local-only phase. If the account password is also lost, this MFA-only tool cannot recover it; a separately approved password-recovery procedure is required.

## MFA keyring backup, loss and rotation

`MFA_ENCRYPTION_KEYS` is a JSON map of key IDs to base64 32-byte keys; `MFA_ACTIVE_KEY_ID` selects encryption for new records. Supply both through the environment/secret manager. They are separate from SESSION_SECRET. Secrets use AES-256-GCM with fresh nonces and user/enrollment/generation-bound associated data. No plaintext secret, QR or provisioning URI is persisted or logged. QR encoding is local; no external QR service receives it.

**Back up the complete usable keyring separately from the database**, encrypted with separate access control. Retain key IDs needed by retained database backups. A database dump alone cannot restore authenticators. Losing the entire keyring forces every enrolled user to re-enroll: provide a NEW key under a NEW ID, invalidate sessions, then use password + saved recovery codes, assisted reset, or the last-administrator operator tool. Never generate a different key under an existing ID or silently overwrite key configuration. Missing keys/tag failures deny verification. Recovery codes/passwords can revoke an old factor without decrypting its lost secret, but a valid new keyring is required to enroll the replacement.

To rotate keys with server/migration access:

1. Generate a fresh cryptographic 32-byte key in your secret manager and give it a new ID. Retain all old keys in the JSON map, back up the new map separately, and change MFA_ACTIVE_KEY_ID to the new ID. Do not put key values in command arguments, logs or Git.
2. Restart app processes with the complete map/new active ID so they can decrypt both generations of ciphertext. Keep all instances consistent.
3. Run `pnpm mfa:rotate-keys` with migration credentials and that same environment. Remote/production targets require `--allow-production`. The transaction re-encrypts active/pending secrets with fresh nonces, preserves enrollment generations and replay counters, and audits the count/new key ID. A failure rolls back the rotation.
4. Verify sign-in and that all active/pending rows use the new key ID. Retain old keys until no live ciphertext **and no retained backup** requires them. Test restores with their corresponding keyring before retiring any old ID. Do not reuse key IDs.

The initializer creates keys for fresh local environment files; it is not the rotation or lost-key recovery tool.

## Tests and build

Tests require the dedicated local test database and never run against production or the development database. Keep the database running. For a fresh database, first use the empty-database setup/seed above. On an existing prepared database, apply new test migrations and preserve seeds/data, then run pnpm test in PowerShell:

```powershell
Set-Location -LiteralPath 'C:\Users\Dell\Desktop\Libetario Digital Marketing Services'
Set-Alias pnpm 'C:\Users\Dell\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd'
$env:DOTENV_CONFIG_PATH = '.env.test.local'
node --import dotenv/config node_modules/prisma/build/index.js migrate deploy
Remove-Item Env:DOTENV_CONFIG_PATH
pnpm uploads:init-keys
pnpm test
```

Run the database suite and HTTP suite sequentially: operator rotation and trusted-clock fixtures temporarily change test-only state and restore it in finally. Do not run pnpm test while HTTP tests or a browser QA session use the test database. Tests retain randomly named history instead of truncating protected audit records.

**Only one Next server may run per checkout folder**, even on different ports: `.next/dev/lock` and generated types are shared. Stop this folder's normal pnpm dev with Ctrl+C before starting the test server. Keep PostgreSQL running. In test-server terminal A:

```powershell
Set-Location -LiteralPath 'C:\Users\Dell\Desktop\Libetario Digital Marketing Services'
$env:DOTENV_CONFIG_PATH = '.env.test.local'
$env:APP_ORIGIN = 'http://127.0.0.1:3001'
$env:NEXT_TELEMETRY_DISABLED = '1'
node --import dotenv/config node_modules/next/dist/bin/next dev --webpack --hostname 127.0.0.1 --port 3001
```

In terminal B, run:

```powershell
Set-Location -LiteralPath 'C:\Users\Dell\Desktop\Libetario Digital Marketing Services'
Set-Alias pnpm 'C:\Users\Dell\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd'
$env:HTTP_TEST_ORIGIN = 'http://127.0.0.1:3001'
pnpm test:http
Remove-Item Env:HTTP_TEST_ORIGIN
```

After HTTP tests, stop terminal A with Ctrl+C. In terminal B, with no Next server running, run:

```powershell
pnpm db:replay-check
pnpm typecheck
pnpm build
pnpm audit --prod
```

Replay creates a new random database, applies all **49 migrations**, checks **34 RLS-enabled application tables**, and drops only that disposable database. To resume normal development in terminal A:

```powershell
Remove-Item Env:DOTENV_CONFIG_PATH -ErrorAction SilentlyContinue
Remove-Item Env:APP_ORIGIN -ErrorAction SilentlyContinue
Remove-Item Env:NEXT_TELEMETRY_DISABLED -ErrorAction SilentlyContinue
pnpm dev
```

Do not start Next with Node's --env-file flag: this installed version forwards that unsupported flag to worker NODE_OPTIONS. dotenv/config avoids it. Webpack is used because Turbopack's CSS worker failed on this Windows runtime. Test fixtures import .env.test.local themselves; the server explicitly loads it. Upload key/root must match that test database, never the development database. If an initializer rotates an environment key, restart the test server before HTTP tests.

`pnpm start` is a production server: production runtime requires an HTTPS `APP_ORIGIN`, appropriate reverse-proxy/TLS setup, and real environment secrets. Use `pnpm dev` for the local HTTP workflow. Passing a build does not authorize deploying real employee data before the duty-security and release gates.

See the [Phase 4b report](docs/PHASE_4B_REPORT.md), [accepted Phase 4a report](docs/PHASE_4A_REPORT.md), [policy defaults](docs/ASSUMPTIONS.md), [security notes](docs/SECURITY.md) and [acceptance coverage](docs/TEST_COVERAGE.md). Phase 5 requires separate owner approval.
