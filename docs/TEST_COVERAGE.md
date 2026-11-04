# Acceptance coverage — checkpoint 4a

Date: 4 November 2026, Asia/Manila. Checkpoints through 3b are owner-accepted. Checkpoint 4a adds attendance clocks, breaks, corrections and review. Checkpoint 4b requires separate acceptance.

## Section 15 status

| Blueprint scenario                                             | Executed evidence                                                                                                                                                                                            | Status and remaining work                                                                                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 15.1 Activated A, unactivated B                                | Actual staged DUTY login and Clock In for A. B and ACCOUNT denied. Restricted role and page/API guards remain covered.                                                                                       | **Passed**, including Clock In.                                                                                                                      |
| 15.2 Failed factors and recovery                               | Persistent password/PIN/TOTP lockouts, challenge binding/replay, encrypted enrollment, single-use recovery, setup-only replacement and audited resets.                                                       | **Passed**. Accepted Phase 2 evidence retained.                                                                                                      |
| 15.3 Revocation during active work                             | Committed revoke denies next HTTP/direct query. Revoke and Clock In serialize. Open shift and break close at the trusted instant with flags and original evidence. Regrant cannot revive stale tokens.       | **Passed for duty and attendance**. Timer closure remains 4b.                                                                                        |
| 15.4 Shared task to three employees                            | Three distinct contributions, private submissions/reviews and one counted shared task.                                                                                                                       | **Passed for Phase 3 contribution/review/counting**. Separate timer histories remain 4b.                                                             |
| 15.5 Pause, switch, return another day                         | Attendance and break exclusions are enforced.                                                                                                                                                                | **Deferred to 4b** for task segment sums and overlap.                                                                                                |
| 15.6 Clock Out with running task                               | Clock Out ends an open break at the same trusted timestamp and audits before/after.                                                                                                                          | **Passed for attendance closure only**. Running and paused timer closure and audit remain 4b.                                                        |
| 15.7 Attendance 8h and task 6h                                 | Gross attendance, actual paid/unpaid breaks and explicit approved seconds are independent. Overages flag review.                                                                                             | **Partial**. Joint totals and the 2h review signal remain 4b. No attendance/task gap deduction exists.                                               |
| 15.8 Distinct rates and frozen pay                             | Exact effective-dated rates and access isolation still pass.                                                                                                                                                 | **Deferred to Phase 5** for computation and frozen snapshots.                                                                                        |
| 15.9 Missed punch and recalculation                            | AMEND_SHIFT and ADD_MISSING_SHIFT preserve actuals, proposed values, decisions and before/after. Approved corrections clear earlier attendance approval. Stale and overlapping claims cannot overwrite time. | **Passed for 4a attendance correction and review**. Draft payroll recalculation and finalized adjustments remain Phase 5.                            |
| 15.10 Own finalized PDF only                                   | Private project/task files retain their separate authorization coverage.                                                                                                                                     | **Deferred to Phase 5** for payslips.                                                                                                                |
| 15.11 Approved versus Paid                                     | Attendance approval remains an explicit record of seconds.                                                                                                                                                   | **Deferred to Phase 5** for payroll approval and payment.                                                                                            |
| 15.12 Overnight, cutoff, missing punches, MFA, uploads, mobile | Exact Manila rollover and original duty date, 8h carry ceiling, 12h reauthentication, 16h boundary, exact valid_until reconciliation, no implicit grant. Existing cutoff, MFA and upload tests retained.     | **Passed for duty, attendance, cutoff units and upload security**. Multi-day timer allocation, reports and wider device/release testing remain 4b/6. |

Revision decisions and immutable resubmission remain covered under Phase 3. Timed revision work remains 4b. The previous 15.6 and 15.7 labels have been corrected to match the blueprint.

## Executed automated inventory

