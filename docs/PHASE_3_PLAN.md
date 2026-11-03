# Phase 3 plan — Projects, assignments and protected deliverables

Status: **APPROVED with owner amendments, 3 November 2026. Implement 3a only; stop before 3b.**

Prepared 30 October 2026, Asia/Manila. Sources: BLUEPRINT.md Sections 6, 12–15; accepted Phases 1, 2a and 2b; the owner's Phase 3 decisions. The current database remains at seventeen application tables and the accepted regression baseline remains 73 tests. No dependencies, code, migrations, database data, storage directories or services are changed by this plan.

## 1. Checkpoints and approval gates

| Checkpoint | Working scope after its approval | New tables | Application-table total |
| --- | --- | --- | ---: |
| 3a | Projects; shared tasks; all assignment modes; distinct employee contribution/progress records; comments; allowed status transitions; administrator management screens; employee duty-protected list/detail | projects, tasks, task_assignments, task_comments | **21** |
| 3b, only after acceptance of 3a | Immutable submitted revisions, administrator reviews, revision requests/resubmission, private uploads and authorized downloads | task_submissions, task_reviews, file_objects, project_files, task_files, submission_files | **27** |

After 3a: run checks, update TEST_COVERAGE.md, deliver PHASE_3A_REPORT.md and **stop for approval before 3b**. After 3b: deliver PHASE_3B_REPORT.md in the same format and stop. Neither checkpoint introduces Phase 4 clock-in, shifts, timers, attendance, time totals or payroll. Broadcasting, changing progress or submitting work records no payable time. No live client/invoicing database or external integration is accessed.

The owner's split refines the blueprint's single Phase 3 gate. APPROVED/COMPLETED is one canonical task/assignment state, **APPROVED**, displayed as “Approved / Completed”; project COMPLETED is a separate project state. COPIES collaboration from Blueprint Section 6 is explicitly deferred by the owner. The proposed staging policy below keeps submission/review-only transitions unavailable in 3a rather than inventing reviews without their records. Existing account credential/MFA maintenance remains available as a security prerequisite; ACCOUNT receives no project/task/comment/submission/file access.

Owner amendments: SHARED only; COPIES/COPY_SOURCE and related columns/triggers/tests deferred. Projects default ACTIVE, with PLANNING selectable and an explicit employee read-only explanation in every non-ACTIVE state. Notifications are deferred; use a real-data new/updated-since-list-visit indicator. In 3b validate synchronously in the authenticated upload request, with no processor role, worker, lease/retry columns or malware-scanner adapter. A worker may be added later if volume grows. Totals remain 21/27 tables. All other proposed defaults are approved.

## 2. Schema and integrity model

### Common rules

UUID primary keys, actual foreign keys with RESTRICT deletes, supporting FK indexes, UTC timestamptz instants from the trusted server clock, and Asia/Manila display/calendar boundaries. Mutable rows have updated_at and positive optimistic version. Actors reference users; the database derives them from verified sessions, never a caller-selected actor. Category/state fields use enums or CHECK constraints. History is retained; no ordinary role receives DELETE/TRUNCATE.

All ten new tables receive RLS and restricted grants. Auth-only libetario_auth receives no project/task/file data privileges. New business mutations use narrowly granted fixed-search-path functions, with service validation and database validation. Existing audit_log is reused for timestamped before/after transitions, membership changes and reasons; no additional status-history, notification, timer or queue table is proposed.

Creation endpoints use caller retry keys with per-creator uniqueness and a canonical payload fingerprint, stored on their business rows. A repeated identical task creation returns its existing materialized assignments; it does not resnapshot ALL_ACTIVE or add another task. A reused key with different input conflicts. Unique membership/revision/review keys also protect concurrency.

### 3a tables

