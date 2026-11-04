# Phase 4 plan — Time, attendance and work reports

Status: **APPROVED for checkpoint 4a ONLY, with owner amendments, 4 November 2026. 4b requires separate acceptance.**

Prepared 4 November 2026, Asia/Manila. Sources: BLUEPRINT.md Sections 7, 8, 11, 12, 14 and 15; the original time-schema design in PHASE_1_PLAN.md; accepted Phase 2 duty semantics; accepted Phase 3b; the owner's Phase 4 instructions. Baseline: **27 application tables, 33 migrations and 143 accepted tests**.

## 1. Checkpoints and scope

| Checkpoint                  | Working deliverables                                                                                                                                                 | New tables                                                                        | Application-table total |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------: |
| **4a**                      | Clock In/Out, explicit breaks, missing-punch/long-shift flags, employee correction requests, administrator correction decisions and shift approval, attendance views | attendance_shifts, attendance_breaks, attendance_adjustments                      |                  **30** |
| **4b, after 4a acceptance** | Start/pause/resume/stop/switch timers, disputed-segment corrections, live work table, daily reports, daily/weekly task and attendance reports, CSV                   | task_time_segments, task_segment_adjustments, daily_reports, daily_report_entries |                  **34** |

Approval of this plan permits **4a only**. After 4a, run its tests/full regression, update coverage, deliver PHASE_4A_REPORT.md in the established format and stop. Start 4b only after separate acceptance. After 4b, deliver PHASE_4B_REPORT.md and stop before Phase 5. Migrate only each checkpoint's tables; alter existing policies, grants and functions only as needed for that checkpoint.

No payroll periods/calculations, deductions, paid-day conversion, payslips, payments or financial snapshots. approved_payable_seconds is an explicit attendance-review decision, not an automatic payroll calculation. Hosting stays local; no live client/invoicing connection.

Blueprint Section 11 also lists monthly/PDF reports and notifications. This requested split delivers **daily/weekly and CSV**; monthly presets, task/attendance PDFs and notifications are proposed deferrals to separately approved scope. Flags/alerts in attendance/live views do not imply a notification service. Section 15.9's payroll recalculation/financial-adjustment portion remains Phase 5.

## 2. Authorization and accounting boundaries

- Clock In is a separate command requiring requireDuty, enabled ACTIVE employment and the exact ACTIVATED duty grant/version/window. Clock Out and employee break/timer actions require current DUTY bound to that shift's grant/version. Authentication alone creates no time.
- Administrators use fully MFA-verified ACCOUNT. Corrections, shift approval and time-policy changes additionally require recent MFA under the existing five-minute setting. No administrator impersonates an employee punch; administrative entries identify their actual actor/source.
- Proposed default: employee attendance history/corrections, timers and reports require **current DUTY**; a later valid duty date may authorize historical own reads/claims. ACCOUNT retains its established profile/rates/duty/security scope. A revoked employee must obtain later duty access to file a claim, or have an administrator handle it. No new ACCOUNT exception is silently introduced.
- All seven tables receive RLS, including direct restricted-role SQL. Employees see only their own intervals, adjustments and reports; a shared task never grants peer attendance/timer data. Runtime has scoped SELECT and narrow fixed-search-path function mutations, no direct time/owner/status/payable writes or DELETE/TRUNCATE. Auth role receives no new business-table access.
- Preserve an employee's own recorded history after assignment withdrawal through a narrow ledger DTO with captured task/project labels. It must not broaden can_task/can_assignment or reveal current briefs/comments/submissions/files or peer data. Existing submitted daily-report content is retained similarly.
- Missing/foreign IDs have indistinguishable 404s for a valid actor. Derive ownership/actors from persisted verified context. CSRF/origin, private/no-store responses, bounded inputs, pagination and conflicting-cookie rejection continue across API/SSR/DAL/export paths.
- Attendance, breaks and declared task time remain distinct. A timer is a recorded work declaration, not proof of productivity. A gap is a review signal; it never creates a deduction.

## 3. Schema, foreign keys and preserved evidence

Common: UUID keys, UTC timestamptz(6), optimistic versions, actor FKs to users, indexed parent/filter keys and RESTRICT deletion. Original recorded punches and applied correction history cannot be overwritten by ordinary roles. JSON snapshots preserve evidence; they are never ownership authority.

