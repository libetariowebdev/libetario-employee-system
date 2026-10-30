# Phase 2 plan — Duty security

Status: **APPROVED with owner amendments below. Implement checkpoint 2a only, then stop for approval.** Prepared 30 October 2026, Asia/Manila.

## Approved checkpoint split and superseding decisions

The owner's latest approval supersedes any conflicting original proposal below.

- **2a now:** environment keyring; mfa_enrollments, employee_pins and recovery_codes (three new tables; 15 application tables total); credential_resets/session/security-policy changes; mandatory administrator TOTP, enrollment, PIN management, recovery codes, self-service recovery enrollment, assisted authenticator reset, guarded operator recovery CLI and second-admin seed instructions. Staged administrator authentication uses short-lived, bound SETUP sessions; auth_challenges is not migrated yet. No duty capability is introduced. Deliver PHASE_2A_REPORT.md and wait.
- **2b after approval:** duty_authorizations and auth_challenges (17 application tables total), duty login/sessions/reauthentication, bulk activation, overnight behavior and duty screens. Do not start Phase 3.
- DUTY policy defaults are idle **30 minutes**, absolute until the grant's valid_until with a **12-hour maximum per session**. Same-grant reauthentication uses current TOTP plus PIN if enabled, without repeating the password flow. ACCOUNT stays 15-minute idle/60-minute absolute. In 2a, implement/test policy validation and expiry calculation only; actual DUTY/HTTP behavior is gated to 2b.
- Password + single-use recovery code immediately revokes the old authenticator and codes, increments account authorization_version, revokes every old session and issues enrollment-only SETUP. The user may enroll a new generation themselves; no administrator approval is required for this path. Administrator/full account privileges are issued only after the new authenticator is confirmed. Assisted reset remains for loss of both authenticator and codes.
- Provide a script using server access and migration credentials only, with an exact typed confirmation prompt and mandatory verification note/reason, to reset an administrator authenticator. It refuses production/non-local targets unless --allow-production is explicitly supplied. No request handler imports or exposes operator code. The audit identifies the operator rather than impersonating the affected administrator.
- Document separately backed-up MFA encryption keyrings, recovery after complete key loss, rotation retaining old keys until all retained ciphertext is handled, and second administrator provisioning. Losing every usable key requires every affected user to re-enroll; there is no decryption fallback.

These amendments replace the original RECOVERY_REQUIRED suspension/assistance-only recovery path and the original DUTY 15/60 session limits. Recovery uses SETUP, not a privileged recovery scope. Historical detailed sections below remain the original design reference where consistent with this addendum.

Phase 1 is owner-verified and accepted. Source: BLUEPRINT.md Sections 5, 14 and 15, the accepted Phase 1 foundation, and the owner's Phase 2 decisions. At original plan preparation no Phase 2 code or database changes had been made. The approved 2a implementation and verification are now recorded in PHASE_2A_REPORT.md; 2b remains gated on separate approval.

## Scope and explicit extension

Implement daily duty authorization, activation/revocation/bulk activation, password → optional employee PIN → TOTP authentication, encrypted authenticator enrollment, replay protection, recovery codes, administrator-assisted authenticator reset, security event views and the corresponding administrator/employee screens.

**Owner-authorized extension beyond the blueprint:** every administrator must complete TOTP before obtaining administrator account privileges. This is mandatory, including direct API/DAL/database access; a password-only administrator cannot manage staff, rates, duty or settings. Initial enrollment and recovery have restricted scopes, not temporary administrator privileges.

Employee PIN is implemented fully but defaults to **DISABLED in the versioned SECURITY policy**. The historical WORK.pinEnabled reference from Phase 1 will not remain a second source of truth. Employee duty TOTP and administrator TOTP cannot be disabled through settings.

Hosting remains local only. No Phase 3 projects/tasks/uploads, Phase 4 shifts/timers/clock-in, or Phase 5 payroll/PDF tables or workflows are included. Authentication never creates paid time.

## Database changes: five new tables

Use UUID primary keys, timestamptz instants, date-only Manila duty dates, real foreign keys with RESTRICT deletes, supporting FK indexes and append-only redacted security/audit events. All new tables have RLS enabled and least-privilege grants. The final Phase 2 schema will have **17 application tables**, excluding Prisma's migration bookkeeping.