| Table | Planned columns and real relational constraints |
| --- | --- |
| **projects** | id; code (canonical unique); name; optional client_label and website_url; description; references JSONB containing bounded HTTP(S) links/labels; optional start_date (date), deadline_at; priority LOW/NORMAL/HIGH/URGENT; status PLANNING/ACTIVE/ON_HOLD/COMPLETED/CANCELLED; created_by FK users; status_changed_by FK users and status_changed_at; timestamps/version; creation_key and creation_fingerprint, UQ(created_by, creation_key). Client label is standalone text, not a client-database FK. Default ACTIVE/NORMAL. |
| **tasks** | id; unique server-generated task_number; project_id FK projects; title; instructions; references JSONB; due_at; priority; status; assignment_mode INDIVIDUAL/SELECTED/ALL_ACTIVE; collaboration_mode CHECK allowing SHARED only; creator/status actor FKs users; status_changed_at; recipient_snapshot_at; membership_version; timestamps/version; retry key/fingerprint, UQ(created_by,creation_key). No copy/source columns. |
| **task_assignments** | id; task_id FK tasks; employee_id FK employee_profiles; assigned_by FK users; assigned_at; assignment_origin INITIAL/ADMIN_ADDED; status; status_changed_by FK users; status_changed_at; counts_for_completion (default true); optional access_revoked_at, access_revoked_by FK users and revocation_reason; timestamps/version. UQ(task_id, employee_id), UQ(id, employee_id), UQ(id, task_id). One durable assignment/contribution identity per task/employee, including withdrawn history. Revocation fields must be coherent. An approved contribution remains counted and cannot be rewritten by withdrawing access. No duration/pay columns. Private list-visit time and observed task/project/assignment versions support the new/updated indicator without changing progress. |
| **task_comments** | id; task_id FK tasks; author_id FK users; plain-text body; created_at; creation_key and creation_fingerprint with UQ(author_id, creation_key) for retries. Append-only. Author must be the actual authorized actor at insertion. No arbitrary employee author, edit/delete endpoint, executable HTML or automatic remote link fetching. |

Current status actor/time columns are real FKs/instants. Existing append-only audit rows retain every transition, including old/new states and versions. Employee history is a narrowly projected task/own-assignment timeline after checking current live task access; employees never receive generic audit_log SELECT or its unrelated compensation/security payloads. JSON event IDs select already-authorized history, never grant access themselves.

### Shared shape and counting

One SHARED task has explicit durable contribution rows per employee, independent progress and shared comments. COPIES/COPY_SOURCE are deferred: no source/copy-owner columns, hierarchy triggers or copy tests. collaboration_mode is extensible with only SHARED currently permitted by CHECK. Count distinct task IDs, never assignment joins: three contributors still count one task. Cancelled work is separate/excluded from the denominator; empty work is not 100%. Employees see only their own visible task counts.

### Assignment modes and lifecycle

| Mode | Materialization / invariant |
| --- | --- |
| INDIVIDUAL | Exactly one current recipient for a shared task. Reassigning an unapproved item withdraws the prior recipient and creates/reactivates the explicit replacement in one audited transaction. No second concurrent recipient. |
| SELECTED | Non-empty, deduplicated explicit employee IDs. Validate all recipients before committing; a bad/ineligible ID rolls back the entire creation/addition. |
| ALL_ACTIVE | Snapshot once at the creation transaction's database/MVCC boundary and record the snapshot time. Materialize explicit rows for every employee eligible at that boundary. A later hire, reactivation or duty activation does not add anyone. An administrator must explicitly add that person while the task is open. Retrying the creation key returns the original snapshot. |

Proposed active-recipient definition: role EMPLOYEE, account enabled, employment_status ACTIVE and start_date no later than the snapshot's Manila date. Duty activation/MFA enrollment is not required to receive an assignment; it is required to access work. Proposed per-creation/addition limit is 500 recipients, configurable in validated WORK.tasks policy. ALL_ACTIVE exceeding that limit fails atomically with a capacity message; it is never silently truncated. Zero eligible recipients fails creation.

Deferred constraints enforce final cardinality/shape, so create/reassignment can stage rows inside one transaction without leaving an invalid committed task. Membership withdrawal removes access on the next read, cancels an unfinished contribution and excludes it from required completion with a reason; an approved contribution is preserved. Zero remaining required contributors cannot yield APPROVED. Restoring access is explicit, versioned and audited; no automatic ALL_ACTIVE subscription exists. Approved tasks cannot silently acquire new required work; use a new task for follow-up work.

### 3b tables and additions