Guard functions/triggers verify WORK policy type, schedule ownership/effective-date coverage and the actual Manila weekday, grant-date/window capture and source/actor coherence. Before/after DTOs contain selected time/break/review fields, never whole security/employee/rate rows.

### 4a tables

**attendance_shifts**

- id; employee_id FK employee_profiles.user_id; duty_id and captured duty_authorization_version; authorized duty_date and saved valid_from/valid_until; shift_number.
- Original recorded_clocked_in_at/recorded_clocked_out_at, original system_closed_at when applicable; effective clocked_in_at/clocked_out_at; source EMPLOYEE/CORRECTION, closure source/reason and causative actor. Actual end evidence is filled once by the real end event; correction never substitutes for an actual punch.
- Review flags with detection/resolution metadata; approval_status PENDING/APPROVED/REJECTED; approved_payable_seconds nullable NUMERIC(20,6); reviewed_by FK users, reviewed_at and mandatory review_reason.
- attendance_policy_id FK policy_versions; effective (schedule_id,employee_id) FK employee_schedule_history plus (schedule_id,weekday) FK employee_schedule_days when configured, adding the same-employee parent unique index; captured schedule/break rules; clock-in/out retry keys/fingerprints, audit metadata and timestamps/version.
- Composite FK(duty_id,employee_id,duty_date) to duty_authorizations(id,employee_id,duty_date), adding that parent unique index. UQ(id,employee_id), UQ(duty_id,shift_number), UQ(employee_id,clock_in_key) and partial UQ(employee_id,clock_out_key). Grant version/window are immutable historical snapshots, not FKs to mutable authorization_version.

**attendance_breaks**

- id; shift_id and employee_id with composite FK to attendance_shifts(id,employee_id); recorded start/end and effective started_at/ended_at; selected break code; original and effective paid classification with rule snapshot; policy_id FK policy_versions; source EMPLOYEE/CORRECTION and origin_adjustment_id FK when correction-created; actors, closure reason/source, retry keys/fingerprints and timestamps/version.
- UQ(id,shift_id,employee_id), UQ(employee_id,start_key), partial UQ(employee_id,end_key). The server derives paid status from allowed schedule/policy choices; a caller-supplied paid boolean cannot set it.

**attendance_adjustments**

- id; employee_id FK profile; duty_id with same-employee FK; immutable kind AMEND_SHIFT or ADD_MISSING_SHIFT; nullable target_shift_id with own-shift composite FK; requested_by FK users; reason; expected target version; server-captured original_values and proposed_values, including proposed break changes.
- PENDING/APPROVED/REJECTED; reviewer FK users, decision reason/time; applied_shift_id with same-employee FK; exact applied before/after; request key/fingerprint and timestamps. Target required for AMEND, absent for ADD. One pending AMEND per shift; unique requester/key; one decision per request.
- An ADD approval creates exactly one closed CORRECTION-source shift and links it atomically. Actual punches remain NULL. A deferred FK from that shift to its originating approved adjustment and a same-employee/duty constraint trigger close the reference cycle. Filing a request creates no dummy shift or attendance.
- AMEND can propose a complete break change set. Every existing child ID must resolve to the target shift under locks; foreign break IDs fail. New breaks become real typed child rows. Store all original/applied child values in the immutable decision evidence. Deferred constraints check the final shift/break set together.

Employees cannot approve requests. Administrators may make explicitly labeled administrative proposals/decisions with reasons; these do not masquerade as employee requests. A request's original payload is immutable after filing; a reviewer records one decision and exact applied result, not an edited request.

CHECK/deferred constraints enforce valid endpoint ordering and end/source/reason coherence; APPROVED requires a closed shift, non-NULL bounded payable value, reviewer/time/reason, while PENDING/REJECTED have NULL payable. REJECTED requires decision metadata. Missing actual punches are permitted only for an adjustment-backed CORRECTION source. Approval applies the filed proposal; a different change needs a new labeled proposal, preserving the employee's original claim.

### 4b tables

**task_time_segments**