| New table | Proposed columns and constraints |
| --- | --- |
| `duty_authorizations` | `id`, `employee_id` FK employee_profiles.user_id, `duty_date`, `status` ACTIVATED/REVOKED/COMPLETED, `granted_by` FK users.id, `granted_at`, `revoked_by?` FK users.id, `revoked_at?`, `reason?`, `valid_from`, `valid_until`, `overnight_allowed`, `work_policy_id` FK policy_versions.id, `authorization_version` positive integer, `first_authenticated_at?`, `first_auth_version?`, timestamps and optimistic `version`. UQ(employee_id,duty_date); UQ(id,employee_id). CHECK positive validity interval, coherent revocation fields, and coherent first-authentication fields. An administrative function validates the employee is active, the actor is an MFA-authenticated administrator, the window matches its Manila duty date/policy, and any overnight extension is explicitly permitted. `first_authenticated_at` is security metadata, not attendance or payable time. COMPLETED is reserved for the later duty-completion/clock workflow, not exposed as a working Phase 2 clock action. |
| `mfa_enrollments` | `id`, `user_id` FK users.id, `generation` positive integer, `state` PENDING/CONFIRMED/RECOVERY_REQUIRED/REVOKED/EXPIRED, `ciphertext? bytea`, `nonce? bytea`, `tag? bytea`, `encryption_key_id?`, `encryption_format_version`, `algorithm` CHECK SHA1, `digits` CHECK 6, `period_seconds` CHECK 30, `pending_expires_at?`, `confirmed_at?`, `last_accepted_step? bigint` CHECK >= 0 when present, `recovery_batch_version`, `reset_id?` FK credential_resets.id, `revoked_at?`, timestamps/version. UQ(user_id,generation), UQ(id,user_id), partial UQ(user_id) for PENDING/CONFIRMED/RECOVERY_REQUIRED states. Current records require an encrypted payload, 12-byte nonce and 16-byte tag; state/timestamp checks prevent unconfirmed or recovery-suspended enrollment from satisfying MFA. Retain historical enrollment metadata; revoke/expire old generations and remove their active secret payload rather than deleting history. Reset/enrollment ownership is enforced by a composite FK. |
| `employee_pins` | `user_id` PK/FK employee_profiles.user_id, `pin_hash`, `changed_at`, positive `version`. Employee-only, exactly six ASCII digits at input, Argon2id at rest using the existing password-hash cost parameters. Never expose the hash, even to the employee or an administrator. Ownership cannot be reassigned through the API. |
| `auth_challenges` | `id`, `user_id` FK users.id, `bound_session_id`, `challenge_token_hash` UQ, `purpose` DUTY_LOGIN/ADMIN_LOGIN/MFA_ENROLLMENT/RECOVERY_LOGIN/PIN_CHANGE, `stage`, `requested_scope`, `duty_id?`, `duty_authorization_version?`, `enrollment_id?`, `enrollment_generation?`, `pin_version?`, `security_policy_id` FK policy_versions.id, `user_authorization_version`, `password_verified_at`, `pin_verified_at?`, `created_at`, `expires_at`, `consumed_at?`, `invalidated_at?`, `failed_attempts`, optimistic `version`. Composite FKs bind session, duty and enrollment to the same user. CHECK coherent purpose/stage/scope, positive lifetime, and mandatory duty fields only for DUTY_LOGIN. Tokens rotate after each successful stage without extending the original deadline; a completed or replaced token cannot be used again. |
| `recovery_codes` | Random `id` lookup UUID, `enrollment_id` FK mfa_enrollments.id, `batch_version`, `code_hash`, `created_at`, `consumed_at?`, `revoked_at?`. Ten independent high-entropy secret portions per batch, each Argon2id-hashed with its own salt. The lookup ID is not the secret. A conditional update plus row locking permits one successful use only. Old batches are revoked when regenerated or the enrollment is reset. |

The one-current-enrollment partial unique index is a deliberate refinement of the original design's global UQ(user_id): it prevents two active enrollments while retaining reset history. Security payloads will not use Phase 1's general row-to-JSON audit trigger; new triggers/functions whitelist non-secret metadata and reasons.