| Table | Planned columns and real relational constraints |
| --- | --- |
| **task_submissions** | id; assignment_id FK task_assignments; revision_number > 0; state DRAFT/SUBMITTED/ABANDONED; notes; bounded urls JSONB; created_by FK users; created_at, updated_at/version; optional submitted_at. UQ(assignment_id, revision_number), UQ(id, assignment_id); partial UQ(assignment_id) WHERE state=DRAFT. Drafts are needed to own quarantined files before submission; submitted content is immutable. Only the actual assigned employee can create/submit it. |
| **task_reviews** | id; submission_id FK task_submissions, unique; reviewer_id FK users; decision APPROVED/REVISION_REQUIRED; optional approval note / required revision reason; reviewed_at. One immutable decision per submitted revision; reviewer must be a valid MFA administrator. A revision request requires 10–2,000 characters. A later attempt uses a new submission revision, never an edited old review. |
| **file_objects** | id; unique random storage_key; sanitized display_name; declared_media_type; detected_media_type; declared/reserved/actual size_bytes; SHA-256 digest after upload completion; uploaded_by FK users; upload_session_id with same-user composite FK to sessions; upload_completed_at; state QUARANTINED/AVAILABLE/REJECTED; validation_policy_id FK policy_versions; created_at, validated_at, validation outcome/version; optional bytes_deleted_at for controlled garbage accounting. Typed constraints govern each state, byte bounds, digest/key shape and completion/validation coherence. No direct runtime file-state writes; authenticated upload validation and publication are synchronous. |
| **project_files** | PK(project_id, file_id); FKs projects and file_objects; file_id unique; linked_by FK users, linked_at. Administrator-owned common project references. |
| **task_files** | PK(task_id, file_id); FKs tasks and file_objects; file_id unique; linked_by FK users, linked_at. Administrator-owned references for that specific task, not all tasks in its project. |
| **submission_files** | PK(submission_id, file_id); FKs task_submissions and file_objects; file_id unique; linked_by FK users, linked_at. The owning draft must belong to the current employee; submitted links are immutable. |

3b adds optional current_submission_id to task_assignments with composite FK(current_submission_id, id) -> task_submissions(id, assignment_id), preventing another assignment's submission from being selected. Revision numbers are allocated under the assignment lock. At most one unreviewed submitted revision is current. Retries cannot duplicate submissions, decisions or completion counts.

User-facing submission/revision totals count submitted attempts, not abandoned drafts or failed validation requests. None of these records is evidence of elapsed work or a Phase 4 rework time segment.

An owner-validation deferred trigger locks the file row and enforces **exactly one typed owner across all three file-link tables**, including quarantined uploads. Per-table uniqueness alone is insufficient. No polymorphic owner text field, cross-parent relinking, shared-object UUID reuse or globally exposed hash deduplication is allowed. Common references use project files. Task-private objects have separate exact owners.

## 3. Authorization and RLS

```text
Administrator: valid MFA ACCOUNT -> existing admin guard -> scoped transaction
Employee: active DUTY -> requireDuty -> transaction-local duty context
    -> live task assignment -> exact resource ownership -> fixed projection
Every database read/mutation repeats the applicable authorization predicate.
An earlier JavaScript guard result is never a substitute for RLS/current membership.
```

Ordinary ACCOUNT identity remains unchanged. Introduce purpose-limited project/task helpers derived from private.is_admin() or private.duty_context(); do not broaden private.identity()/private.can_read() to make a DUTY cookie into ACCOUNT. An expired ACCOUNT does not shorten an otherwise valid DUTY session. Never combine the user ID from one cookie with privileges from another; conflicting active identities are rejected rather than merged. MFA administrators act as administrators, never silently as an employee contributor.

Employee work pages must not inherit the existing /me layout's ACCOUNT-only guard. Their work layout derives identity from the validated DUTY context, including an approved overnight continuation on its original grant/date. Profile/security links retain their separate existing account requirements.

| Resource | MFA administrator | Employee with current DUTY | Employee ACCOUNT / SETUP / expired or revoked DUTY |
| --- | --- | --- | --- |
| Projects | Manage all | Read minimal project metadata only when holding a current assignment to a task in that project; only own visible task list/counts | No project/task data |
| tasks | Create/edit/assign/cancel with audit | Read only tasks with a current non-revoked assignment; change own progress within graph | Denied |
| Assignments | Read/manage all, no fabricated employee submissions | Own assignment/contribution only; no other employee's progress history | Denied |
| Comments | Read/add on task | Read/add shared comments only on their assigned task, while project permits writes | Denied |
| Submissions/reviews | Read/review all | Own assignment's submissions and review history only (proposed privacy default) | Denied |
| Project files | Manage | Download common project files when assigned to at least one task in that project | Denied |
| Task files | Manage | Download only for their exact assigned task | Denied |
| Submission files | Review/download | Own assignment's submission files only; uploader identity alone grants no access after withdrawal | Denied |