- id; employee_id; assignment_id; shift_id; task_id; original recorded start/end plus effective started_at/ended_at; kind ORIGINAL/REVISION; revision_review_id FK task_reviews when REVISION; ended_reason/source/actor; policy_id FK policy_versions; captured labels; timestamps/version.
- Composite own-assignment FK(assignment_id,employee_id), own-shift FK(shift_id,employee_id), and assignment/task FK. UQ(id,employee_id) and UQ(id,employee_id,assignment_id,shift_id). Revision trigger verifies the referenced decision is REVISION_REQUIRED for this exact assignment.
- timer_id and segment_sequence; root-only timer_state RUNNING/PAUSED/STOPPED, timer_closed_at/reason and timer_version. Self-composite FK(timer_id,employee_id,assignment_id,shift_id) references the first segment/root; UQ(timer_id,segment_sequence). Trigger verifies a true root, sequence 1, same assignment/shift/employee and valid children. The first interval doubles as logical timer control: **no extra timer-session table**.

**task_segment_adjustments**

- id; segment_id and employee_id with own-segment composite FK; actor_id FK users; mandatory reason; exact original/new effective endpoints and versions; created_at; retry key/fingerprint; optional attendance_adjustment_id FK for a combined shift/segment correction.
- Append-only. Correct closed segments in stopped timers/closed shifts only. No duration-only addition, employee/assignment/shift/kind relinking or fabricated employee timer.

**daily_reports**

- id; employee_id FK profile; Manila report_date; work_in_progress, issues, notes, next_steps; DRAFT/SUBMITTED; submitted_at; actor FKs; timestamps/version/retry key.
- UQ(employee_id,report_date), UQ(id,employee_id). Future dates fail. Submitted narrative is read-only by default; no administrator impersonation of an employee report.

**daily_report_entries**

- id; report_id and employee_id with own-report composite FK; assignment_id, task_id, project_id; own-assignment FK, assignment/task FK and task/project composite FK, adding required parent unique indexes.
- Description, employee-reported completion flag, captured labels/status; included/excluded draft state; timestamps/version. UQ(report_id,assignment_id). Project is derived from assignment. Reported completion cannot approve a task or manufacture time. Submit freezes included entries with the report.

Reuse audit_log. Retry receipts live on their owning business rows; no operation-idempotency/event/queue/scheduler table. Original capture, mutation and audit commit together. Original closed segment evidence remains unchanged even when effective endpoints are corrected.

## 4. Constraints, durations and idempotency

- One open shift: partial UQ attendance_shifts(employee_id) WHERE clocked_out_at IS NULL. Actual GiST exclusion `(employee_id WITH =, tstzrange(clocked_in_at,clocked_out_at,'[)') WITH &&)` prohibits overlapping effective shifts, including open ranges. Multiple adjacent shifts are valid; do not impose one shift per duty date.
- One open break/shift and no overlapping breaks: partial unique index and GiST exclusion on shift_id plus the effective range. Deferred triggers enforce same-employee containment and no open break inside a closed shift.
- One running segment: partial UQ task_time_segments(employee_id) WHERE ended_at IS NULL. Equivalent employee/range GiST exclusion prevents overlap across assignments/projects/shifts. A second partial unique index on employee_id for root rows in RUNNING/PAUSED enforces one live logical timer, including paused state.
- Deferred triggers require RUNNING iff exactly one open child, no open child for PAUSED/STOPPED, correct root/sequence/ownership and stopped roots before shift close. Segments/breaks must fit the effective shift; task segments cannot intersect any paid/unpaid break. Corrections obey all the same constraints.
- Explicit refinement of the old design's strictly positive closed durations: allow **end >= start**, flag retained zero-duration same-instant events and prohibit negative durations. Do not fabricate a one-second minimum or delete a Start immediately followed by revoke/stop. Empty half-open ranges contribute zero. Natural retry keys and interval constraints replace reliance on timestamp uniqueness for duplicate prevention.
- Compute exact integer microseconds/numeric seconds in PostgreSQL from server timestamps and interval intersections. Serialize exact duration strings; retain fractional seconds. No floating-point elapsed accounting, attendance rounding, wage rounding or payable formula. Client animation is provisional and never saved as time.
- Command timestamps come from private.security_now() **after locks and revalidation**, one timestamp for a compound action. Discard client clock/counter fields before accounting/fingerprinting. Only explicit correction proposals contain requested historical times, and those require administrator review.
- Persist per-action operation UUID, canonical accepted-payload fingerprint and result IDs on the owning business row for duplicate-click/retry protection. No timer receipt ceiling or terminal-receipt design. Live authorization and expected versions still apply before returning a receipt.

