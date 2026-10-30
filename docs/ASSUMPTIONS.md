# Configurable policy defaults and open decisions

Status: Phase 1 implementation defaults, approved with the owner's 30 October 2026 changes. Later-phase policies remain design references. These are software safeguards, not a determination of employment classification or payroll compliance.

## Approved Phase 1 boundary

Only these tables migrate now: users, employee_profiles, policy_versions, company_settings, employee_schedule_history, employee_schedule_days, employee_rate_history, sessions, security_throttles, auth_events, audit_log, credential_resets. The complete schema in PHASE_1_PLAN.md is a design reference only. First prove restricted-role RLS on profiles/rates, then extend it to the remaining Phase 1 tables.

Hosting is local only for now because the supplied hosting selection still contains its placeholder. Production settings remain environment-based. No production deployment is authorized at this gate.

## Foundation defaults

| Policy | Proposed default |
| --- | --- |
| Deployment | Standalone Next.js/PostgreSQL app with its own empty database. Local development first; no existing client/invoicing database access. Integration remains documentation only. |
| Roles | Exactly Administrator and Employee. Designation does not grant permissions. No public signup, impersonation, or employee directory. |
| Employee access | Own profile, own schedule, and own rate history only in Phase 1. Administrator performs profile edits until verified self-service is built. |
| Login identifiers | Case-insensitive, trimmed canonical email/username. Username excludes `@`. Email change is administrator-managed and audited. |
| Passwords | Argon2id with 19,456 KiB memory, two iterations, parallelism one; 12–128 Unicode code points, at least one letter and one non-letter, no trimming or silent truncation. Seed/reset passwords require a change. New password must differ from the existing password. |
| Password reset | Enabled administrator records an identity-verification note of 10–500 characters. Server creates a random 32-byte single-use token, stores its SHA-256 hash with a 15-minute expiry, revokes all existing sessions, and invalidates older unused reset tokens in the same transaction. Token is returned once to that administrator for private delivery; never logged or emailed by the app. Employee submits the token with a new compliant password. Atomic consumption prevents replay. All sessions remain revoked and a fresh login is required. No password is set or disclosed by the administrator. |
| Session lifetime | 15-minute idle timeout and 60-minute absolute timeout, configurable. Opaque random cookies; hashed tokens in DB; HttpOnly, SameSite=Lax, Secure under HTTPS. Production refuses insecure configuration. |
| Login throttling | Five account failures within a rolling 15-minute attempt window lock the canonical account for 15 minutes; 30 failures per network key per 15 minutes restrict that network key for 15 minutes. Email and username resolve to the same account key. Unknown identifiers have their own hashed key. Reset-token failures: five per token/network key per 15 minutes, locked for 15 minutes. Persistent counters are serialized in PostgreSQL. Proxy headers are ignored unless TRUST_PROXY is explicitly enabled; otherwise use a shared untrusted-network bucket. |
| Data handling | UTC instants, Asia/Manila display and business dates. PHP money via Decimal; rates at four decimal places, finalized amounts at two. |
| Rate/schedule changes | Effective-date history with no overlapping intervals. Retroactive edits affecting finalized payroll require a corrective workflow; approved snapshots are immutable. |
| Production readiness | Password-only Phase 1 sessions grant no duty capability. No real payroll or employee production rollout before later security/release gates. |
| Retention | Disable accounts and retain history; no automatic record deletion. Owner must approve retention and backup policies before release. |

## Duty and work policies for later phases

All policies below will be persisted in validated, versioned configuration. Changes are administrator-only and audited; payroll records retain the applied version.