| File                                  |   Tests |
| ------------------------------------- | ------: |
| tests/checkpoint/rls.test.ts          |       5 |
| tests/integration/foundation.test.ts  |      18 |
| tests/integration/mfa.test.ts         |      13 |
| tests/integration/duty.test.ts        |       8 |
| tests/integration/work.test.ts        |      19 |
| tests/integration/submissions.test.ts |       8 |
| tests/integration/uploads.test.ts     |      11 |
| tests/unit/mfa.test.ts                |       6 |
| tests/unit/money-time.test.ts         |       4 |
| tests/unit/work.test.ts               |       2 |
| tests/unit/uploads.test.ts            |       2 |
| tests/e2e/http.test.ts                |       4 |
| tests/e2e/mfa-http.test.ts            |       5 |
| tests/e2e/duty-http.test.ts           |      10 |
| tests/e2e/work-http.test.ts           |      12 |
| tests/e2e/submissions-http.test.ts    |      16 |
| tests/integration/attendance.test.ts  |      12 |
| tests/unit/attendance.test.ts         |       3 |
| tests/e2e/attendance-http.test.ts     |      10 |
| **Total**                             | **168** |

Final verification passed 111 unit/database and 57 actual HTTP tests, with zero failures or skips. The suite retains 143 accepted cases and adds 25 (12 database integration, 3 unit, 10 actual HTTP). See PHASE_4A_REPORT.md for the local walkthrough and build checks. Repeated runs and assertions within a test are counted once.

All database tests use real local PostgreSQL, with restricted non-owner NOBYPASS runtime/auth roles where applicable. HTTP tests use the actual Next server pointed at the dedicated test database. Clock/key/policy fixtures are sequential and restore state in finally. Owner fixtures replace only the dedicated test database's trusted server clock; there is no request-controlled clock. Lock races observe actual blocked PostgreSQL requests before release.

## Retained 3a evidence

All assignment modes, recipient capacity 500 and atomic invalid-recipient rollback; ALL_ACTIVE captured eligibility/retry snapshot and concurrent/late hire exclusion; SHARED only; explicit membership withdrawal/restoration; one task denominator; zero-work non-completion; current administrator MFA and employee DUTY only; independent ACCOUNT expiry; conflicting-cookie identities; same-project A/B isolation via DAL, API, SSR/RSC, search/counts and direct SQL; no directory/rate/audit access under DUTY; immutable comments/safe text/URLs and no automatic remote fetching.

Actor/server timestamp/audit, optimistic versions, retries, reasoned cancel/restore, non-ACTIVE read-only messages and writes, revoke-first progress and withdrawal-first comment races, administrator expiry after lock waits, pooled-context default denial, and per-assignment New/Updated observed-version indicators remain green. No notification service is claimed. Review-only states now require real submission/review proofs; accepted 3a shortcut-rejection tests still pass.

## New 3b evidence