All GiST/partial-unique/deferred checks are actual SQL migrations using the existing btree_gist support, not Prisma-only validation.

## 5. Locking and integration — approved amendment

Implement per-employee locking first, retaining the existing order: policy -> sorted users -> session/duty -> project/task/assignment where relevant -> shifts -> breaks -> adjustments. Clock, break, correction, approval and revocation all serialize on the affected employee user row. Recheck scope after waits; capture trusted action time after locks. Multi-employee batches lock users in UUID order before parent/child rows. No slow network work occurs under write locks.

Do not add a global shared/exclusive time-coordination gate unless a real PostgreSQL concurrency test demonstrates a failure that needs it. Preserve the failing evidence and explain any resulting gate in PHASE_4A_REPORT.md. Mandatory races: revoke/Clock In, Clock Out/break, double Clock In and correction/punch. Adapt invalidation functions before adding time effects; avoid reverse parent/employee lock acquisition. 4a references no timer table.

## 6. Attendance, breaks and review — 4a

```text
current DUTY + activated exact grant/version/window
 -> explicit Clock In -> open shift, PENDING review, payable NULL
 -> Start break / End break -> actual server intervals
 -> Clock Out -> close open break and shift at one timestamp
 -> administrator review -> explicit approval/rejection with reason

own employee claim or labeled administrator proposal
 -> immutable PENDING correction + captured original/version
 -> reasoned administrator APPROVE / REJECT
 -> approved complete change set + before/after audit
 -> changed shift PENDING approval again; old approval preserved in history
```

Default multiple non-overlapping shifts are allowed in one grant window. Clock Out closes a shift, not the grant; another explicit Clock In may use the same still-valid grant. A versioned shift-count cap may restrict this. Numbering stays unique across regrants; old closed rows retain their captured version. Clock In never silently continues a different date's grant or reopens a previous shift.

Breaks are explicit start/end events. Seed configurable MEAL (unpaid) and SHORT (paid) codes; the server snapshots their classification. Allowance comes from the effective schedule or explicit configured code allowance; unconfigured allowance is flagged. Excess break time is flagged, never clipped or given a penalty deduction. Suggested approval subtracts recorded unpaid breaks only; any flagged shift requires individual review. Owner/accountant must confirm paid/unpaid treatment before Phase 5. In 4b break start pauses a running timer, and break end does not automatically resume it.

Missing schedule, non-working day, lateness, holiday configuration and overtime expectations are flags, not wage rules. No assumed workweek, Philippine holiday list or premium is installed. Informational holiday dates can be owner-entered in validated WORK configuration, initially empty. Proposed lateness grace is zero seconds, configurable. Explicit duty authorization permits recording even if schedule configuration needs review.

An open shift **longer than 16 hours** is flagged by default; exactly 16 hours is the boundary. This configurable threshold is not a truncation or automatic Clock Out. Missing/system-closed/disputed shifts have no approved payable value. Flags are derived on reads and persisted/resolved by guarded reconciliation/review; no fake background execution is claimed.

Every closed shift requires explicit recent-MFA administrator approval. Show SUGGESTED seconds = effective elapsed minus recorded unpaid breaks, clearly labeled and never saved as approved until accepted. Administrator can accept or override (0..gross); override requires a 10–2,000 character reason. Flagged shifts require individual flag acknowledgment/reason. Clean closed shifts with no flags/pending correction support date-range/employee bulk preview and atomic version-checked approval of suggestions. No automatic approval or payroll result. Rejection leaves approved seconds NULL; applied corrections invalidate approval while preserving prior values.

AMEND uses the captured version; a stale request cannot overwrite a later punch/correction. Reject or file a replacement, never edit the original pending proposal. ADD_MISSING_SHIFT addresses a missed Clock In with no existing shift: require a real own dated duty record, closed past proposed endpoints, no overlap and an explicit administrator decision. It creates CORRECTION-source time only on approval; absent actual punches remain NULL. Claims outside the verified historical window are retained/flagged but cannot silently extend duty/overnight authorization. Ambiguous historical evidence after regrant requires administrator verification; no historical grant is fabricated.