| Policy | Proposed default |
| --- | --- |
| PIN | OFF, as permitted by the blueprint; TOTP remains mandatory for duty. When enabled, require six digits, hash using Argon2id, and apply independent attempt limits. |
| PIN/TOTP/recovery throttling | Five failures per account and challenge within 15 minutes trigger a 15-minute lockout; challenges expire after five minutes and are single-use. Network throttling also applies. |
| TOTP | RFC 6238, six digits, 30-second step, at most one step clock drift. Compare-and-update the accepted step transactionally; an already accepted or older step is rejected. Encrypted pending enrollment expires; first valid code must confirm it. |
| MFA recovery | Single-use hashed recovery codes and administrator-assisted identity verification. Recovery revokes old enrollment/codes and sessions, is audited, and requires fresh enrollment before duty. |
| Off-duty access | Own profile/schedule, a duty-access request when built, and previously finalized own payslips when built. No work tools or clock-in. |
| Clock Out with timer | Close the running task segment at the same server timestamp as Clock Out, record the reason, and require explicit Start/Resume for later work. |
| Duty revocation during work | Revoke active duty sessions and close open task/attendance intervals at the server revocation time in the same transaction. Preserve recorded time as pending review; do not erase it or silently turn it into a deduction. |
| Overnight shifts | Disallowed unless explicitly enabled in the employee's schedule/policy. When enabled, keep the authorized duty date; default maximum elapsed shift is 16 hours with an exception alert and mandatory attendance review. No automatic unpaid truncation of existing time at midnight or a limit. Reauthentication may resume access only while that duty remains valid. |
| Multiple shifts | Allowed under the same authorization until duty is explicitly completed, revoked, or expires; no overlapping shifts or timers. Clock Out alone closes a shift, with final duty completion an explicit configured action. |
| Breaks | No automatic break deduction. Explicit break intervals are paid by default; an accountant-approved policy is required before classifying a break as unpaid. |
| Schedules | No assumed workweek or clock times. Unconfigured schedules/rates block payroll readiness and later automatic duty activation. Expected hours must be entered before a daily rate is usable. |
| Shared tasks | Shared task plus distinct employee assignments/contributions. Overall completion counts the task once; assignment does not itself create wages. |
| Attendance versus task time | Keep totals distinct. Unallocated attendance is a review signal and never an automatic deduction. |
| Uploads | Phase 3 default allowlist: PDF, PNG, JPEG, WebP; maximum 10 MiB per file. Validate actual content/signature, filename, size, and authorization. Store privately and quarantine until validated. HTML, SVG, scripts, and executables are not accepted by default. |

## Payroll policies for later phases

| Policy | Proposed default |
| --- | --- |
| Weekly cutoff | Monday 00:00 through the following Monday 00:00, Asia/Manila; end is exclusive. Configurable before period creation; cannot redefine a finalized period. |
| Pay basis | DAILY or HOURLY per effective rate record; no default amount and no invented salary. |
| Base earnings | Use approved attendance only. Hourly amounts use approved payable seconds / 3600 × effective hourly rate. A daily arrangement must select an explicit partial-day rule and expected hours; payroll approval remains blocked until the owner validates its pay policy. |
| Daily partial days | UNCONFIGURED, approval blocked until owner/accountant selects prorated or another supported treatment. Do not silently pick a full-day or zero-pay outcome. |
| Wage/time rounding | Preserve recorded time to the second; no rounding of attendance before review. Monetary rounding defaults to decimal half-up at each finalized earning/deduction item to PHP 0.01, then sum items. Configurable and snapshot the selected rule; it is not asserted to be a legal requirement. |
| Effective-rate boundaries | Split payable allocations at the applicable Manila effective-date and cutoff boundaries; use the rate valid for each portion. Do not apply today's rate retroactively. |
| Holidays/rest days | Calendar and treatment UNCONFIGURED; flag affected payroll for review. No inferred premium or automatic zero/full-day treatment. |
| Overtime | Requires administrator authorization and an owner/accountant-configured rule. Flag excess hours; do not silently include an invented multiplier or discard recorded hours. |
| Statutory deductions | Empty configurable deduction catalog; no statutory rates or amounts. Real payroll approval stays blocked until the accountant records the applicable treatment, including an explicit not-applicable decision where justified. |
| Bonuses/allowances/other deductions | Explicit administrator-entered, itemized, reasoned adjustments under approved configuration. No automatic unsupported deduction. |
| Unresolved time | Missing punches, disputed corrections, unsupported overnight/holiday/OT treatment, or missing rates block payroll approval until reviewed. |
| Approved versus paid | Approval freezes the financial snapshot; payment is a separate, audited step with actual date, method, and reference. One recorded full payment per employee payroll line initially. Partial/multiple payments require a later explicit policy and schema/workflow extension. |
| Zero/negative net | Block automatic payment recording and require an explicit accountant-reviewed settlement policy. Do not manufacture a positive payment or clamp negative net. |
| Historical corrections | Preserve original approved financial content and PDF; create an audited corrective version or adjustment. Never silently recalculate a paid payslip from current settings. |

## Owner/accountant decisions still needed

- Actual staff identifiers, rates, expected hours, workdays, schedules, and effective dates.
- Whether to enable PIN, the desired security timeout/lockout values, and identity-verification procedures.
- Whether overnight work and multiple same-date shifts are permitted, and when duty is considered completed.
- Worker classifications, daily partial-day treatment, breaks, holidays, overtime, deduction applicability, pay cutoff, and rounding approval.
- Actual logo/contact details for payslips, payment methods, payroll reviewers, privacy/retention rules, backup destinations, and deployment host.

These decisions do not block Phase 1 construction. Unconfigured financial policies block later payroll approval rather than producing an invented payment result.
