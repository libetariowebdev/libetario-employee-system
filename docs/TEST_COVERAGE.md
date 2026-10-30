# Acceptance coverage through checkpoint 2b

All 55 accepted checks remain, with the schema boundary updated from fifteen to seventeen tables. New tests use real PostgreSQL, actual non-owner/NOBYPASSRLS connections and a real Next.js HTTP server. Authorization is not mocked. Clock tests replace private.security_now() only through its migration owner in the dedicated local libetario_test database and restore it in finally; no request/environment clock override exists.

| Blueprint scenario | Current evidence and status | Deferred portion |
| --- | --- | --- |
| Section 14 Phase 1 staff isolation | **PASSED**, retained A↔B app/DAL/runtime SQL and actual HTTP/SSR regression. Employees retain own rate history. | None for the accepted foundation |
| 15.1 activated A, inactive B | **Phase 2 security portion PASSED**: admin activates A, B has no grant; A completes staged login and reaches real shared duty guard/page; B and ACCOUNT-only cookies are denied. Runtime duty guard returns only own exact authorization. | Actual clock-in is Phase 4 |
| 15.2 password/PIN/TOTP failures, lockout, recovery/reset | **PASSED in full for Phase 2**: password login/canonical account/network locks; PIN off/on/missing/wrong/reordered stages; PIN lockout across new challenges and expiry; independent TOTP network limit; global replay across purposes and concurrent independent challenges; expired/consumed/replaced/foreign binding rejection; recovery code single use/concurrency/regeneration; new-factor confirmation before privileged scope; audited assisted reset/note/reason/recent MFA, reset token expiry/once; old credentials/sessions invalidated; operator/last-admin and key protection regressions. | No duty factor/recovery/reset case is deferred |
| 15.3 revoke during active session | **Phase 2 security portion PASSED**: committed revoke denies next real HTTP request and direct runtime guard query; deterministic races cover revoke-first and issuance-first; regrant cannot revive tokens; counts/history retained and prior first-authentication metadata kept in audit. | Actual recorded attendance/task-time preservation is Phase 4; those tables do not exist yet |
| 15.4 shared task/contribution separation | **DEFERRED Phase 3** | No project/task tables/endpoints exist |
| 15.5 pause/resume/multiple dates/no overlaps | Rate/schedule exclusion constraints and time/cutoff helpers pass | **DEFERRED Phase 4** for real segments/timers |
| 15.6 Clock Out with running timer | Policy assumption documented | **DEFERRED Phase 4** |
| 15.7 attendance/task separation | Authentication creates no attendance/pay rows | **DEFERRED Phase 4** for actual totals |
| 15.8 distinct daily/hourly pay/frozen final history | Exact per-employee rates, effective history and unchanged old values pass | **DEFERRED Phase 5** for payroll/snapshot reconciliation |
| 15.9 punch corrections/draft recalc/approved adjustments | Existing profile/rate/schedule reason/audit checks pass | **DEFERRED Phases 4/5** for time/payroll workflows |
| 15.10 own finalized PDF / guessed URLs | No public payslip endpoint exists | **DEFERRED Phase 5**, actual protected PDFs required |
| 15.11 approval/payment separation | No payroll/payment transitions exist | **DEFERRED Phase 5** |
| 15.12 overnight/cutoffs/rollover/missing punches/MFA/uploads/mobile | **Phase 2 overnight/access portion PASSED**: default-off and carry ceiling, before/after Manila midnight, original grant/date retained, explicit window end, non-overnight midnight denial, idle/absolute expiry, same-grant TOTP(+PIN) reauth without password, no next-date activation/new backdated regrant start. Existing money/time/cutoff/failed-MFA checks pass. Mobile staged duty screen reviewed at 390px with document width 375px. | Protected uploads Phase 3; actual punches/shift/time rollover Phase 4; full release/browser regression Phase 6 |

## Executed test inventory

| File | Tests |
| --- | ---: |
| tests/checkpoint/rls.test.ts | 5 |
| tests/integration/foundation.test.ts | 18 |
| tests/integration/mfa.test.ts | 13 |
| tests/integration/duty.test.ts | 8 |
| tests/unit/mfa.test.ts | 6 |
| tests/unit/money-time.test.ts | 4 |
| tests/e2e/http.test.ts | 4 |
| tests/e2e/mfa-http.test.ts | 5 |
| tests/e2e/duty-http.test.ts | 10 |
| **Total** | **73** |

**54 unit/database + 19 actual HTTP checks**, including all 55 previous checks and 18 new duty checks. Targeted reruns are not counted as extra tests. Exact final results, build/replay/audit and known limits are in PHASE_2B_REPORT.md.

Additional new evidence includes max-100 bulk success/101 rejection, atomic invalid-employee rollback, unchanged active no-ops (including an older valid overnight snapshot after WORK is disabled), explicit regrant reasons/versioning, direct-function null-action rejection, active employment enforcement, revocation of disabled employees, no expired-handle revival on reactivation, hidden owner-only guard base, no arbitrary runtime grant/challenge writes and UTC HTTP timestamp/12-hour reconciliation. SECURITY switch invalidates access/challenges but permits a fresh same-grant challenge under current policy, never reuse of the invalidated proof.

Race tests use owner-held PostgreSQL row locks and observe actual blocked requests before release, rather than hoping concurrent promises happen in a particular order. The trusted-clock tests drive real HTTP requests through real RLS. Fixtures restore policy/clock settings; only test network counters are reset for isolation after clock tests. Audit/history rows remain intact. Key rotation and clock tests run sequentially with HTTP tests. Screenshots contain fake authorization data and an empty TOTP field, never OTPs, QR secrets, bearer tokens, PINs or recovery codes.

Clean replay checks all fifteen migrations and exactly seventeen RLS-enabled application tables. No projects, tasks, uploads, shifts, timers, attendance, payroll or payment tables were introduced. A clean migration replay is not a production backup/restore rehearsal.