In 4b, a shift correction that would strand task segments either conflicts or includes explicitly reviewed segment adjustments in the same transaction, each with its own before/after/reason and parent adjustment FK. Never silently clip/delete segments. Phase 5 will add payroll-source freezing and controlled financial adjustment; this phase does no draft-payroll recalculation or finalized-payroll editing.

For a missing Clock Out while the shift/timer is still open, an administrative close-and-correct transaction first seals live control state at trusted T with ADMIN_CORRECTION_REVIEW evidence, then applies the explicitly reviewed historical endpoints and child corrections under deferred checks. Original observed/system-end values remain intact. No employee request itself closes time, and no open interval is silently shortened without a recorded approved correction.

## 7. Revocation, expiry, overnight and downtime

| Event                                                                                                                        | Proposed result                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Duty revoke/regrant while working**                                                                                        | At trusted T, atomically close the bound running segment, STOP any RUNNING or PAUSED root, end the break and close the open shift. Use the earlier applicable grant boundary or T. Flag DUTY_REVOKED/SYSTEM_CLOSED/MISSING_PUNCH for review, keep payable NULL, increment authorization_version, revoke bound sessions/challenges and audit together. Next HTTP/direct guard request fails. Closed reviewed history remains intact. Regrant never revives tokens/intervals. |
| **Assignment withdrawal**                                                                                                    | Stop only that assignment's running/paused timer at T with a flagged reason. Keep the attendance shift and break intact so another authorized task can be worked. Preserve time and narrow own-ledger history; current task access disappears. Restoration never restarts a timer.                                                                                                                                                                                          |
| **Task cancel/submit/approval, or project leaves ACTIVE**                                                                    | Stop affected RUNNING/PAUSED timers at T with the actual reason, preserving segments. Submit and timer stop commit together. Attendance stays open. Restoring/revising never auto-starts time.                                                                                                                                                                                                                                                                              |
| **Disabled account/inactive employment**                                                                                     | System-close shifts/breaks/timers with review flags atomically with access invalidation. Reactivation does not reopen them.                                                                                                                                                                                                                                                                                                                                                 |
| **Idle/absolute session expiry, session logout, SECURITY switch or credential/PIN/MFA invalidation without duty revocation** | Block tools immediately under existing security rules. Token expiry is not an employee Clock Out. Intervals remain bounded by the still-valid grant; new actions require current reauthentication. Polling does not refresh idle life. Administrator duty revocation forces time closure.                                                                                                                                                                                   |
| **valid_until reached**                                                                                                      | Authoritative accrual ends exactly at valid_until. Guarded reconciliation materializes ends/flags at that boundary, not the later discovery time. No implicit next-date activation.                                                                                                                                                                                                                                                                                         |
| **Process/browser/network downtime**                                                                                         | Committed intervals survive. Bounded reconciliation on startup/next authorized time request/admin refresh, or an explicit local owner CLI, closes expired records at the stored boundary and flags missing/long shifts. No new role/daemon/table. Reads bound unresolved open ends by min(as_of, valid_until, recorded invalidation boundary), so downtime cannot add post-grant time. Show reconciliation backlog/staleness honestly.                                      |

Switching to a different duty grant while an old valid shift remains open requires explicit Clock Out under the old grant first. Same-grant reauthentication remains allowed. Reconcile an expired/revoked old grant first; losing the old handle requires administrator closure/review rather than a backdated login. Check before replacing old cookies/sessions so authentication cannot strand a valid overnight shift. Include this cross-grant issuance race in 4a HTTP tests.

Every Clock In reconciles the employee's stale prior open shift before uniqueness checks. The due reconciler derives time/targets from stored state under locks; it is not an unauthenticated endpoint or caller-chosen close time. The operator CLI is local/test guarded, migration-credential-only, absent from request imports, and refuses production/remote targets without an explicit operator flag.

If trusted server time moves backwards, ordinary commands fail closed and flag CLOCK_ANOMALY. Security revocation must still succeed: seal an otherwise negative open interval as zero at its recorded start, preserving the raw observed transition time and anomaly evidence for mandatory correction/review. Never repair server time from a client clock or manufacture negative/paid duration.