## Changes to existing tables and security functions

| Existing object | Phase 2 change |
| --- | --- |
| `sessions` | Extend scopes to ACCOUNT/DUTY/SETUP/RECOVERY. Add `duty_id?`, `duty_authorization_version?`, `mfa_enrollment_id?`, `mfa_verified_at?`, `password_verified_at?`, `pin_version?`, `security_policy_id?`, and a restricted setup purpose when applicable. Keep the existing `authorization_version` as the snapshot of users.authorization_version. Add UQ(id,user_id), a composite duty/employee FK, and a composite MFA-enrollment/user FK. CHECK DUTY requires a duty link and completed MFA; other scopes have no duty link. Trigger validation requires MFA for ADMINISTRATOR + ACCOUNT, and rejects privileged or DUTY claims on SETUP/RECOVERY sessions. |
| `credential_resets` | Add AUTHENTICATOR to the existing PASSWORD kind, `reason?`, `target_enrollment_id?`, and UQ(id,user_id) for ownership links. Composite FK(target_enrollment_id,user_id) references mfa_enrollments(id,user_id). AUTHENTICATOR requires a separate 10–500-character verification note and a 10–500-character reason, a target enrollment and a hashed one-time token. Preserve old password-reset records. Authenticator reset must be issued by a different, enabled administrator with recent TOTP; there is no password-only self-reset endpoint. |
| `policy_versions` / `company_settings` | Append a new SECURITY version carrying PIN, challenge, MFA/recovery lockout, recovery/session and sensitive-reauth settings; retain existing versions. Mandatory admin/duty TOTP is an invariant. Expose the existing WORK.overnightEnabled setting through a narrowly validated, audited settings action; preserve other work/pay fields. No payroll-policy implementation is added. |
| `security_throttles` | Reuse existing persisted counters for PIN, TOTP, recovery, enrollment confirmation and challenge abuse, with distinct account/network/challenge keys. New challenges do not reset account/network lockouts. Invalid foreign-user challenge requests must not increment the victim's account counter. |
| `auth_events` / `audit_log` | Reuse existing append-only tables for grants/revokes/regrants, factor success/failure/lockout, enrollment/confirmation/expiry, recovery consumption, reset issuance/completion, scope changes and session invalidation. Record actor, target IDs, duty date, reason, outcome and server timestamp. Never include secrets, QR/URI data, submitted codes, raw bearer/reset/challenge tokens, PINs or hashes. |
| Database identity helpers | Keep legacy function signatures where dependencies require them; introduce a minimal session-context helper. Ordinary `private.identity`, `private.is_admin` and `private.can_read` must reject SETUP/RECOVERY privileges. `is_admin` also requires a valid confirmed MFA enrollment. Add a duty guard that verifies scope, account version, duty version/state/window, MFA generation, policy requirements and account status on every request/query. Never trust client role, scope, user ID or duty date claims. |

The additive migration invalidates all pre-Phase-2 sessions and pending credential capabilities as appropriate; it never backfills an administrator as MFA-verified. Both seeded and existing administrators must complete first enrollment. Password reset continues to revoke sessions but does not remove an existing authenticator or bypass administrator MFA.

### Revocation versioning

- `users.authorization_version` remains the account-wide invalidation counter for disabling, password changes/resets and authenticator reset/recovery. Incrementing it invalidates every scope for that account.
- Add **duty_authorizations.authorization_version** as the duty-specific counter. A DUTY session snapshots it in `duty_authorization_version`. Revoke locks the relevant records, increments this counter, marks the grant REVOKED, invalidates associated challenges, revokes bound DUTY sessions and writes the audit event in one transaction.
- This satisfies version-based duty invalidation while allowing an otherwise valid employee ACCOUNT session to retain permitted off-duty profile/rate access. Revoking tomorrow's grant does not unnecessarily log out today's unrelated account session. Regrant increments the duty counter again; no old challenge/session can revive.
- Check the persisted grant on each request/DAL operation even if the cookie has not expired. A committed revoke must deny the next request. No data is deleted and no synthetic attendance closing event is invented in Phase 2.

