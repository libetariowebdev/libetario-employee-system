# Acceptance coverage — checkpoint 4b

Date: 4 November 2026, Asia/Manila. Checkpoints through 4a are owner-accepted. Checkpoint 4b adds task timers, segment correction, daily reports, live work and CSV. Phase 5 requires separate acceptance.

## Section 15 status

| Blueprint scenario                                             | Executed evidence                                                                                                                                                                                                            | Status and remaining work                                                                                              |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 15.1 Activated A, unactivated B                                | Actual staged DUTY login and Clock In for A. B and ACCOUNT denied. Restricted role and page/API guards remain covered.                                                                                                       | **Passed**, including Clock In.                                                                                        |
| 15.2 Failed factors and recovery                               | Persistent password/PIN/TOTP lockouts, challenge binding/replay, encrypted enrollment, single-use recovery, setup-only replacement and audited resets.                                                                       | **Passed**. Accepted Phase 2 evidence retained.                                                                        |
| 15.3 Revocation during active work                             | Both Start/revoke serialization orders observed under held employee locks. Revocation stops running or paused timers with the attendance closure and denies the old scope.                                                   | **Passed** for duty, attendance and timers.                                                                            |
| 15.4 Shared task to three employees                            | Three contributors share one task. Each records independent own segments, submissions and reviews. Timed rework binds the precise review. Peer reads are denied.                                                             | **Passed** for contribution, review and timer histories.                                                               |
| 15.5 Pause, switch, return another day                         | Pause gaps are excluded. Cross-project Switch is atomic. Another shift uses a new root. Segment exclusions prevent overlaps and exact task totals match recorded intervals.                                                  | **Passed**.                                                                                                            |
| 15.6 Clock Out with running task                               | Clock Out ends open breaks and running segments together. It also stops paused roots and rejects stale Resume. HTTP Switch/Clock Out preserves the invariant.                                                                | **Passed**.                                                                                                            |
| 15.7 Attendance 8h and task 6h                                 | The actual PostgreSQL aggregate, HTTP response, rendered report and CSV distinguish 8h gross attendance, 6h task time and a 2h review gap.                                                                                   | **Passed**. Attendance approval remains explicit.                                                                      |
| 15.8 Distinct rates and frozen pay                             | Exact effective-dated rates and access isolation still pass.                                                                                                                                                                 | **Deferred to Phase 5** for computation and frozen snapshots.                                                          |
| 15.9 Missed punch and recalculation                            | AMEND_SHIFT, ADD_MISSING_SHIFT and segment correction preserve original evidence. Reviewed combined changes commit together; a stranded or overlapping segment rolls back.                                                   | **Passed for attendance and segment corrections**. Payroll recalculation and finalized adjustments remain Phase 5.     |
| 15.10 Own finalized PDF only                                   | Private project/task files retain their separate authorization coverage.                                                                                                                                                     | **Deferred to Phase 5** for payslips.                                                                                  |
| 15.11 Approved versus Paid                                     | Attendance approval remains an explicit record of seconds.                                                                                                                                                                   | **Deferred to Phase 5** for payroll approval and payment.                                                              |
| 15.12 Overnight, cutoff, missing punches, MFA, uploads, mobile | Running and paused overnight timers retain the original duty date. Manila day, week and year splits sum exactly to the source. Reconciliation caps accrual at the saved boundary. Existing MFA/upload/cutoff tests retained. | **Passed for duty, attendance, timer rollover and upload security**. Wider device and release testing remains Phase 6. |

Revision decisions and immutable resubmission remain covered under Phase 3. Timed revision work is linked to its exact review in 4b. The previous 15.6 and 15.7 labels have been corrected to match the blueprint.

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
| tests/integration/work-time.test.ts   |      21 |
| tests/unit/work-time.test.ts          |       2 |
| tests/e2e/work-time-http.test.ts      |       7 |
| **Total**                             | **198** |

The suite retains 168 accepted cases and adds 30 (21 database integration, 2 unit and 7 HTTP). See [PHASE_4B_REPORT.md](PHASE_4B_REPORT.md) for the run totals and local verification. Repeated runs and assertions within a test are counted once.

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

## New 4b evidence

- Four additional RLS tables. Partial unique indexes, GiST exclusion, same-employee composite FKs, deferred root/shift/break checks and immutable segment adjustment evidence are enforced by PostgreSQL. Restricted-role peer queries return no records and direct writes fail. HTTP guessed identifiers for segments, reports, exports and rendered pages return 404.
- Duplicate Start/Resume, revoke in both orders, project hold racing first Start, Switch versus Clock Out, Pause/Stop versus break start, Start versus Submit and stale correction versions were exercised against the real database or HTTP server. Submit failure preserves the running timer. Restoration never restarts a timer. Client time, elapsed duration and revision claims are ignored.
- Employee daily reports enforce one date, own current or historical work, versioned drafts and frozen submitted content. Empty/future submissions, foreign assignments and excess entries fail. A meaningful issue or non-work note permits zero entries. Reported completion does not change task approval.
- Day and week grouping preserves fractional seconds and source versions. The exact 8/6/2-hour gap is tested through HTTP, HTML and CSV. The date cap is tested at 31 days and above. The 50,000-row ceiling is validated in policy, and overflow is exercised with a smaller configured row limit. CSV tests cover quoting, formula markers and a real revoked session between chunks. Live polls and exports leave idle expiry unchanged.

## Release checks and boundaries

Clean replay: **49 migrations, exactly 34 RLS-enabled application tables**. Payroll, payslips, monthly/PDF reports and notifications remain later work. Separate TypeScript check, Prisma generation, webpack production build and production dependency advisory audit pass. No known production dependency vulnerabilities were reported at execution time; this is not an enduring guarantee.

Private bytes and database must be backed up consistently; the MFA keyring remains separately backed up. README contains exact PowerShell commands, test-server environment, the one-Next-server-per-folder limitation, upload key binding/rotation and manual cleanup. Hosting remains local only; host ACL provisioning, real-phone/broader browser testing, owner walkthrough and production backup/restore rehearsal remain release work.