Being allowed to read project P never permits reading all tasks/comments/submissions/files in P. Same-project cross-employee guessing is explicitly tested. Minimal comment author labels are task-scoped projections; they do not grant directory, account, contact or rate access. Shared-task comments are collaborative, but the default does not expose a peer's private submission/review record.

Every new table has SELECT policies matching this matrix. Runtime writes are through narrowly granted mutation functions; no arbitrary status, membership, file-state, author or ownership updates. Functions derive actor, check scope and versions, and explicitly authorize their target before reading or writing under definer privileges. RLS helpers avoid recursive policy loops. Authentication cannot assume runtime or migration ownership; no file-processing role is added.

For a valid actor, missing and unassigned resource IDs produce the same 404 status/body/headers, including child/file IDs, list/search/count endpoints, HEAD and guessed URLs. Missing/invalid session receives a generic authentication/duty error before any object disclosure. Administrator-only mutations return a generic permission denial to employees. Routes are private/no-store, input-bounded and CSRF/origin protected; untrusted business text is rendered as text and HTTP(S) links are never fetched automatically.

Mutations use a shared transaction/DAL guard, existing security lock ordering, then consistent project -> task -> assignment -> submission -> file ordering, stable UUID order for multiple rows, and expected-version checks. Recheck duty, membership and parent state in the write transaction. Concurrent duty revocation, assignment withdrawal, policy switch or disabling cannot leave a usable stale authorization. Revalidate after waits/expensive work; retry serialization conflicts safely. Synchronous upload publication rechecks live authorization after expensive validation and preserves lock order.

## 4. Status transitions and review semantics

All six task/assignment states exist in the design. Services and database functions/triggers enforce allowed actor, predecessor, parent state and required records. Every successful change records server time, actual actor and old/new state/version in the same transaction. A no-op does not manufacture another transition.

| Transition | Actor / condition | Checkpoint |
| --- | --- | --- |
| Create -> PENDING | Administrator materializes valid assignments atomically | 3a |
| PENDING -> IN_PROGRESS | Employee on their own assignment with active DUTY; not a timer or Clock In | 3a |
| Open unapproved state -> CANCELLED | Administrator, mandatory reason; preserve previous submissions/reviews/history | 3a initially; additional states after 3b |
| CANCELLED -> PENDING | Explicit administrator restoration with reason and valid recipients/project; never an approved contribution rewrite | 3a |
| IN_PROGRESS or REVISION_REQUIRED -> SUBMITTED | Employee submits the current complete draft; payload/links freeze and assignment/current-submission update commit together | 3b only |
| SUBMITTED -> REVISION_REQUIRED | Administrator reviews the latest submitted revision; mandatory reason | 3b only |
| REVISION_REQUIRED -> IN_PROGRESS | Employee starts the requested rework; new revision history, no time segment yet | 3b only |
| SUBMITTED -> APPROVED | Administrator approval of that exact latest immutable revision | 3b only |

In 3a, SUBMITTED/REVISION_REQUIRED/APPROVED actions are unavailable and rejected in the database as well as the service. No manual approval shortcut, fabricated submission or placeholder review is shipped. Counting tests cover distinct WORK IDs and per-person progress now; positive reviewed-completion counting is exercised end-to-end in 3b. This staging policy is approved.

Overall shared-task status is derived under its task lock, not independently set by each employee: explicit task cancellation overrides; otherwise all required contributions APPROVED (at least one) -> APPROVED; any REVISION_REQUIRED -> REVISION_REQUIRED; otherwise any SUBMITTED -> SUBMITTED; otherwise any IN_PROGRESS or partial APPROVED -> IN_PROGRESS; otherwise PENDING. No remaining required contributors -> CANCELLED/explicit administrative resolution, never approval. The UI shows overall and own status separately, so one submitted contribution does not imply all staff submitted.