## Authentication flows (text diagrams)

### Employee account and duty access

```text
Username/email + password
    |
    +-- wrong/disabled/locked --------------------------> generic failure
    |
    +-- temporary password ----------------------------> password-change-only setup
    |                                                     then fresh sign-in
    |
    +-- ACCOUNT session -------------------------------> own profile/rates/duty status
    |                                                     no duty tools
    |
    +-- request duty access (fresh password proof)
           |
           +-- own ACTIVATED grant + valid server window?
           |       no ---------------------------------> generic failure
           |
           +-- enrolled, confirmed authenticator?
           |       no ---------------------------------> enrollment; no DUTY session
           |
           +-- server-bound DUTY_LOGIN challenge (5 min total)
                   |
                   +-- PIN enabled? -- yes --> verify own PIN --> rotate challenge
                   |                    missing/wrong/locked --> generic failure
                   |                  no --> omit PIN stage
                   |
                   +-- verify current TOTP
                           |
                           +-- bad/reused/expired/foreign challenge --> generic failure
                           |
                           +-- locked transaction rechecks all facts
                                   consume challenge + advance accepted TOTP step
                                   rotate/revoke the binding session
                                   issue DUTY session linked to exact duty/grant version
                                   audit success; record no paid time
```

An existing account session supplies the binding context, not a substitute for fresh password proof. A direct duty sign-in may establish a least-privileged account context from the successfully verified password, so the user need not perform two separate password logins. The same binding rule applies either way. A caller cannot change user/date/purpose on a challenge.

### Administrator sign-in and initial enrollment

```text
Password verified
    |
    +-- must change temporary password --> SETUP: password change/logout only
    |
    +-- no confirmed authenticator ------> SETUP: fresh-password enrollment only
    |                                        |
    |                                        create encrypted PENDING enrollment
    |                                        show locally generated QR once
    |                                        confirm first valid TOTP
    |                                        advance last_accepted_step
    |                                        generate/show recovery codes once
    |                                        rotate SETUP into MFA-verified ACCOUNT
    |
    +-- confirmed authenticator ----------> SETUP context + ADMIN_LOGIN challenge
                                             |
                                             valid TOTP + atomic single consumption
                                             rotate into MFA-verified ACCOUNT
                                             administrator privileges now available
```

SETUP cannot list employees, see their compensation, grant duty, change policy or reset another user. Enrollment confirmation and session issuance form one successful proof, not two acceptances of the same code. Another login/duty attempt must use a subsequent valid time step.

### Recovery and administrator-assisted reset

```text
Password + single-use recovery code (and PIN if a duty challenge requires it)
    |
    +-- atomic code consumption + account-wide session/challenge invalidation
    +-- suspend old authenticator as RECOVERY_REQUIRED (cannot satisfy TOTP login)
    +-- RECOVERY session only (5 min; no administrator or duty privileges)
            |
            +-- user requests assistance from a different MFA-authenticated admin
                    |
                    admin verifies identity outside the app
                    records mandatory verification note AND reason
                    performs recent-TOTP step-up when required
                    issues hashed, user-bound reset token (15 min default)
                    revokes old enrollment/codes/sessions/challenges immediately
                    preserves account, duty and historical records
                    displays token once for private delivery
                            |
                            user proves password + issued reset token
                            atomically consumes token -> enrollment-only SETUP
                            confirms new TOTP -> fresh enrollment generation/codes
                            fresh normal sign-in / duty checks required
```

The normal administrator-assisted reset is also available after identity verification if all recovery codes are lost; a recovery code is not required to obtain human assistance. Password + recovery code suspends the old factor but does not approve a replacement or yield DUTY/full administrator scope. The suspension persists beyond the five-minute recovery session; no timeout silently re-enables the lost factor. Historical confirmed enrollment prevents password-only re-onboarding. Password + reset token alone never grants privileged scope. Reset completion does not count the old authenticator as a new factor. With only one administrator and its authenticator lost, normal web recovery cannot approve itself; recovery requires another MFA-enabled administrator or a separately approved owner/DBA recovery procedure. No emergency bypass is silently added in this phase.

## Factor protection and transaction rules