- Three required private contributions approve independently before the shared task approves once. Non-empty all-approved work is necessary for project COMPLETED. Approved content, decisions and required approved contributions survive access withdrawal/restoration; terminal task/assignment approval cannot be undone or brief rewritten.
- Draft creation retries/single-draft constraint, optimistic edit, empty-content rejection, atomic submit of notes/URLs/AVAILABLE non-excluded links, concurrent submit/edit and review decisions, new revisions and old-content immutability. The current pointer has a real composite FK to the same assignment. Private review reasons never enter shared task history. Only current submitted revisions enter the administrator queue.
- RLS on all six new tables; own-submission/review/file privacy even within one shared task; ACCOUNT/SETUP denial; exact project/task/submission file scope; indistinguishable missing/foreign IDs/headers; no owner relinking/foreign attachment; auth role denied. Runtime cannot directly alter file states/owners, read table storage keys, replace the server validation verifier or mint AVAILABLE objects without server-held proof.
- Positive PDF, PNG, JPEG and WebP files, including ordinary text and JPEG-image PDFs, pass full structural validation/decode and original-byte download. Attachment disposition, UTF-8 safe names, nosniff/private no-store, no public paths, authorized HEAD 405/range 416 and foreign/missing 404 pass. Conditional requests cannot expose bytes without live permission. Disk size/hash corruption fails closed before headers.
- Wrong MIME, unsupported types, spoofed/double extensions, signature-only/truncated/malformed bodies, active PDF structure and compressed streams exceeding the decode limit, appended polyglots, empty/oversized/exact 10 MiB bodies, chunked/missing/false Content-Length and actual-size mismatch; parser timeout/image dimensions/pixels/PDF page limits fail safely.
- POSIX/Windows/encoded traversal, absolute/UNC names, NTFS alternate streams, reserved names, invalid Windows/control/CRLF/NUL/bidi characters and normalization; random-key collision and symlink/junction/hard-link confinement. Display names never determine storage paths.
- Persistent upload/download attempt caps, 10-file draft cap, uploader/Manila-day/project/app reservations, rejected/quarantined accounting and two simultaneous request-bound validations. A third request fails without a queue/lease. Current validated WORK policy/type changes require recent MFA, expected ID and reason; unrelated settings survive.
- Real paused HTTP uploads versus withdrawal/restoration, duty revoke and policy switch; unfinished files never publish and history/failed metadata persists. Submit during quarantine rolls back edited content too. Real HTTP submit waiting behind withdrawal or duty revoke fails and direct runtime visibility disappears. Review waiting behind withdrawal cannot approve excluded work. Stale old review concurrent with resubmission cannot change an old decision.
- Revocation during an 8 MiB authorized download aborts remaining bytes; next request fails. Withdrawal/restoration also cannot revive the old stream because its membership stamp changes; a fresh explicitly authorized request can read retained historical bytes. Previously delivered bytes cannot be recalled.
- Manual operator cleanup removes only old failed bytes, reconciles a recognized interrupted hard-link promotion, frees recorded quota only after removal, and retains metadata/links/audit/AVAILABLE content. No automatic successful-file deletion or restore rehearsal is claimed.

## New 4a evidence

- Exactly three new attendance tables. RLS and the restricted runtime enforce own-DUTY or administrator reads. Foreign and missing identifiers produce the same 404. ACCOUNT and the auth role cannot read attendance. Direct runtime mutations fail. All clock and review writes go through guarded functions.
- Authentication creates no attendance. Explicit punches use the trusted server clock and disregard client time/counter fields. Operation keys and canonical fingerprints protect retries. GiST exclusions and partial unique indexes enforce non-overlap and one open shift/break. Adjacent shifts under the same grant are valid. Same-instant evidence is retained and flagged.
- Default MEAL is unpaid and SHORT is paid. Work policy and schedule are snapshotted. Exact break durations survive policy changes. Overages flag review without clipping. SUGGESTED remains separate from approved seconds. Overrides need reason and are bounded by effective gross. Recent MFA and acknowledgement apply to individual exceptions. Clean bulk preview/approval rechecks the complete versioned set and rolls back a stale batch.
- Real PostgreSQL and HTTP races cover double Clock In, revoke versus Clock In, Clock Out versus break and correction versus punch. Held user-row locks verify actual contention where ordered outcomes are required. Per-employee locks sufficed. Account disable closes time and stale DUTY cannot return. New authorized sessions may read retained own history.
- AMEND and ADD_MISSING_SHIFT preserve original punches, proposal, review reason and before/after audit. Overlap and outside-window approval fail. Rejection leaves time unchanged. Correction approval clears payable approval. A retry of an earlier bulk approval cannot reapply approval to corrected time.
- Session expiry alone leaves a valid shift open. Same-grant reauthentication crosses Manila midnight without changing duty date. A different grant cannot strand an open shift. At 16 hours no long-shift flag is added. A fraction above 16 hours flags review without truncation. Reconciliation materializes the original grant boundary after downtime.

## Release checks and boundaries

Clean replay: **43 migrations, exactly 30 RLS-enabled application tables**. Task timers, report tables and payroll remain later checkpoints. Separate TypeScript check, Prisma generation, webpack production build and production dependency advisory audit pass. No known production dependency vulnerabilities were reported at execution time; this is not an enduring guarantee.

Private bytes and database must be backed up consistently; the MFA keyring remains separately backed up. README contains exact PowerShell commands, test-server environment, the one-Next-server-per-folder limitation, upload key binding/rotation and manual cleanup. Hosting remains local only; host ACL provisioning, real-phone/broader browser testing, owner walkthrough and production backup/restore rehearsal remain release work.