APPROVED is terminal in this phase. Corrections/further work use a new task, not an overwritten review. Comments may continue for current participants while the project is ACTIVE without reopening an approval. PLANNING/ON_HOLD/COMPLETED/CANCELLED projects are employee read-only; default new projects are ACTIVE (PLANNING selectable), with an explicit read-only reason on non-ACTIVE employee pages. Administrators explicitly activate/hold/cancel/reopen with audit reasons. Project completion requires non-empty countable work and every such task approved; 3a cannot falsely complete a project before review exists. Project state changes do not erase or silently rewrite child history.

## 5. 3b upload, validation and download design

### Storage and authority

PRIVATE_UPLOAD_ROOT is an absolute environment-configured directory outside public/, source bundles and static hosting. Local default location: ignored .local/private-uploads. Use separate quarantine/ and objects/ directories on one private volume. Service-account permissions/Windows ACLs restrict access. Keys are random 256-bit values with no client path/name component; exclusive creation prevents overwrite. Canonical root checks reject symlinks/junctions, non-regular files and path escape. Database keys are never returned as URLs or exposed in JSON, logs or SSR.

No separate processor role, background worker, lease/claim/retry columns or malware-scanner adapter. Validation is synchronous within the authenticated request, timeout 30 seconds, at most two concurrent validations. A worker may be added later if volume grows through separate approval.

### Lifecycle

```text
valid MFA administrator or assigned DUTY employee + CSRF + exact typed parent
 -> reserve quota; atomically create QUARANTINED metadata + exactly one owner
 -> bounded streaming to exclusive random quarantine key, count bytes/hash
 -> synchronous allow-list, signature + structural parse/decode and resource validation
 -> failure/timeout: REJECTED, never downloadable
 -> recheck live role/duty/membership/parent/policy after validation
 -> move validated bytes to private storage; transactional AVAILABLE + audit
 -> download: current authorization + exact owner + AVAILABLE -> private stream
```

Employees upload into their own draft only; administrators into project/task references. Submission requires all attachments AVAILABLE and freezes notes/URLs/links. Revocation before publication prevents it; future downloads always recheck current access. Filesystem and PostgreSQL are not one atomic transaction: move bytes before AVAILABLE, fail closed on database/move errors, reconcile known keys/hash/state after crashes. Completed bytes are immutable. A bounded operator cleanup command may remove stale incomplete/rejected bytes after TTL while retaining metadata/audit; never automatic AVAILABLE/submitted deletion.

### Proposed concrete defaults

Validated versioned WORK.tasks / WORK.uploads settings preserve unrelated work/pay/security fields; environment owns paths, storage-path settings. Changes require an MFA administrator, expected policy version and reason. Parser/dependency versions are reviewed and locked only during approved implementation.

| Control | Proposed default |
| --- | --- |
| Allowed types | PDF (.pdf, application/pdf), PNG (.png, image/png), JPEG (.jpg/.jpeg, image/jpeg), WebP (.webp, image/webp). No SVG, HTML, executable, archive or office-document uploads. Configurable subset of the supported allowlist. |
| Size | Positive actual content, maximum **10 MiB per file**; one file per streaming request; multipart overhead bounded separately to 64 KiB. Abort at the byte limit even with missing/false Content-Length. |
| Names | Normalize display names, maximum 120 characters; reject path components, traversal/encoded separators, NUL/control/CRLF, drive/UNC paths, colons/NTFS streams and reserved Windows names. Allow only a matching final supported extension; reject executable/double-extension spoofing. Storage paths use keys only. |
| Detection | Declared type/extension must agree with detected signature and a bounded structural parse/full image decode. A matching magic prefix alone is insufficient. Reject malformed/truncated files, detectable polyglots and unsupported/encrypted or detected active-content PDFs. Preserve validated originals; do not claim invisible content is harmless. |
| Resource bounds | At most two concurrent synchronous validations; validation timeout 30 seconds; maximum image dimensions 8,192 per axis and 20 megapixels; maximum 500 PDF pages. Failed/time-limited validation never becomes AVAILABLE. |
| Draft/quota limits | Ten files per draft; 100 MiB uploaded/reserved per employee per Manila day; 1 GiB per project and 5 GiB local application storage. Count staged/rejected bytes until physically removed. Reserve under locks; fail closed on insufficient quota/disk space. Limits configurable, no silent partial attachment. |
| Request limits | Upload 20 attempts per account per 15 minutes, at most two in-flight per uploader; downloads 120 requests per account per 15 minutes. Reuse persisted throttle infrastructure with distinct scopes; do not reset abuse counts on each successful retry. |
| Cleanup | Incomplete/rejected staging TTL 24 hours for bounded operator cleanup; retain metadata/audit. No worker/retries or automatic AVAILABLE/submitted deletion. |