Overnight remains **OFF**. When enabled, preserve the exact original duty ID/date and saved window, with the accepted eight-hour carry ceiling after Manila midnight (configurable 1–8). No midnight truncation, new implicit grant or backdated first authentication. Existing bound overnight access may continue or reauthenticate under the accepted 30-minute idle / maximum 12-hour session limits until valid_until. Any authorized new shift uses its actual server instant and original carried grant, not a fabricated prior-date punch. The 16-hour flag is independent of session lifetime/carry and never discards valid time.

Reporting clips intersections at actual Manila calendar boundaries without altering source intervals. 23:30–01:30 yields 30 minutes on the first date and 90 on the next, still one shift on the original authorized date. Apply the same half-open rule at week/year boundaries; split parts must equal the original exactly.

## 8. Timers and disputed segments — 4b

```text
current DUTY + own open shift + no break + eligible own assignment
 -> Start -> root RUNNING + first ORIGINAL/REVISION segment
 -> Pause -> close segment, root PAUSED (gap contributes no task time)
 -> Resume -> new segment, same root/employee/assignment/shift
 -> Stop -> close segment if running, root STOPPED

explicit Switch X -> Y -> STOP X (even if paused), Start Y at the same T
Clock Out -> STOP every live root, end break and shift at the same T
Submit -> STOP this contribution's timer + freeze submission atomically
return on another shift/date -> NEW root, accumulated contribution history
```

Default eligible statuses: PENDING, IN_PROGRESS, REVISION_REQUIRED on an ACTIVE project. Start atomically starts own progress if needed. SUBMITTED/APPROVED/CANCELLED cannot start new work; approval remains terminal. A plain competing Start cannot silently replace an unexpected timer: use explicit Switch with expected current root/version. Default switch mode is atomic stop/start; supported alternative is explicit-stop-first. If the target is unauthorized or changed, the whole switch rolls back and the previous timer survives unchanged.

A paused root has no open timed segment but remains a live logical timer. **Clock Out stops paused roots too.** Resume fails for a stopped/prior-shift/withdrawn/closed root. Break end, login, page reload, project restoration and revision decisions do not auto-resume.

After an employee's REVISION_REQUIRED decision, subsequent work is kind REVISION, linked to that exact own immutable review even when status returns to IN_PROGRESS. Client cannot relabel it ORIGINAL. Root/children retain the same classification/review, and original/per-revision sums stay separate.

Administrator disputed-segment correction requires a closed segment, stopped root/closed shift, expected versions, recent MFA and 10–2,000 character reason. Keep original evidence and applied before/after; enforce overlap, break intersection and shift containment; invalidate the shift's attendance approval. No rewrite of submission/review decisions or revival of task access.

## 9. Daily reports, live monitoring and CSV — 4b

**Daily reports:** one per employee per actual Manila date, independent of original authorized duty-date attribution. Current DUTY permits own past-day backfill; future dates fail. Entries select current own assignments eligible for that day, or own historical assignments evidenced by recorded time that day. Withdrawn history exposes captured ledger labels only. A report can have zero task entries if it contains a meaningful issue/non-work note; never invent a task or elapsed time. Default 100 entries/report, narrative fields 5,000 characters, entry description 2,000, HTTP body 128 KiB. Draft entries may be excluded/restored with audit. Submit freezes text/included entries. Post-submit reopening is deferred; administrator reads/reports without filing as an employee.

**Live work table:** Employee | Duty Status | Current Task | Current Session | Task Time Today | Attendance Today | Alerts. Administrator only, real stored data and server as_of/fetch timestamp. Current Session means recorded active duration in the current logical timer, with RUNNING/PAUSED status; it does not mean authentication-session lifetime. Task Time Today sums actual Manila-day segment intersections, separating ORIGINAL/REVISION. Attendance Today shows gross elapsed attendance and separate paid/unpaid break totals. It is not approved payable time. Empty/paused/stopped/stale states are explicit; no fake live figures. Alerts include deadline, missing punch, long shift, scope interruption and unresolved configuration/review.

Default polling **15 seconds**, configurable 10–60, plus explicit Refresh. Automatic polls and per-chunk checks never slide idle expiry. Invalid sessions stop access, including administrator MFA/session invalidation. One consistent server snapshot supplies each response; mark stale/error/as_of visibly. No websocket service is needed initially.

