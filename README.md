# Libetario team workspace — Phase 2b

Standalone employee-management foundation for Libetario Digital Marketing Services. Next.js App Router + TypeScript + Tailwind, PostgreSQL 18, Prisma 7 migrations, Argon2id passwords, persisted account sessions, server authorization and PostgreSQL row-level security.

Real account/profile/rate/schedule management includes encrypted authenticator enrollment, mandatory administrator TOTP, hashed employee PINs, recovery/reset and secure duty authorization/login. Exactly seventeen application tables exist: the accepted fifteen plus duty_authorizations and auth_challenges. Tasks, attendance and payroll/PDF remain later phases. Signing in does not record paid time. Phase 3 has not started.

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
pnpm dev
```

Open [the local workspace](http://127.0.0.1:3000). Use exactly this origin rather than `localhost` unless you also update `APP_ORIGIN`.

**For this already-prepared workspace:** bootstrap, migrations and seed have been completed. Preserve the ignored `.env` and `.local/` files. Start `pnpm db:local` if the database is stopped, then `pnpm dev`. Do not rerun bootstrap or seed over existing data: both refuse rather than replacing credentials/data. Stop each server with Ctrl+C in its owning terminal.

`db:bootstrap` creates only `libetario` and `libetario_test` in this dedicated cluster, generates random database passwords and a session secret, and writes ignored `.env` / `.env.test.local` files. `mfa:init-keys` adds separate random MFA keyrings to those files; it validates/preserves existing keys, refuses partial/invalid configuration and never prints keys. Never commit or share these files. `.env.example` contains configuration names only. The two app roles are non-owner, non-superuser, NOBYPASSRLS and have no membership in one another.

For an existing Phase 1 checkout, preserve environment/data files, run `pnpm mfa:init-keys`, `pnpm db:migrate`, and `pnpm db:generate`. Apply migrations to the separate test database as shown below. The Phase 2a migration revokes pre-MFA sessions; administrators must sign in and enroll. Do not rerun bootstrap or the default seed.

Docker is an alternative to embedded PostgreSQL: use `compose.yaml` with a private `LOCAL_DB_PASSWORD`, then have the DBA provision the two app roles as described in [security/deployment notes](docs/SECURITY.md). The embedded bootstrap script is specifically for the embedded cluster; do not run it against a provider or existing database.

## Fake, temporary sample credentials

Development only; no real people or real payroll data. These credentials are defined only here and in `prisma/seed.ts`. Every seeded account must change its password before seeing protected records.

| Role | Username | Email | Temporary password |
| --- | --- | --- | --- |
| Administrator | `demo.admin` | `admin@example.invalid` | `FakeAdmin-ChangeMe-2026!` |
| Employee A | `demo.employee.a` | `employee.a@example.invalid` | `FakeEmployeeA-ChangeMe-2026!` |
| Employee B | `demo.employee.b` | `employee.b@example.invalid` | `FakeEmployeeB-ChangeMe-2026!` |

Seed refuses production, remote hosts, unexpected database names, and databases containing accounts. It does not reset users on rerun. Initial passwords are never logged by the app. New employees created by an administrator receive a random temporary password in a one-time response and must change it. Deliver it privately; use the reset workflow if it is lost.

## Use the app

**Administrator:** sign in, change the temporary password, then sign in again. Before administrator access, enroll an authenticator with the one-time local QR and confirm its first code; save the ten recovery codes privately. Later sign-ins require password followed by current TOTP. The intermediate five-minute SETUP session cannot read employee records or use administrator tools, including through direct runtime-role queries. Use Employees to create staff or open a profile. Edit personal details and status with a reason. Add rates and schedules using effective dates later than the newest existing entry. Disable an account to revoke all sessions without deleting history. Account security shows real enrollment metadata and the latest security events and offers assisted reset. Audit trail shows the latest 50 changes. Settings appends immutable security-policy versions, requires recent MFA and rejects stale edits.

**Employee:** sign in and replace the temporary password. View your own profile, individual rate history and schedule. There is no employee directory or profile-edit endpoint. Change your password from My profile, or ask the administrator to verify your identity and issue a reset token.

Employees use Account security to enroll TOTP and save recovery codes. Setting/changing/replacing a forgotten six-digit PIN requires current password plus a fresh TOTP. PINs are Argon2id-hashed. SECURITY.pinEnabled ships **false**; duty sign-in enforces it when enabled. ACCOUNT sessions retain 15-minute idle/60-minute absolute defaults. SETUP is five minutes absolutely, with no sliding extension. Separate SECURITY defaults are dutyIdleMinutes=30 and dutyMaxHours=12, capped by the authorized duty window end; same-grant reauthentication requires current TOTP plus PIN when enabled, without repeating password login.

TOTP uses SHA1, six digits, 30-second periods and ±1-step drift. A consumed counter cannot be reused, including the enrollment-confirmation code. Wait for a fresh code before a second action. PIN/TOTP/recovery default to five failed attempts per account/factor in 15 minutes and a 15-minute lockout. SETUP is revoked on its fifth failure; reissuing it does not clear account/network counters. Network factor limit is 30 and recovery network limit is five. Security settings are versioned; unfinished SETUP capabilities are invalidated on a security-policy change.

**Reset:** administrator opens the employee profile, records how identity was verified, and issues a token. Every existing session and older reset token is invalidated immediately. The token is shown once for private delivery. Employee enters it at `/reset-password` with a new password, then signs in afresh. Default validity is 15 minutes. No email transport is claimed or configured.

An account with an unconfigured rate or schedule displays an explicit empty state. New profiles do not inherit a fictional wage or workweek. Money inputs are decimal strings; the exact four-decimal rate remains visible alongside the two-decimal PHP display. History end dates are exclusive.

## Duty authorization and secure access

Administrators open **Duty access**, select a Manila duty date, enter a reason and explicitly select employees to activate (maximum 100). Bulk activation is all-or-nothing; identical active windows are unchanged. Revoked grants require the separate **Regrant** action with a reason. Revoke increments the grant's authorization version, revokes bound DUTY sessions/challenges and audits in one transaction. Next-request access fails immediately after commit; no history is deleted. The dashboard shows real authorization records and a date/event/employee-filtered redacted security log, with explicit refresh/fetch time.

Employees open **Duty access** to view their own status/date and enter their current password. If PIN is enabled, it is a separate step; missing PIN blocks duty until configured in Account security. Enter the current code from the authenticator app after the optional PIN step. Successful PIN rotates challenge/CSRF; all stages share the original five-minute deadline. A TOTP used for enrollment, account reauthentication or another challenge cannot be reused. The app never displays a generated login TOTP. Successful duty authentication opens `/duty/context`; `/api/duty/context` and the page use the same server/DAL/database guard. ACCOUNT cookies cannot access it. There is no clock-in, timer or paid time.

DUTY access uses a separate opaque cookie, with **30-minute idle** and **maximum twelve-hour absolute** server limits capped by the grant's valid_until. The cookie remains until the grant window ends only as a binding for same-grant reauthentication at `/duty/reauth`: current TOTP plus PIN when enabled, without another password. It cannot access protected data while expired. SECURITY/PIN changes revoke access and require fresh MFA under current requirements; grant revoke/regrant, logout, disabling, employment invalidation, account reset or factor-generation change cannot revive old tokens. Reauthentication rotates the duty handle and does not mint an ACCOUNT session. The account's own 15/60-minute limits remain independent. Sign out of duty from its protected context page, or sign out of the account workspace to clear both scopes.

Overnight is **disabled by default**. An administrator with recent MFA may append a WORK policy version permitting it, with a configurable carry ceiling of **1–8 hours** (default eight) after midnight. Each overnight grant still needs an explicit bounded end time; switching work policy does not extend an existing window. A grant first authenticated on its authorized date retains that date/version across Manila midnight and same-grant MFA reauthentication. Non-overnight access expires at midnight. There is no automatic next-date grant or new backdated start. Cleared handles or reset credentials may require fresh account/password login; a new start after the authorized date is denied. No recorded time is erased or calculated at these boundaries; attendance is Phase 4.

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

Tests require the dedicated local test database and never run against production or the development database. Apply its migrations once, and after migration changes:

```powershell
$env:DOTENV_CONFIG_PATH = '.env.test.local'
node --import dotenv/config node_modules/prisma/build/index.js migrate deploy
Remove-Item Env:DOTENV_CONFIG_PATH
pnpm test
pnpm db:replay-check
pnpm typecheck
pnpm build
```

The replay check creates a new randomly named database, applies all fifteen migrations, checks the seventeen-table/RLS boundary, and drops only that freshly created disposable database. Tests add randomly named fixtures to `libetario_test`, retaining test history instead of truncating protected audit records. Run the database suite and HTTP suite sequentially: operator rotation and trusted-clock fixtures temporarily change test-only state and restore it in `finally`.

For real HTTP checks, start a separate test server in one terminal:

```powershell
$env:DOTENV_CONFIG_PATH = '.env.test.local'
$env:APP_ORIGIN = 'http://127.0.0.1:3001'
$env:NEXT_TELEMETRY_DISABLED = '1'
node --import dotenv/config node_modules/next/dist/bin/next dev --webpack --hostname 127.0.0.1 --port 3001
```

Then run `pnpm test:http` in another terminal. Close the test-server terminal or restore its environment before starting the normal development server. Do not start Next with Node's `--env-file` flag: this installed Next version forwards that unsupported flag to worker `NODE_OPTIONS`. `dotenv/config` avoids that problem. Webpack is selected because Turbopack's CSS worker failed on this Windows runtime; the supported webpack production build passes.

`pnpm start` is a production server: production runtime requires an HTTPS `APP_ORIGIN`, appropriate reverse-proxy/TLS setup, and real environment secrets. Use `pnpm dev` for the local HTTP workflow. Passing a build does not authorize deploying real employee data before the duty-security and release gates.

See [Phase 2b report](docs/PHASE_2B_REPORT.md), [accepted Phase 2a report](docs/PHASE_2A_REPORT.md), [policy defaults](docs/ASSUMPTIONS.md), [security and backup notes](docs/SECURITY.md), and [acceptance coverage](docs/TEST_COVERAGE.md). Stop before Phase 3 pending owner approval.
