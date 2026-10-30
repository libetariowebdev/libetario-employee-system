# Acceptance coverage through Phase 2a

Real PostgreSQL, non-owner/NOBYPASSRLS runtime queries and a real Next.js HTTP server are used. No SQLite or mocked authorization substitutes for these checks. Phase 1 remains accepted. Phase 2a is the approved MFA checkpoint only; **no complete Section 15 duty scenario is claimed passed yet**.

| Blueprint scenario | Passed evidence | Remaining gate/status |
| --- | --- | --- |
| Section 14 Phase 1 staff isolation | App/DAL/direct runtime-role A→B and B→A profile/rate denial, guessed UUID URLs, own records and administrator reads, SSR/client payload isolation | **PASSED**, retained regression coverage |
| 15.1 activated A / inactive B duty login and tools | ACCOUNT/SETUP cannot call absent duty endpoints | **DEFERRED 2b**: grants, challenge stages and actual duty login/tools |
| 15.2 wrong password/PIN/TOTP, lockout, recovery/reset | Password canonical-account/network locks; hashed PIN setup and independent lockout; RFC TOTP, drift, replay/concurrent use, persistent locks; bound/expired/replayed SETUP; hashed single-use/concurrent recovery; old-factor/session revocation; new-generation confirmation; assisted reset note/reason/recent different-admin checks; token expiry/single use; operator reset safeguards/audit; actual HTTP admin MFA and recovery transitions | **2a component matrix PASSED; scenario remains PARTIAL** until 2b tests optional PIN and TOTP through actual duty challenges/login, duty reauthentication and duty-scope restrictions |
| 15.3 active duty revocation retains time | Account disabling/MFA reset/recovery immediately revoke next-request access; profiles/rates/audit retained | **DEFERRED 2b** for duty authorization_version invalidation; Phase 4 for recorded attendance/task-time preservation |
| 15.4 shared assignments/contributions | No task table/API exists | **DEFERRED Phase 3** |
| 15.5 pause/resume, multiple dates, non-overlap | Time/cutoff helpers and rate/schedule exclusion constraints pass | **DEFERRED Phase 4** for actual segments/timers |
| 15.6 Clock Out with running timer | Configurable proposed close policy documented | **DEFERRED Phase 4** |
| 15.7 attendance/task separation | Login and MFA create no attendance/pay data | **DEFERRED Phase 4** for actual attendance/task comparisons |
| 15.8 daily/hourly pay and frozen final history | Exact individual Decimal rates, effective history, old values and overlap constraints pass | **DEFERRED Phase 5** for payroll/snapshot reconciliation |
| 15.9 punch correction/draft recalculation/approved adjustment | Profile/rate/schedule edits carry mandatory reasons and append-only audits | **DEFERRED Phases 4/5** for actual time/payroll corrections |
| 15.10 own finalized PDF / guessed URL denial | No public/static payslip route exists | **DEFERRED Phase 5**, actual protected PDFs required |
| 15.11 Approved vs Paid | No payroll/payment transitions exist | **DEFERRED Phase 5** |
| 15.12 overnight/cutoffs/rollover/missing punches/failed MFA/uploads/mobile | Exact money/rounding, Asia/Manila midnight and weekly cutoffs pass. Failed MFA and expiry pass; mobile recovery form reviewed at 390px with no horizontal overflow. DUTY policy utility has separate 30-minute idle/12-hour ceiling bounded by valid_until; ACCOUNT remains 15/60. | **PARTIAL**: same-grant TOTP(+PIN) reauth without password and actual overnight grant/session behavior in 2b; punches/time rollover Phase 4, malformed protected uploads Phase 3, further regression Phase 6 |

## Test inventory

- `tests/checkpoint/rls.test.ts`: 5 original profile/rate runtime-role isolation checks.
- `tests/integration/foundation.test.ts`: 18 account, profile, policy, CSRF, audit and schema-boundary checks, updated to fifteen tables/admin MFA fixtures.
- `tests/unit/money-time.test.ts`: 4 exact-money, timezone/cutoff and password-policy checks.
- `tests/unit/mfa.test.ts`: 6 RFC vectors, drift/replay, user-bound AEAD, missing keys, safe initialization, separate duty lifetime defaults and operator-target guards.
- `tests/integration/mfa.test.ts`: 13 real-DB checks covering enrollment, replay/concurrency, recovery/new generation, PIN, reset, runtime-role/column grants, operator CLI refusal/confirmation/audit, actual key rotation, explicit second-admin seed, pending expiry, disabling and recent-MFA/policy preservation.
- `tests/e2e/http.test.ts`: 4 original actual-server regression checks, administrator login now completes real TOTP.
- `tests/e2e/mfa-http.test.ts`: 5 actual-server checks for MFA gates, cookie rotation/replay, admin recovery and new-factor confirmation, assisted reset, lockout/expiry, CSRF and absent duty/operator routes.

Total: **46 unit/database checks + 9 real HTTP checks = 55 automated tests**. Exact executed results and build/replay evidence are in PHASE_2A_REPORT.md. Tests use a dedicated `_test` database and random fake users; migration/owner access is limited to fixtures and operator CLI tests. Direct runtime-role probes verify denied PIN/recovery hashes, enrollment ciphertext, forged claims, cross-user enrollment reads, role escalation and operator function execution. Schema replay verifies all eleven migrations create exactly fifteen RLS-enabled application tables; duty_authorizations/auth_challenges are absent.

The operator test sets NODE_ENV=production against the **local test database** to prove refusal without a flag and successful explicit confirmation with it. No production system is touched. The rotation test selects a temporary test key and restores the original selection in `finally`; run database and HTTP suites sequentially. Audit records are retained; tests do not truncate protected history. No raw enrollment QR, recovery code, PIN or key is written to report/screenshots. Browser evidence shows only empty forms and fake test access.