OWASP's [file upload guidance](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html) supports layered validation: client MIME headers and a signature alone are insufficient; storage location, permissions and content handling also matter. The limits, synchronous-validation design and workflow above are project-specific proposals, not claims of complete malware detection.

### Downloads

Authenticated server streaming route by file UUID, with current administrator MFA or active DUTY and exact owner access. No public/static/signed bypass URL or direct path endpoint. Project authorization does not grant task/submission-private files. Runtime receives only authorized metadata; an owner-authorizing function supplies a storage key to the server, never to browser payloads. Generic SELECT grants exclude storage keys, validation-control fields; direct SQL cannot forge an availability attestation.

Check authorization before opening/headers and recheck during bounded streaming without refreshing idle lifetime merely because a download is open. Abort on detected revocation; bytes already delivered cannot be recalled. Validate the resolved private path/regular-file descriptor, size and integrity. Respond as an attachment with safe Content-Disposition, detected Content-Type, nosniff, private/no-store and no public caching. No inline previews, external URL proxying or range/resumable downloads initially. HEAD/conditional requests must not bypass authorization or disclose foreign sizes/hashes.

## 6. UI and planned implementation locations

Retain Next.js App Router/TypeScript/Tailwind and the sidebar conventions. Proposed additions after approval: src/server/dal/projects.ts and tasks.ts with shared scoped guards; transactional project/task/submission services; src/server/files/ synchronous validation in 3b; admin project/task management routes and employee duty-only task list/detail; scoped APIs for creation/assignment/progress/comments, then submissions/reviews/files. Route names can be finalized during implementation without changing this permission model.

3a admin screens include project CRUD/status, task creation with all audience choices, SHARED only, explicit selected-recipient preview, membership management, actual counts, task detail/status history/comments. Employee screens show their own assigned work, global versus own progress, due dates, plain instructions/references and shared task comments. No peer rate/account details, hidden project tasks or fake timer counters. Non-ACTIVE projects explain why progress/comments are disabled. List badges compare actual task/project/contribution versions with private per-assignment observed versions; explicit CSRF-protected acknowledgment covers only observed versions so concurrent updates stay unread. Notifications are deferred. 3b adds own draft/submit/revision history, administrator review queue and validated private attachments. Empty states, fetch times, pagination/filtering, explicit refresh, keyboard/mobile accessibility and real database values are required. Submission/review/file controls are visibly unavailable in 3a, not working-looking mockups.

## 7. Automated test matrix and evidence

All applicable checks use real PostgreSQL, restricted runtime-role connections, server/DAL calls and actual HTTP. Test migrations are isolated from dev/live databases. Test fixtures are clearly fake; no protected upload/TOTP/password secrets appear in screenshots or logs. New accepted counts are reported only after execution.