**Daily/weekly time reports:** administrator filters by date, employee, project, status and assignee; employee own only. Group by employee/task/project and calendar day/week, include source interval IDs/effective versions, original/revision breakdowns, breaks, flags and approval state. One shared task remains one work item; summed contributor durations are labeled as such. Weekly default is Monday 00:00 through next Monday 00:00 Manila, end exclusive, configured in WORK.reports. No payroll-period row is created.

The 8h attendance / 6h task case displays both and a **2h unallocated review signal**, with break context, without a deduction or auto-payable result. Per-shift approved_payable_seconds is a separate explicit decision. Do not infer or duplicate its allocation across daily/weekly boundaries: expose a separate one-row-per-shift approval detail/export. Phase 5 owns payable allocation/formulas.

CSV shares the guarded DAL/filter/calculation path, UTF-8, correct quoting and spreadsheet-formula escaping on untrusted text. Employee exports exclude peer records/rates/security data. Default/max request bounds: **31 days / 50,000 rows**; over-limit requests fail rather than silently truncate. Stream with backpressure, a consistent as_of/source snapshot and fresh authorization checks between chunks; lost authorization aborts. Attachment/no-store/nosniff responses, no public file URL or export job. Later approved corrections update visibly versioned effective time reports; they do not rewrite submitted employee narrative or a frozen financial snapshot.

## 10. Proposed versioned policies

Add validated WORK.attendance, WORK.timers and WORK.reports, preserving WORK.tasks/uploads/overnight fields. Require recent administrator MFA, expected current policy ID and reason. Snapshot grant window/version, effective schedule and attendance/timer policy on new intervals. Policy edits govern new records/requests; retroactive changes require correction/review. Existing WORK-change invalidation of pending uploads remains intact. SECURITY session scope/lifetimes are unchanged.

Concrete proposed defaults/bounds are in the new Phase 4 section of ASSUMPTIONS.md. Security/ownership/no-overlap/server-time invariants and mandatory reasons cannot be switched off. Supported modes/thresholds/limits are configurable through versioned policy; no arbitrary scripts or payroll formulas.

## 11. Test matrix and scenario mapping

Use **real PostgreSQL, restricted non-owner/NOBYPASS roles, actual migrations/constraints and real HTTP**. The existing trusted-clock fixture may operate only with the dedicated local test owner; restore it in finally. No OS/client/header/production-environment clock override. Run clock/key suites sequentially. New test counts are reported after execution, not invented at planning time.

