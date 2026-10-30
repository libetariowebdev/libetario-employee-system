# Libetario team workspace — Phase 1

Standalone employee-management foundation for Libetario Digital Marketing Services. Next.js App Router + TypeScript + Tailwind, PostgreSQL 18, Prisma 7 migrations, Argon2id passwords, persisted account sessions, server authorization and PostgreSQL row-level security.

Phase 1 includes real account/profile/rate/schedule management. Duty authorization, PIN/TOTP, tasks, attendance and payroll/PDF are unavailable until their approved phases. Signing in does not record paid time. The full blueprint schema is a design reference; only the twelve approved Phase 1 tables exist.

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
pnpm db:migrate
pnpm db:generate
pnpm db:seed
pnpm dev
```

Open [the local workspace](http://127.0.0.1:3000). Use exactly this origin rather than `localhost` unless you also update `APP_ORIGIN`.

**For this already-prepared workspace:** bootstrap, migrations and seed have been completed. Preserve the ignored `.env` and `.local/` files. Start `pnpm db:local` if the database is stopped, then `pnpm dev`. Do not rerun bootstrap or seed over existing data: both refuse rather than replacing credentials/data. Stop each server with Ctrl+C in its owning terminal.

`db:bootstrap` creates only `libetario` and `libetario_test` in this dedicated cluster, generates random database passwords and a session secret, and writes ignored `.env` / `.env.test.local` files. Never commit or share these files. `.env.example` contains configuration names only. The two app roles are non-owner, non-superuser, NOBYPASSRLS and have no membership in one another.

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

**Administrator:** sign in, change the temporary password, then sign in again. Use Employees to create staff or open a profile. Edit personal details and status with a reason. Add rates and schedules using effective dates later than the newest existing entry; earlier intervals close automatically while retaining their values. Disable an account to revoke all its sessions without deleting history. Audit trail shows the latest 50 changes and their reasons. Settings creates immutable security-policy versions.

**Employee:** sign in and replace the temporary password. View your own profile, individual rate history and schedule. There is no employee directory or profile-edit endpoint. Change your password from My profile, or ask the administrator to verify your identity and issue a reset token.

**Reset:** administrator opens the employee profile, records how identity was verified, and issues a token. Every existing session and older reset token is invalidated immediately. The token is shown once for private delivery. Employee enters it at `/reset-password` with a new password, then signs in afresh. Default validity is 15 minutes. No email transport is claimed or configured.

An account with an unconfigured rate or schedule displays an explicit empty state. New profiles do not inherit a fictional wage or workweek. Money inputs are decimal strings; the exact four-decimal rate remains visible alongside the two-decimal PHP display. History end dates are exclusive.

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

The replay check creates a new randomly named database, applies all migrations, checks the twelve-table/RLS boundary, and drops only that freshly created disposable database. Tests add randomly named fixtures to `libetario_test`, retaining test history instead of truncating protected audit records.

For real HTTP checks, start a separate test server in one terminal:

```powershell
$env:DOTENV_CONFIG_PATH = '.env.test.local'
$env:APP_ORIGIN = 'http://127.0.0.1:3001'
$env:NEXT_TELEMETRY_DISABLED = '1'
node --import dotenv/config node_modules/next/dist/bin/next dev --webpack --hostname 127.0.0.1 --port 3001
```

Then run `pnpm test:http` in another terminal. Close the test-server terminal or restore its environment before starting the normal development server. Do not start Next with Node's `--env-file` flag: this installed Next version forwards that unsupported flag to worker `NODE_OPTIONS`. `dotenv/config` avoids that problem. Webpack is selected because Turbopack's CSS worker failed on this Windows runtime; the supported webpack production build passes.

`pnpm start` is a production server: production runtime requires an HTTPS `APP_ORIGIN`, appropriate reverse-proxy/TLS setup, and real environment secrets. Use `pnpm dev` for the local HTTP workflow. Passing a build does not authorize deploying real employee data before the duty-security and release gates.

See [Phase 1 report](docs/PHASE_1_REPORT.md), [policy defaults](docs/ASSUMPTIONS.md), [security and backup notes](docs/SECURITY.md), and [acceptance coverage](docs/TEST_COVERAGE.md).