| Area | 3a evidence | 3b evidence / remaining gate |
| --- | --- | --- |
| Blueprint 15.4: one shared task, three employees | Three active-duty employees read the same task; three distinct durable assignment/contribution IDs and independent progress; shared comments visible only to its participants; one task/project denominator, no duplicate joins or payable-time rows | Three independent submitted/reviewed contributions, aggregate approval counts the shared task once; revision of one contributor does not overwrite another. **Timers remain Phase 4**, so scenario 4's timer portion is explicitly deferred. |
| Collaboration/counting | SHARED-only CHECK; three contributions count one task; cancelled/empty counts; COPIES columns/triggers/tests deferred | Reviewed aggregate counts once |
| Assignment modes | INDIVIDUAL cardinality; SELECTED non-empty/dedup/all-or-nothing; ALL_ACTIVE exact creation snapshot; disabled/inactive/future-start excluded; late-hired/reactivated employee absent until explicit admin addition; concurrent creation/hire and idempotent retry never resnapshot silently | Same guarantees on submit/review/file paths; no duplicate assignment or retroactive auto-broadcast |
| Scope / identity | MFA admin works without duty; password-only/SETUP admin denied; employee ACCOUNT receives no task/project/comment data; active DUTY works even after ACCOUNT expiry; conflicting identities never merge privileges | Same across submissions, reviews, upload/status and downloads |
| Isolation / guessed IDs | A and B assigned different tasks, including same project: UI/SSR/RSC/API/search/counts/DAL and direct runtime SQL isolate tasks/comments/assignments. Valid actor sees identical 404 for foreign/missing IDs. Project metadata does not leak B's tasks. No author/status/actor forgery or SET ROLE escalation | Repeat for own submission/review privacy, file_objects and all link tables; guessed UUID/key/path, owner relink, foreign attach and HEAD/conditional requests never disclose bytes/metadata |
| Revocation / races | Withdraw A's assignment or revoke duty during use: next read/write fails; stale versions reject; no history deleted. Race assignment change/status change/duty revoke, plus pooled-context isolation. Task access across approved Manila-midnight continuation retains the bound duty grant rather than substituting today's date | Revoke/withdraw while uploading, submitting, reviewing or downloading; unfinished uploads cannot publish, stale draft/owner cannot be reused; next download denied and detected in-flight revocation aborts |
| Status machine | Every allowed 3a edge and forbidden skip; own progress only; version/actor/time/audit checked; review-only states rejected in DB/service; empty/zero-required tasks never auto-complete | Every review/revision/resubmission edge, immutable old content/decision, mandatory revision reason, stale/non-current review rejection, simultaneous review/submit, terminal approval and aggregate task/project counts |
| Comments / text / URLs | Append-only, timestamp/actor, duplicate retry protection, cross-task author forgery, XSS rendered as text, unsafe schemes/userinfo rejected; no automatic fetching | Same for submission notes/URLs and review reasons |
| Upload type/size tampering | Deferred, no upload endpoint/table in 3a | Valid fixtures for every allowed type; wrong MIME, spoofed extension/double extension, signature-only/truncated/structurally invalid content, disallowed type, empty/exact-limit/oversized body, chunked and false Content-Length; parsing/resource limits |
| Upload filename/storage tampering | Deferred | POSIX/Windows/encoded traversal, absolute/UNC paths, NTFS alternate streams/reserved names, CRLF/NUL/Unicode normalization, symlink/junction escape and collisions; filenames never influence storage paths or overwrite files |
| Quarantine/synchronous validation/ownership | Deferred | No direct state/owner writes; unvalidated/rejected cannot download/submit; one typed owner under concurrency; timeout/two-validation bound, move/DB/crash reconciliation, hash mismatch, quotas and cleanup confinement. Every tampering test retained. |
| Regression / migration | All **73 accepted tests** plus applicable new checks; clean replay yields **21** RLS-enabled application tables; no review/file/time/payroll tables | Retain all 3a tests and the 73 baseline; replay yields **27** RLS-enabled tables; no time/attendance/payroll tables |
| Build / operational / mobile | Typecheck, production build, dependency audit, secret/grant checks and actual mobile/desktop task list/detail; no generated TOTP or fake live work/time values | Same plus actual synchronous upload/private stream integration, mobile upload/errors, backup notes covering private bytes + metadata (and separately backed-up MFA keys) |

Blueprint 15.4 will be reported as its Phase 3 data/collaboration/counting portion passed only with the above evidence; actual timer/contribution-duration reconciliation remains Phase 4. The malformed-upload portion of 15.12 belongs to 3b. Existing money/time/cutoff and security scenarios stay in regression; later attendance/payroll/PDF/payment scenarios are not marked complete.

## 8. Proposed implementation/commit sequence after approval

**3a:** (1) schema/constraints and duty-aware RLS/functions; (2) assignment materialization/counting and status/audit services; (3) admin and duty-only employee UI; (4) real DB/SQL/HTTP isolation and scenario-4 model tests; (5) full regression/replay/typecheck/build/audit, coverage/run documentation and PHASE_3A_REPORT.md. Keep focused commits and stop for 3a acceptance.

**3b only after that acceptance:** (1) six tables and owner/immutability grants; (2) draft/submit/review/revision transactions; (3) streaming quarantine/synchronous validation/downloads and reconciliation; (4) actual UI and tampering/race tests; (5) full regression/replay/build/audit, private-storage backup/run notes, coverage and PHASE_3B_REPORT.md. Stop before Phase 4.

All defaults are approved subject to the amendments above, including submission privacy, reserved review-only transitions, all-required-contributors completion, 500 recipients and upload limits. **Implement 3a only; stop with PHASE_3A_REPORT.md before 3b.**