| Scenario/edge                            | 4a exit evidence                                                                                                                                                                                 | 4b exit evidence                                                                                                                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **15.1–3 access/revocation regression**  | A activated/B absent; ACCOUNT/SETUP denied clocks; revoke mid-shift closes shift/break atomically, next HTTP/direct guard fails; regrant cannot revive; history retained                         | Same with RUNNING/PAUSED timer, exact stop/revoke instant, both serialization orders                                                                                                                             |
| **15.4 three-person shared task**        | Existing collaboration/privacy/counting regression; timer portion deferred                                                                                                                       | Distinct own timer/contribution histories for three staff, peer SQL/API/SSR denial, one shared completion count; original/revision/review linkage                                                                |
| **15.5 pause/switch/return another day** | Multiple shifts/break/day intersections correct                                                                                                                                                  | X pause -> Y -> X another day; pause gaps excluded; exact employee/task/project/day/week sums, no overlap/cross-shift resume                                                                                     |
| **15.6 Clock Out with running task**     | Clock Out closes break at same server timestamp; no timer claim yet                                                                                                                              | Running interval ends with CLOCK_OUT audit; paused root also stops; stale resume denied; atomic retry/failure behavior                                                                                           |
| **15.7 attendance 8h/task 6h**           | Exact attendance/break values, payable NULL until explicit review                                                                                                                                | Actual 8h/6h/2h through UI/HTTP/CSV, no automatic deduction/payable/money                                                                                                                                        |
| **15.9 missed punch/correction**         | Missing out and missing-in ADD, originals preserved, mandatory decision reasons, one decision, stale/competing reviews, overlap/containment rollback, approval invalidation                      | Disputed segments, timer/correction races, combined shift/segment correction; payroll recalculation/financial adjustments remain **Phase 5**                                                                     |
| **15.12 rollover/missing punches**       | Overnight default off, explicit <=8h carry, original duty/date, same-grant reauth across 12h sessions, no implicit next date, exact valid_until, 16h vs >16h, downtime reconciliation            | Running/paused overnight timers, day/week/weekend/year splits, source sum equals split sums, daily-report date vs duty date, session expiry vs grant expiry                                                      |
| **Concurrent duplicates**                | Double Clock In same/different keys, Clock Out/break races, adjacent/open/closed ranges, shift numbering, one audit transition per operation                                                     | Double Start/Resume; Start/Switch/Pause/Stop/Clock Out/Submit/break races; different projects, one running segment/live root; failed target cannot half-switch                                                   |
| **Actual DB defenses**                   | Runtime direct time/status/payable/owner writes fail; GiST/partial unique/deferred tests via owner fixtures; correction cannot evade overlap/containment                                         | Root/child state consistency, composite FKs, revision binding, segment/break overlap, foreign report project/assignment, approved-task timer denial                                                              |
| **Lifecycle races**                      | Revoke/disable/inactive/expiry vs punches/review; reviewer expiry during wait; SECURITY denial without invented Clock Out                                                                        | Withdrawal/cancel/project pause/submit/review vs active/paused timer; restore never restarts; multi-user lock order/rollback; prior submission/upload behavior retained                                          |
| **Clock tampering/retries**              | Supplied past/future clocks/counters/timezone/employee ignored for accounting; separately reviewed correction times; zero instant/negative anomaly; duplicate/reordered/foreign receipts         | Same on timers; exact fractional sums; no accepted client duration; safe stopped-root/session receipt replays                                                                                                    |
| **A/B isolation/web**                    | Shift/break/request guessing both directions via UI/API/SSR/RSC/DAL/direct SQL; pooled default deny; missing/foreign 404, CSRF/origin/body bounds                                                | Segments/adjustments/reports/entries/export filters; own withdrawn ledger vs blocked current task data; forged actor/kind/status/project, formula injection; revoked export stream                               |
| **Reports/live data**                    | Real attendance filters/flags/review views                                                                                                                                                       | Unique report/date, own-entry FKs/freeze/backfill, no fake completion/time, zero-entry note rules; exact day/week/31-day/50k bounds; CSV quoting; polls do not refresh idle; consistent as_of and stale/error UI |
| **Regression/release checks**            | All **143 accepted tests** plus new 4a tests; clean replay exactly **30 RLS tables**, typecheck, Prisma generation, webpack build, prod audit, mobile/desktop clock/break/correction walkthrough | All accepted 4a tests plus new 4b checks; replay exactly **34 RLS tables**, same checks, mobile timers/reports/CSV and admin live views                                                                          |

Coverage bookkeeping correction: the current 3b TEST_COVERAGE.md labels 15.6 as revision/rework and 15.7 as weekly payroll. The authoritative blueprint labels them **Clock Out with running task** and **attendance/task gap**. Those actual scenario portions remain unimplemented today and become 4b exit tests. Keep the existing revision and cutoff utility tests as regression evidence, without treating them as substitutes. Phase 4 implementation will align the coverage labels and preserve explicit pending portions; financial cases 15.8/10/11 and the financial part of 15.9 remain Phase 5.

## 12. Implementation and stop sequence after approval

**4a:** (1) three tables, RLS/constraints/evidence; (2) lock/invalidation integration and guarded clock/break functions; (3) correction/review/reconciliation; (4) real employee/admin attendance screens; (5) DB/HTTP/race/rollover tests and all 143 regression checks; (6) replay/typecheck/build/audit, README/assumptions/coverage and PHASE_4A_REPORT.md. **Stop for acceptance.**

**4b after acceptance:** (1) four tables and logical timer constraints/RLS; (2) timer/revision/Clock Out/Submit/withdrawal integration; (3) segment corrections; (4) daily reports, live aggregates and CSV; (5) employee/admin/mobile screens and test matrix; (6) full regression/replay/typecheck/build/audit and PHASE_4B_REPORT.md. **Stop before Phase 5.**

Plan review points: seeded break treatment/allowances, multiple shifts, suggested approval/override bounds, session-expiry versus revoke behavior, DUTY-only historical correction access, zero-duration evidence refinement and Section 11 deferrals. Owner amendments above are approved for 4a. Actual implementation/test evidence is reported separately; stop after 4a.