- Use a standards-based TOTP library (proposed OTPAuth; exact supported version reviewed/pinned during implementation), local QR rendering, Node crypto authenticated encryption and existing Argon2id hashing. No custom OTP algorithm or third-party QR service.
- Proposed TOTP profile: HMAC-SHA1, six digits, 30-second step, ±1 step. The accepted counter must strictly exceed `last_accepted_step`. Check allowed candidates without exposing comparison timing, reject reuse across enrollment/login/reauth purposes, and update the counter under a row lock/conditional update. Concurrent submissions or different challenges using one step produce at most one success. [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238.html) supplies the algorithm, validation/replay requirements and test vectors; [OTPAuth](https://github.com/hectorm/otpauth) is the proposed library.
- Generate a distinct 256-bit TOTP secret for each enrollment with a cryptographically secure server generator. Encrypt pending and confirmed secrets with AES-256-GCM, a random 12-byte nonce and 16-byte tag. Bind ciphertext to a canonical AAD structure containing the user, enrollment generation/ID, format/key ID and TOTP parameters. Cross-user ciphertext swaps, changed AAD/tag and unknown keys fail closed. Use Node's [authenticated encryption APIs](https://nodejs.org/docs/latest-v24.x/api/crypto.html).
- Keep a separate environment-managed MFA keyring and active key ID; never reuse SESSION_SECRET as an encryption key. Local initialization creates missing development keys once without printing/overwriting them. Missing keys fail closed, rather than silently replacing keys. Preserve old key IDs for planned rotation; document rotation/backup requirements.
- QR/otpauth URI/plaintext secret and raw recovery codes are returned once in a no-store response to the authorized owner, retained only in browser/server memory, and never written into SSR/RSC payloads, URLs, files, localStorage, sessionStorage, app logs, audit events, telemetry or QA screenshots. Reloading requires explicitly replacing an unconfirmed pending enrollment. Confirmed enrollment cannot be redisplayed or replaced without the controlled reset workflow.
- New PIN, changed/forgotten PIN and recovery-code regeneration require fresh password + TOTP proof. Employee PIN setup remains available while PIN duty enforcement is off. Changing PIN invalidates affected DUTY sessions/challenges; administrators cannot see or choose a user's existing PIN.
- Preserve the five-minute absolute challenge deadline through PIN/TOTP stages. Bind each to its originating session, user, purpose, requested scope, authorization versions, policy and enrollment generation. Each successful transition rotates tokens and session-bound CSRF material; complete only once. Rate-limit failures before expensive hashing/decryption and keep failure counters committed on rejection.
- Use consistent lock ordering across duty mutation, MFA verification and reset. Final issuance rechecks account enablement/version, bound session, grant/window/version, required PIN/version, current policy, challenge expiry and enrollment state. Challenge consumption, TOTP/recovery consumption, scope/session changes and redacted audit events commit together. A grant revoked while verification is in progress cannot leave a usable session after revocation commits.
- Changing SECURITY policy invalidates incomplete challenges and existing DUTY sessions so switching PIN on cannot leave password/TOTP-only duty sessions active. Mandatory administrator/duty TOTP stays enabled. Existing approved work-window snapshots change only through an explicit grant mutation/revocation, not a silent work-policy edit.
- Security-policy updates require the expected current policy ID and explicit validated changes. Omitted factor flags retain their current value; migration/bootstrap defaults must not silently turn PIN off when an old client saves unrelated settings. Conflicting/stale updates fail instead of overwriting newer policy decisions.

## RLS and database-role plan

| Table/boundary | Runtime access |
| --- | --- |
| Duty authorizations | Employee SELECT of own permitted status/authorization metadata; MFA-authenticated administrator SELECT of workforce duty records. Grant/revoke/regrant/bulk mutations use narrowly granted, fixed-search-path functions that derive the administrator from the database session. No caller-selected actor or direct runtime UPDATE of authorization versions. |
| MFA enrollments | Safe own metadata and authorized administrator reset-status metadata only. SETUP/RECOVERY reads use a purpose-limited context function. No runtime read of ciphertext/nonce/tag/secret; no direct enrollment/replay-counter UPDATE. |
| PINs | No runtime hash access. Safe own configured/changed metadata through controlled functions; no other employee's PIN metadata. |
| Challenges | No arbitrary runtime token/hash/row access. Controlled endpoints expose only the current bound challenge stage/status. The separate authentication authority performs verification and consumption. |
| Recovery codes | No runtime hash/code-row access. Own remaining-code count and regeneration through purpose-limited functions. No administrator display/download of another user's codes. |
| Existing employee/rate/schedule/settings/admin boundaries | Retain Phase 1 employee ownership tests; tighten administrator checks to require MFA. SETUP/RECOVERY never gain normal table privileges. |

The authentication authority remains a distinct non-owner, non-superuser, NOBYPASSRLS role with only the authentication operations it needs. It gains no general employee-rate/schedule access. Verify role ownership, table/column grants, inability to SET ROLE, new RLS policies, helper-function execution grants and pooled-context isolation in direct SQL tests. No migration/owner credentials enter request handlers.

## Duty-date and overnight behavior

- Default non-overnight grant: start at the authorized duty date's Manila midnight; end at the following Manila midnight, exclusive. Grant time and login time still come from the server; this window creates no attendance.
- Overnight remains disabled by default. It requires the versioned WORK policy to permit it and an explicit overnight grant with a bounded `valid_until`. Proposed configurable default carry limit is **eight hours past midnight**; this is an authentication window, not a shift duration or payroll cutoff.
- New duty work starts on the authorized date. A duty session authenticated before midnight may continue past midnight, and reauthenticate after ordinary session expiry, against the **same grant/duty date/version** while the explicit overnight window remains valid. Record first authentication against its grant version to distinguish continuation from a new backdated start.
- Do not substitute the new calendar date into an overnight session or auto-grant the next date. Next-day work outside the permitted continuation window requires new authorization. Regrant cannot revive an old capability or silently authorize a new backdated start.
- Keep the existing 15-minute idle / 60-minute absolute session limits, capped by duty.valid_until. Midnight itself does not revoke a valid overnight session. Session expiry never creates a Clock Out or deletes time. The future 16-hour shift-review policy remains separate and unimplemented until Phase 4.

Example: authorize 30 October overnight through 31 October 07:00 Manila. A valid 23:55 duty login remains tied to 30 October at 00:05. It requires normal reauthentication when its short session expires, can still resume the same authorization before 07:00, and is denied at 07:00. It has recorded zero attendance simply by authenticating.

## UI and API delivery

- Administrator: MFA onboarding/login, duty-date selector, today's real authorization list, single activation/revocation/regrant, explicit bulk activation (maximum 100 employees per transaction), and a bounded/filterable redacted security-event log. No clocked-in/on-task or paid-time figures are fabricated.
- Employee: own current/date-selected duty status including a valid overnight carry, enrollment/confirmation, own recovery-code generation/count, PIN setup/change and staged duty sign-in. Never show a generated OTP next to its login field.
- Provide a real duty-protected context endpoint/page using the shared server/DAL duty guard. This makes ACCOUNT-versus-DUTY enforcement testable now without inventing task or clock-in functionality. Clock-in remains unavailable.
- Forms retain CSRF/origin checks, bounded bodies, no-store responses, accessible error states and responsive navigation. Default status refresh is explicit/on mutation with a last-fetched timestamp; background polling will not silently keep idle sessions alive.
- Bulk activation validates the entire active employee set and commits all-or-nothing. Existing identical ACTIVE grants are no-ops, not duplicate rows. A revoked grant requires an explicit reasoned regrant; bulk activation does not silently resurrect it.

## Test and implementation sequence after approval

1. Add environment-key initialization/configuration and only the five tables plus necessary existing-table/function changes. Test encryption, constraints, restricted grants and RLS before exposing new UI/actions.
2. Implement restricted administrator bootstrap and mandatory administrator MFA, including regression of every Phase 1 admin service/SQL guard.
3. Implement one-time enrollment/confirmation, counter-based replay rejection, hashed PIN, recovery-code batches and administrator-assisted reset.
4. Implement duty grant/revoke/bulk, version-bound staged login and overnight-aware scope checks; build the role-specific screens and security log.
5. Run the full Phase 1 regression suite with genuinely MFA-capable administrator fixtures, plus new unit/integration/real HTTP tests, migration replay, type checking, production build and dependency audit. Review desktop/mobile UI without capturing secrets.
6. Update TEST_COVERAGE.md from actual evidence, produce PHASE_2_REPORT.md in the Phase 1 format with exact counts/exit codes, known gaps, local run steps and owner decisions, and stop. Do not start Phase 3.

Required test matrix:

| Area | Evidence required |
| --- | --- |
| Blueprint 15.1 | A activated/B not; A completes password/PIN-policy/TOTP duty login and reaches the real duty-context guard; B is denied. An ACCOUNT cookie cannot reach that guard. Clock-in itself is deferred to Phase 4. |
| Blueprint 15.2 | Wrong password/PIN/TOTP fail generically; PIN-off and PIN-on/missing-PIN paths; persistent account/network/challenge lockout and expiry; enrollment confirmation; recovery code single use/concurrency/regeneration; note/reason/recent-MFA reset requirements; expired/replayed reset tokens; old secret/codes/sessions invalidated; password reset cannot bypass administrator TOTP. |
| Replay/tampering | Same TOTP step across purposes, sessions and concurrent challenges succeeds at most once. Reject expired/consumed/replaced challenge tokens, skipped/reordered stages, altered purpose/user/date, wrong binding session, different user, stale policy/duty/PIN/enrollment versions, revoked/disabled account, ciphertext/tag/AAD swaps, missing/unknown encryption key. |
| Administrator extension | Password-only old/SETUP/RECOVERY admin sessions cannot read staff/rates/settings/duty/security logs through API, SSR/DAL or direct runtime-role SQL. Initial confirmed enrollment and valid MFA login work. No self-assisted last-admin reset or password-only bypass exists. |
| Blueprint 15.3 | Revoke an active DUTY authorization; next HTTP request and direct runtime duty-guard query fail. Race revoke versus final MFA/session issuance. Regrant does not restore old tokens. Snapshot existing profile/rate/duty/enrollment/audit history and prove no deletion; preservation of actual attendance/task segments remains Phase 4 because those tables do not yet exist. |
| Overnight / 15.12 portion | Before/after Manila midnight, same date/grant retained, session idle/absolute expiry and fresh MFA continuation, non-overnight denial, explicit overnight expiry, no implicit next-date activation and no attendance creation. Deterministic clock tests use only a trusted server-clock abstraction overridden by migration-owner fixtures in a disposable test database, never a request parameter/header or production time setting. Actual HTTP calls still traverse real PostgreSQL/RLS. |
| Isolation/rollout | Own-only duty/MFA/PIN/recovery metadata; no sensitive-column or foreign-row reads through direct restricted-role queries; no SET ROLE/escalation; existing sessions invalidated on migration; Phase 1 ownership tests remain intact; exactly 17 application tables, no Phase 3+ tables. |
| Crypto and operational checks | RFC test vectors, drift beyond one step rejected, authenticated encryption/owner binding and keyring behavior, no secret-bearing audit/log/SSR/persistence artifacts, CSRF, malformed/oversized input, transactional counters, session fixation/rotation and mobile flows. |

Coverage labels after implementation must remain honest: 15.2 can be marked fully passed only after all its factor/recovery/reset cases pass. 15.1, 15.3 and 15.12 get explicitly passed Phase 2 portions plus their remaining clock/time/upload cases deferred. Scenarios 4–11 retain their existing later-phase status (including the already-passed Phase 1 rate-history portions); there are no invented payroll or time results.

## Assumptions requiring plan approval

Concrete values and overrides are in the Phase 2 section of ASSUMPTIONS.md: five-minute challenges/SETUP/RECOVERY, ±1-step TOTP window, ten recovery codes, five-failure factor lockouts, fifteen-minute reset tokens, five-minute sensitive-action reauthentication, PIN disabled, overnight disabled with an eight-hour configurable carry ceiling when enabled, and separate duty/account invalidation counters.

The owner also needs to designate a second MFA-enabled administrator or approve a separate last-administrator recovery procedure before real deployment. This plan does not silently create another administrator or add a web bypass. These proposed recovery and overnight defaults can be revised during plan approval.
