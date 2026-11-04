import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import {
  timeFixture,
  clockAndStart,
  startTimer,
  timerAction,
  assignment,
} from "../time-helpers";
import {
  advance,
  clockIn,
  clockOut,
  freshAdmin,
  freshDuty,
} from "../attendance-helpers";
import { blocked, runtime, sharedTask } from "../work-helpers";
import { db, authPool } from "../../src/server/db";
import * as t from "../../src/server/services/work-time";
import * as a from "../../src/server/services/attendance";
import { mutateDuty } from "../../src/server/services/duty";
import { session } from "../../src/server/auth/service";
import { startDuty, completeDutyStage } from "../../src/server/auth/duty";
import { otp } from "../../src/lib/mfa-crypto";
import { workSession } from "../../src/server/dal/work";
import { digest } from "../helpers";
import * as work from "../../src/server/services/work";
import * as submissions from "../../src/server/services/submissions";
import { freeze, setPolicy } from "../duty-helpers";

const reason = "Verified disputed time against the original record";
const key = () => randomUUID();
after(async () => {
  await db.$disconnect();
  await authPool.end();
});

test("15.4 shared task has three isolated timer ledgers and a single task identity", async () => {
  const f = await timeFixture();
  try {
    const runs = [];
    for (const who of ["a", "b", "c"] as const)
      runs.push(await clockAndStart(f, f.task, who));
    await advance(f, 123.456);
    for (const who of ["a", "b", "c"] as const) {
      const view = await t.ledger(f[who]);
      assert.equal(view.active?.seconds, "123.456000");
      assert.equal(view.items.length, 1);
      assert.equal(view.items[0].employee_id, f.ids[who]);
    }
    assert.equal(new Set(runs.map((x) => x.root)).size, 3);
    await assert.rejects(t.ledger(f.b, undefined, 0, runs[0].root), {
      status: 404,
    });
    await runtime(f.duty.b.token, async (c) => {
      assert.equal(
        (
          await c.query(
            "SELECT id FROM task_time_segments WHERE employee_id=$1",
            [f.ids.a],
          )
        ).rowCount,
        0,
      );
      await assert.rejects(
        c.query("UPDATE task_time_segments SET ended_at=now()"),
        { code: "42501" },
      );
    });
    assert.equal(
      (await t.report(f.admin, { from: f.day, view: "tasks" })).rows.filter(
        (x) => x.task_id === f.task,
      ).length,
      3,
    );
  } finally {
    await f.cleanup();
  }
});

test("15.5 pauses exclude gaps; explicit cross-project Switch is atomic and retries retain exact roots", async () => {
  const f = await timeFixture();
  try {
    const project = (
      await work.createProject(f.admin, {
        creationKey: key(),
        code: "T-" + f.suffix,
        name: "Other test project",
      })
    ).id;
    const taskY = await sharedTask(f, { projectId: project });
    const { root, shift } = await clockAndStart(f, f.task);
    await advance(f, 17.123);
    await timerAction(f, "PAUSE");
    await advance(f, 31);
    const live = (await t.ledger(f.a)).active!;
    assert.equal(live.seconds, "17.123000");
    const foreign = await assignment(f, taskY, "b");
    const aY = await assignment(f, taskY);
    const input = {
      command: "SWITCH",
      timerId: root,
      timerVersion: live.timer_version,
      assignmentId: aY.id,
      assignmentVersion: aY.version,
      operationKey: key(),
    };
    await assert.rejects(t.timer(f.a, { ...input, assignmentId: foreign.id }), {
      status: 404,
    });
    assert.equal((await t.ledger(f.a)).active?.id, root);
    const switched = await t.timer(f.a, input);
    assert.equal(await t.timer(f.a, { ...input, elapsed: 5000 }), switched);
    await advance(f, 2.235);
    await clockOut(f, shift);
    const results = (await t.report(f.a, { from: f.day, view: "tasks" })).rows;
    assert.deepEqual(results.map((r) => r.task_seconds).sort(), [
      "17.123000",
      "2.235000",
    ]);
    assert.equal(
      (await t.ledger(f.a, undefined, 0, root)).items[0].timer_close_reason,
      "SWITCH",
    );
  } finally {
    await f.cleanup();
  }
});

test("15.6 break start pauses, end never resumes, and Clock Out stops paused and running roots", async () => {
  const f = await timeFixture();
  try {
    const { shift, root } = await clockAndStart(f, f.task);
    await advance(f, 4);
    const punch = await a.attendanceDetail(f.a, shift);
    const id = await a.attendanceCommand(f.a, "BREAK_START", shift, {
      expectedVersion: punch.shift.version,
      operationKey: key(),
      code: "MEAL",
    });
    let timer = (await t.ledger(f.a)).active!;
    assert.equal(timer.timer_state, "PAUSED");
    assert.equal(timer.end_reason, "BREAK_START");
    await assert.rejects(timerAction(f, "RESUME"), { status: 409 });
    await advance(f, 7);
    await a.attendanceCommand(f.a, "BREAK_END", id, {
      expectedVersion: 1,
      operationKey: key(),
    });
    timer = (await t.ledger(f.a)).active!;
    assert.equal(timer.timer_state, "PAUSED");
    await clockOut(f, shift);
    const stopped = (await t.ledger(f.a, undefined, 0, root)).items[0];
    assert.equal(stopped.timer_close_reason, "CLOCK_OUT");
    assert.equal(stopped.seconds, "4.000000");
    await assert.rejects(
      t.timer(f.a, {
        command: "RESUME",
        timerId: root,
        timerVersion: timer.timer_version,
        operationKey: key(),
      }),
      { status: 409 },
    );
    const second = await clockAndStart(f, f.task);
    await advance(f, 2);
    await clockOut(f, second.shift);
    const last = (await t.ledger(f.a, undefined, 0, second.root)).items[0];
    assert.equal(
      last.ended_at,
      (await a.attendanceDetail(f.a, second.shift)).shift.clocked_out_at,
    );
  } finally {
    await f.cleanup();
  }
});

test("concurrent Start and Resume allow exactly one interval and fingerprint duplicate actions", async () => {
  const f = await timeFixture();
  try {
    await clockIn(f);
    const row = await assignment(f, f.task);
    const start = {
      command: "START",
      assignmentId: row.id,
      assignmentVersion: row.version,
      operationKey: key(),
    };
    const initial = await Promise.allSettled([
      t.timer(f.a, start),
      t.timer(f.a, { ...start, operationKey: key() }),
    ]);
    assert.equal(initial.filter((r) => r.status === "fulfilled").length, 1);
    const active = (await t.ledger(f.a)).active!;
    assert.equal(
      active.started_at,
      new Date(f.now).toISOString().replace(".000Z", "+00:00"),
    );
    await advance(f, 2);
    await timerAction(f, "PAUSE");
    const paused = (await t.ledger(f.a)).active!;
    const resume = {
      command: "RESUME",
      timerId: paused.id,
      timerVersion: paused.timer_version,
      operationKey: key(),
    };
    const competing = { ...resume, operationKey: key() };
    const attempts = await Promise.allSettled([
      t.timer(f.a, resume),
      t.timer(f.a, competing),
    ]);
    assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await t.ledger(f.a)).items.length, 2);
    const winner = attempts[0].status === "fulfilled" ? resume : competing;
    assert.equal(await t.timer(f.a, winner), paused.id);
    await assert.rejects(t.timer(f.a, { ...winner, command: "STOP" }), {
      status: 409,
    });
  } finally {
    await f.cleanup();
  }
});

test("duty revoke stops active time, preserves own evidence, and invalidates the old scope", async () => {
  const f = await timeFixture();
  try {
    const { shift, root } = await clockAndStart(f, f.task);
    await advance(f, 14);
    await mutateDuty(await session(f.tokens.admin), {
      employeeIds: [f.ids.a],
      date: f.day,
      action: "REVOKE",
      reason,
    });
    await assert.rejects(t.ledger(f.a), { status: 401 });
    const v = (await t.ledger(f.admin, undefined, 0, root)).items[0];
    assert.equal(v.timer_close_reason, "DUTY_REVOKED");
    assert.equal(
      v.ended_at,
      (await a.attendanceDetail(f.admin, shift)).shift.clocked_out_at,
    );
    assert.equal(v.seconds, "14.000000");
  } finally {
    await f.cleanup();
  }
});

test("15.9 exact segment adjustment preserves originals and rejects concurrent stale or overlapping change", async () => {
  const f = await timeFixture();
  try {
    const { shift, root } = await clockAndStart(f, f.task);
    await advance(f, 40);
    await timerAction(f, "STOP");
    await advance(f, 10);
    await clockOut(f, shift);
    const orig = (await t.ledger(f.admin, undefined, 0, root)).items[0];
    const end = new Date(new Date(orig.started_at).getTime() + 20_111)
      .toISOString()
      .replace(".111Z", ".111111Z");
    const proposal = {
      operationKey: key(),
      startedAt: orig.started_at,
      endedAt: end,
      expectedVersion: orig.version,
      expectedTimerVersion: orig.root_version,
      expectedShiftVersion: orig.shift_version,
      reason,
    };
    await freshAdmin(f);
    const results = await Promise.allSettled([
      t.correctSegment(f.admin, root, proposal),
      t.correctSegment(f.admin, root, { ...proposal, operationKey: key() }),
    ]);
    assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
    const edited = await t.ledger(f.admin, undefined, 0, root);
    assert.equal(edited.items[0].seconds, "20.111111");
    assert.equal(edited.items[0].recorded_end, orig.recorded_end);
    assert.equal(edited.adjustments[0].before_end, orig.ended_at);
    await assert.rejects(t.correctSegment(f.a, root, proposal), {
      status: 403,
    });
  } finally {
    await f.cleanup();
  }
});

test("daily report owner/assignment checks, unique date, immutable submitted entries and no invented task completion", async () => {
  const f = await timeFixture();
  try {
    const own = await assignment(f, f.task),
      peer = await assignment(f, f.task, "b");
    const save = {
      action: "SAVE",
      notes: "Worked on the project outline",
      expectedVersion: 0,
      operationKey: key(),
    };
    const report = await t.changeDaily(f.a, f.day, save);
    assert.equal(await t.changeDaily(f.a, f.day, save), report);
    const entry = {
      action: "ENTRY",
      assignmentId: own.id,
      expectedVersion: 1,
      description: "Employee reported",
      reportedComplete: true,
      included: true,
      operationKey: key(),
    };
    await assert.rejects(
      t.changeDaily(f.a, f.day, { ...entry, assignmentId: peer.id }),
      { status: 404 },
    );
    await t.changeDaily(f.a, f.day, entry);
    await t.changeDaily(f.a, f.day, {
      action: "SUBMIT",
      expectedVersion: 2,
      operationKey: key(),
    });
    const result = await t.readDaily(f.a, f.day);
    assert.equal(result.report?.state, "SUBMITTED");
    assert.equal(result.entries.length, 1);
    await assert.rejects(
      t.changeDaily(f.a, f.day, {
        ...save,
        expectedVersion: 3,
        operationKey: key(),
      }),
      { status: 409 },
    );
    await assert.rejects(t.readDaily(f.b, f.day, f.ids.a), { status: 404 });
    await runtime(f.duty.b.token, async (c) => {
      assert.equal(
        (await c.query("SELECT id FROM daily_reports WHERE id=$1", [report]))
          .rowCount,
        0,
      );
      assert.equal(
        (
          await c.query(
            "SELECT id FROM daily_report_entries WHERE report_id=$1",
            [report],
          )
        ).rowCount,
        0,
      );
    });
    assert.equal(
      (
        await f.owner.query("SELECT status FROM task_assignments WHERE id=$1", [
          own.id,
        ])
      ).rows[0].status,
      "PENDING",
    );
    assert.equal((await t.ledger(f.a)).items.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("Submit stops the timer in the same transaction and revision work binds the precise review", async () => {
  const f = await timeFixture();
  try {
    const { root } = await clockAndStart(f, f.task);
    const own = await assignment(f, f.task);
    const draft = await submissions.createDraft(f.a, own.id, {
      creationKey: key(),
    });
    await advance(f, 17);
    await assert.rejects(
      submissions.submitDraft(f.a, draft.id, { expectedVersion: 1 }),
      { status: 400 },
    );
    assert.equal((await t.ledger(f.a)).active?.id, root);
    await submissions.submitDraft(f.a, draft.id, {
      expectedVersion: 1,
      content: { notes: "Actual test deliverable" },
    });
    const stopped = await t.segmentDetail(f.a, root);
    const sub = await submissions.submission(f.a, draft.id);
    assert.equal(stopped.timer_close_reason, "SUBMITTED");
    assert.equal(Date.parse(stopped.ended_at!), sub.submitted_at!.getTime());
    const reviewed = await submissions.review(f.admin, draft.id, {
      expectedVersion: sub.version,
      decision: "REVISION_REQUIRED",
      reason,
    });
    await advance(f, 3);
    const version = await assignment(f, f.task);
    const rework = await t.timer(f.a, {
      command: "START",
      assignmentId: own.id,
      assignmentVersion: version.version,
      operationKey: key(),
      kind: "ORIGINAL",
      revisionReviewId: key(),
      startedAt: "2000-01-01T00:00:00Z",
      elapsed: 7000,
    });
    const revised = await t.segmentDetail(f.a, rework);
    assert.equal(revised.kind, "REVISION");
    assert.equal(revised.revision_review_id, reviewed.id);
    assert.equal(Date.parse(revised.recorded_start), f.now.getTime());
    await advance(f, 23);
    const second = await submissions.createDraft(f.a, own.id, {
      creationKey: key(),
      notes: "Reworked test delivery",
    });
    await submissions.submitDraft(f.a, second.id, { expectedVersion: 1 });
    const submitted = await submissions.submission(f.a, second.id);
    await submissions.review(f.admin, second.id, {
      expectedVersion: submitted.version,
      decision: "APPROVED",
      reason,
    });
    await assert.rejects(startTimer(f, f.task), { status: 409 });
    const [row] = (await t.report(f.a, { from: f.day, view: "tasks" })).rows;
    assert.equal(row.original_seconds, "17.000000");
    assert.equal(row.revision_seconds, "23.000000");
  } finally {
    await f.cleanup();
  }
});

test("withdrawal, task cancellation and project hold stop timers; restore never restarts", async () => {
  const f = await timeFixture();
  try {
    const x = await clockAndStart(f, f.task);
    const y = await clockAndStart(f, f.task, "b");
    await advance(f, 5);
    await timerAction(f, "PAUSE", "b");
    const taskVersion = async () =>
      (await f.owner.query("SELECT version FROM tasks WHERE id=$1", [f.task]))
        .rows[0].version;
    const projectVersion = async () =>
      (
        await f.owner.query("SELECT version FROM projects WHERE id=$1", [
          f.projectId,
        ])
      ).rows[0].version;
    await work.membership(f.admin, f.task, {
      expectedVersion: await taskVersion(),
      add: [],
      remove: [f.ids.a],
      reason,
    });
    assert.equal(
      (await t.segmentDetail(f.a, x.root)).timer_close_reason,
      "ASSIGNMENT_WITHDRAWN",
    );
    assert.equal((await t.ledger(f.b)).active?.id, y.root);
    assert.ok((await a.currentAttendance(f.a)).active);
    const report = await t.readDaily(f.a, f.day);
    assert.equal(
      report.options.find((x) => x.task_label.includes(f.suffix))
        ?.captured_status,
      "RECORDED_TIME",
    );
    await work.membership(f.admin, f.task, {
      expectedVersion: await taskVersion(),
      add: [f.ids.a],
      remove: [],
      reason,
    });
    assert.equal((await t.ledger(f.a)).active, null);
    await work.progress(f.admin, f.task, {
      expectedVersion: await taskVersion(),
      status: "CANCELLED",
      reason,
    });
    assert.equal(
      (await t.segmentDetail(f.b, y.root)).timer_close_reason,
      "TASK_CANCELLED",
    );
    await work.progress(f.admin, f.task, {
      expectedVersion: await taskVersion(),
      status: "PENDING",
      reason,
    });
    const z = await startTimer(f, f.task);
    await advance(f, 7);
    await work.editProject(f.admin, f.projectId, {
      expectedVersion: await projectVersion(),
      status: "ON_HOLD",
      reason,
    });
    assert.equal(
      (await t.segmentDetail(f.a, z)).timer_close_reason,
      "PROJECT_LEFT_ACTIVE",
    );
    await work.editProject(f.admin, f.projectId, {
      expectedVersion: await projectVersion(),
      status: "ACTIVE",
      reason,
    });
    assert.equal((await t.ledger(f.a)).active, null);
  } finally {
    await f.cleanup();
  }
});

test("account disable and inactive employment stop running and paused timers at shift closure", async () => {
  const f = await timeFixture();
  try {
    const one = await clockAndStart(f, f.task),
      two = await clockAndStart(f, f.task, "b");
    await advance(f, 3);
    await timerAction(f, "PAUSE", "b");
    await advance(f, 4);
    await f.owner.query(
      "UPDATE users SET disabled_at=private.security_now() WHERE id=$1",
      [f.ids.a],
    );
    await f.owner.query(
      "UPDATE employee_profiles SET employment_status='INACTIVE' WHERE user_id=$1",
      [f.ids.b],
    );
    for (const x of [one, two]) {
      const saved = await t.segmentDetail(f.admin, x.root);
      const shift = (await a.attendanceDetail(f.admin, x.shift)).shift;
      assert.equal(saved.root_state, "STOPPED");
      assert.equal(saved.timer_close_reason, shift.close_reason);
      assert.equal(
        (
          await f.owner.query(
            "SELECT timer_closed_at=\$2 AS same FROM task_time_segments WHERE id=\$1",
            [x.root, shift.clocked_out_at],
          )
        ).rows[0].same,
        true,
      );
    }
    await assert.rejects(t.ledger(f.a), { status: 401 });
    await assert.rejects(t.ledger(f.b), { status: 401 });
  } finally {
    await f.cleanup();
  }
});

test("combined attendance and segment correction commits together or rolls back without clipping", async () => {
  const f = await timeFixture();
  try {
    const { shift, root } = await clockAndStart(f, f.task);
    await advance(f, 80);
    await timerAction(f, "STOP");
    await advance(f, 40);
    await clockOut(f, shift);
    const original = await t.segmentDetail(f.admin, root);
    const endAt = (offset: number) =>
      new Date(Date.parse(original.started_at) + offset * 1000).toISOString();
    const attendance = (await a.attendanceDetail(f.a, shift)).shift;
    const request = await a.requestAttendanceCorrection(f.a, {
      kind: "AMEND_SHIFT",
      shiftId: shift,
      expectedVersion: attendance.version,
      operationKey: key(),
      reason,
      proposed: {
        clockedInAt: attendance.clocked_in_at,
        clockedOutAt: endAt(60),
      },
    });
    const review = {
      decision: "APPROVED",
      expectedVersion: 1,
      reason,
      operationKey: key(),
    };
    await freshAdmin(f);
    await assert.rejects(
      a.decideAttendanceCorrection(f.admin, request, review),
      { status: 409 },
    );
    assert.equal(
      (await a.attendanceDetail(f.admin, shift)).shift.clocked_out_at,
      attendance.clocked_out_at,
    );
    const combined = {
      ...review,
      segments: [
        {
          segmentId: root,
          operationKey: key(),
          expectedVersion: original.version,
          expectedTimerVersion: original.root_version,
          startedAt: original.started_at,
          endedAt: endAt(55),
          reason,
        },
      ],
    };
    await a.decideAttendanceCorrection(f.admin, request, combined);
    await a.decideAttendanceCorrection(f.admin, request, combined);
    const edited = await t.segmentDetail(f.admin, root);
    assert.equal(edited.seconds, "55.000000");
    assert.equal(edited.recorded_end, original.recorded_end);
    assert.equal(
      (
        await f.owner.query(
          "SELECT attendance_adjustment_id FROM task_segment_adjustments WHERE segment_id=$1",
          [root],
        )
      ).rows[0].attendance_adjustment_id,
      request,
    );
  } finally {
    await f.cleanup();
  }
});

test("15.7 exact 8h attendance, 6h task, 2h gap in reports/live/CSV; no approval is created", async () => {
  const f = await timeFixture();
  try {
    const { shift } = await clockAndStart(f, f.task);
    await advance(f, 6 * 3600);
    await freshDuty(f);
    await timerAction(f, "STOP");
    await advance(f, 2 * 3600);
    await clockOut(f, shift);
    await freshAdmin(f);
    const filters = { from: f.day, employeeId: f.ids.a };
    const [summary] = (await t.report(f.admin, filters)).rows;
    assert.equal(summary.attendance_seconds, "28800.000000");
    assert.equal(summary.task_seconds, "21600.000000");
    assert.equal(summary.gap_seconds, "7200.000000");
    const row = (await t.live(f.admin)).items.find(
      (x) => x.employee_id === f.ids.a,
    );
    // Large retained test databases may need additional pages.
    const liveRow =
      row ??
      (await (async () => {
        for (let skip = 100; skip <= 50000; skip += 100) {
          const p = (await t.live(f.admin, skip)).items;
          const employee = p.find((x) => x.employee_id === f.ids.a);
          if (employee || p.length <= 100) return employee;
        }
      })());
    assert.equal(liveRow?.attendance_seconds, "28800.000000");
    assert.equal(liveRow?.original_seconds, "21600.000000");
    assert.equal(liveRow?.current_task, null);
    const csv = await (await t.reportCsv(f.admin, filters)).text();
    assert.match(
      csv,
      /"28800\.000000","0","0","21600\.000000","0","21600\.000000","7200\.000000"/,
    );
    assert.equal(
      (await a.attendanceDetail(f.admin, shift)).shift.approved_payable_seconds,
      null,
    );
    await freshDuty(f, "b");
    await assert.rejects(t.report(f.b, { from: f.day, employeeId: f.ids.a }), {
      status: 404,
    });
  } finally {
    await f.cleanup();
  }
});

test("project hold racing a first Start rechecks the live roster before writing", async () => {
  const f = await timeFixture();
  try {
    await clockIn(f);
    const own = await assignment(f, f.task);
    const project = (
      await f.owner.query("SELECT version FROM projects WHERE id=$1", [
        f.projectId,
      ])
    ).rows[0];
    await f.owner.query("BEGIN");
    await f.owner.query("SELECT id FROM projects WHERE id=$1 FOR UPDATE", [
      f.projectId,
    ]);
    const start = t
      .timer(f.a, {
        command: "START",
        assignmentId: own.id,
        assignmentVersion: own.version,
        operationKey: key(),
      })
      .then(
        (id) => ({ id, error: null }),
        (error) => ({ id: null, error }),
      );
    await blocked(f.owner, "private.timer_command");
    const input = {
      expectedVersion: project.version,
      status: "ON_HOLD",
      reason,
    };
    const edit = work.editProject(f.admin, f.projectId, input).then(
      () => null,
      (error) => error,
    );
    await blocked(f.owner, "private.edit_project");
    await f.owner.query("COMMIT");
    const started = await start;
    assert.equal(started.error, null);
    assert.equal((await edit)?.status, 409);
    await work.editProject(f.admin, f.projectId, input);
    assert.equal(
      (await t.segmentDetail(f.a, started.id!)).timer_close_reason,
      "PROJECT_LEFT_ACTIVE",
    );
  } finally {
    await f.owner.query("ROLLBACK");
    await f.cleanup();
  }
});

test("revocation queued before Start wins the employee lock; no timer survives or appears", async () => {
  const f = await timeFixture();
  try {
    const shift = await clockIn(f);
    const own = await assignment(f, f.task);
    const admin = await session(f.tokens.admin);
    await f.owner.query("BEGIN");
    await f.owner.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
      f.ids.a,
    ]);
    const revoke = mutateDuty(admin, {
      employeeIds: [f.ids.a],
      date: f.day,
      action: "REVOKE",
      reason,
    }).then(
      () => null,
      (e) => e,
    );
    await blocked(f.owner, "private.mutate_duty");
    const start = t
      .timer(f.a, {
        command: "START",
        assignmentId: own.id,
        assignmentVersion: own.version,
        operationKey: key(),
      })
      .then(
        () => null,
        (e) => e,
      );
    await blocked(f.owner, "private.timer_command");
    await f.owner.query("COMMIT");
    assert.equal(await revoke, null);
    assert.ok([401, 403].includes((await start)?.status));
    assert.equal((await t.shiftSegments(f.admin, shift)).length, 0);
  } finally {
    await f.owner.query("ROLLBACK");
    await f.cleanup();
  }
});

test("Start queued before revocation records one root that revocation stops atomically", async () => {
  const f = await timeFixture();
  try {
    const shift = await clockIn(f);
    const own = await assignment(f, f.task);
    const admin = await session(f.tokens.admin);
    await f.owner.query("BEGIN");
    await f.owner.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
      f.ids.a,
    ]);
    const start = t
      .timer(f.a, {
        command: "START",
        assignmentId: own.id,
        assignmentVersion: own.version,
        operationKey: key(),
      })
      .then(
        (id) => ({ id, error: null }),
        (error) => ({ id: null, error }),
      );
    await blocked(f.owner, "private.timer_command");
    const revoke = mutateDuty(admin, {
      employeeIds: [f.ids.a],
      date: f.day,
      action: "REVOKE",
      reason,
    }).then(
      () => null,
      (e) => e,
    );
    await blocked(f.owner, "private.mutate_duty");
    await f.owner.query("COMMIT");
    assert.equal((await start).error, null);
    assert.equal(await revoke, null);
    const rows = await t.shiftSegments(f.admin, shift);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].root_state, "STOPPED");
    assert.equal(rows[0].timer_close_reason, "DUTY_REVOKED");
    assert.equal(rows[0].seconds, "0");
  } finally {
    await f.owner.query("ROLLBACK");
    await f.cleanup();
  }
});

test("database rejects foreign timer children, invented revisions and inconsistent root state", async () => {
  const f = await timeFixture();
  try {
    const { root } = await clockAndStart(f, f.task);
    const other = await assignment(f, f.task, "b");
    await assert.rejects(
      f.owner.query(
        "UPDATE task_time_segments SET timer_state='PAUSED' WHERE id=$1",
        [root],
      ),
      { code: "23514" },
    );
    const clone = `INSERT INTO task_time_segments(employee_id,assignment_id,task_id,shift_id,timer_id,segment_sequence,kind,revision_review_id,
   policy_id,task_label,project_label,recorded_start,recorded_end,started_at,ended_at,observed_end,end_reason)
   SELECT employee_id,$2,task_id,shift_id,id,2,$3,$4,policy_id,task_label,project_label,
    recorded_start,recorded_start,started_at,started_at,recorded_start,'TEST' FROM task_time_segments WHERE id=$1`;
    await assert.rejects(
      f.owner.query(clone, [root, other.id, "ORIGINAL", null]),
      { code: "23503" },
    );
    await assert.rejects(
      f.owner.query(clone, [
        root,
        (await assignment(f, f.task)).id,
        "REVISION",
        key(),
      ]),
      { code: "23503" },
    );
    assert.equal((await t.ledger(f.a)).active?.timer_state, "RUNNING");
  } finally {
    await f.cleanup();
  }
});

test("daily reports reject future or empty submissions, support non-work notes and enforce entry bounds", async () => {
  const f = await timeFixture();
  try {
    const future = new Date(Date.parse(f.day + "T00:00:00Z") + 86400000)
      .toISOString()
      .slice(0, 10);
    await assert.rejects(
      t.changeDaily(f.a, future, {
        action: "SAVE",
        expectedVersion: 0,
        operationKey: key(),
      }),
      { status: 400 },
    );
    await t.changeDaily(f.a, f.day, {
      action: "SAVE",
      expectedVersion: 0,
      operationKey: key(),
    });
    await assert.rejects(
      t.changeDaily(f.a, f.day, {
        action: "SUBMIT",
        expectedVersion: 1,
        operationKey: key(),
      }),
      { status: 400 },
    );
    await t.changeDaily(f.a, f.day, {
      action: "SAVE",
      expectedVersion: 1,
      operationKey: key(),
      issues: "Access issue prevented starting today's task",
    });
    await t.changeDaily(f.a, f.day, {
      action: "SUBMIT",
      expectedVersion: 2,
      operationKey: key(),
    });
    assert.equal((await t.readDaily(f.a, f.day)).report?.state, "SUBMITTED");
    assert.equal((await t.readDaily(f.a, f.day)).entries.length, 0);
    const settings = (await t.ledger(f.admin)).configuration;
    await t.changeTimeSettings(f.admin, {
      expectedPolicyId: settings.policyId,
      reason,
      rules: {
        timers: settings.timers,
        reports: { ...settings.reports, maxEntries: 1 },
      },
    });
    const task = await sharedTask(f);
    await t.changeDaily(f.b, f.day, {
      action: "SAVE",
      expectedVersion: 0,
      operationKey: key(),
    });
    const entry = {
      action: "ENTRY",
      assignmentId: (await assignment(f, f.task, "b")).id,
      description: "Verified entry",
      reportedComplete: false,
      included: true,
    };
    await t.changeDaily(f.b, f.day, {
      ...entry,
      expectedVersion: 1,
      operationKey: key(),
    });
    await assert.rejects(
      t.changeDaily(f.b, f.day, {
        ...entry,
        assignmentId: (await assignment(f, task, "b")).id,
        expectedVersion: 2,
        operationKey: key(),
      }),
      { status: 400 },
    );
  } finally {
    await f.cleanup();
  }
});

test("segment corrections cannot overlap another segment or a break, and original rows resist direct rewrites", async () => {
  const f = await timeFixture();
  try {
    const { shift, root } = await clockAndStart(f, f.task);
    const timeAt = (n: number) =>
      new Date(f.now.getTime() + n * 1000).toISOString();
    const insideBreak = timeAt(15),
      pastOther = timeAt(30);
    await advance(f, 10);
    const punch = await a.attendanceDetail(f.a, shift);
    const b = await a.attendanceCommand(f.a, "BREAK_START", shift, {
      expectedVersion: punch.shift.version,
      operationKey: key(),
      code: "SHORT",
    });
    await advance(f, 10);
    await a.attendanceCommand(f.a, "BREAK_END", b, {
      expectedVersion: 1,
      operationKey: key(),
    });
    await timerAction(f, "RESUME");
    await advance(f, 20);
    await clockOut(f, shift);
    await freshAdmin(f);
    const s = await t.segmentDetail(f.admin, root);
    const change = {
      operationKey: key(),
      expectedVersion: s.version,
      expectedTimerVersion: s.root_version,
      expectedShiftVersion: s.shift_version,
      startedAt: s.started_at,
      endedAt: insideBreak,
      reason,
    };
    await assert.rejects(t.correctSegment(f.admin, root, change), {
      status: 409,
    });
    await assert.rejects(
      t.correctSegment(f.admin, root, { ...change, endedAt: pastOther }),
      { status: 409 },
    );
    await assert.rejects(
      f.owner.query(
        "UPDATE task_time_segments SET recorded_start=recorded_start-interval '1 second' WHERE id=$1",
        [root],
      ),
      { code: "23514" },
    );
    await assert.rejects(
      f.owner.query(
        "UPDATE task_time_segments SET ended_at=ended_at+interval '1 second' WHERE id=$1",
        [root],
      ),
      { code: "23514" },
    );
    assert.equal((await t.segmentDetail(f.admin, root)).seconds, "10.000000");
    assert.equal(
      (await t.ledger(f.admin, undefined, 0, root)).adjustments.length,
      0,
    );
  } finally {
    await f.cleanup();
  }
});

test("exact grant boundary reconciles elapsed running time after downtime and stops a paused root", async () => {
  const f = await timeFixture();
  try {
    f.now = new Date(f.day + "T21:45:00+08:00");
    await freeze(f.owner, f.now);
    await freshDuty(f);
    await freshDuty(f, "b");
    f.now = new Date(f.day + "T23:59:10.777+08:00");
    await freeze(f.owner, f.now);
    const one = await clockAndStart(f, f.task),
      two = await clockAndStart(f, f.task, "b");
    await advance(f, 10);
    await timerAction(f, "PAUSE", "b");
    await advance(f, 180);
    await freshAdmin(f);
    assert.equal(
      (await t.segmentDetail(f.admin, one.root)).seconds,
      "49.223000",
    );
    await a.reconcileAttendance(f.admin);
    const first = await t.segmentDetail(f.admin, one.root);
    const second = await t.segmentDetail(f.admin, two.root);
    assert.equal(first.seconds, "49.223000");
    assert.equal(first.timer_close_reason, "DUTY_WINDOW_EXPIRED");
    assert.equal(second.seconds, "10.000000");
    assert.equal(second.root_state, "STOPPED");
    assert.equal(
      first.ended_at,
      (await a.attendanceDetail(f.admin, one.shift)).shift.clocked_out_at,
    );
  } finally {
    await f.cleanup();
  }
});

test("report bounds reject overflow and CSV aborts on revoked access between chunks", async () => {
  const f = await timeFixture();
  try {
    const project = (
      await work.createProject(f.admin, {
        creationKey: key(),
        code: "T-" + f.suffix,
        name: '=SUM("test",1)',
      })
    ).id;
    const task = await sharedTask(f, { projectId: project });
    const { root, shift } = await clockAndStart(f, task);
    await advance(f, 100);
    await clockOut(f, shift);
    // Add disjoint zero-free test intervals in the unused part of a closed shift.
    // Shift and timer ownership constraints remain enabled for the fixture.
    await advance(f, 200);
    await freshAdmin(f);
    const record = await t.segmentDetail(f.admin, root);
    await t.correctSegment(f.admin, root, {
      operationKey: key(),
      expectedVersion: record.version,
      expectedTimerVersion: record.root_version,
      expectedShiftVersion: record.shift_version,
      startedAt: record.started_at,
      endedAt: new Date(Date.parse(record.started_at) + 1000).toISOString(),
      reason,
    });
    await f.owner.query(
      `INSERT INTO task_time_segments(employee_id,assignment_id,task_id,shift_id,timer_id,segment_sequence,kind,policy_id,task_label,project_label,
   recorded_start,recorded_end,started_at,ended_at,observed_end,end_reason)
   SELECT r.employee_id,r.assignment_id,r.task_id,r.shift_id,r.id,n+1,r.kind,r.policy_id,r.task_label,r.project_label,
    r.recorded_start+make_interval(secs=>n*2),r.recorded_start+make_interval(secs=>n*2+1),
    r.recorded_start+make_interval(secs=>n*2),r.recorded_start+make_interval(secs=>n*2+1),
    r.recorded_start+make_interval(secs=>n*2+1),'TEST_FIXTURE'
   FROM task_time_segments r CROSS JOIN generate_series(1,34) n WHERE r.id=$1`,
      [root],
    );
    const filters = { from: f.day, view: "segments" };
    const reader = (await t.reportCsv(f.a, filters)).body!.getReader();
    const first = await reader.read();
    assert.match(
      new TextDecoder().decode(first.value),
      /"'=SUM\(""test"",1\)"/,
    );
    await mutateDuty(await session(f.tokens.admin), {
      employeeIds: [f.ids.a],
      date: f.day,
      action: "REVOKE",
      reason,
    });
    await assert.rejects(reader.read(), { status: 401 });
    await assert.rejects(
      t.report(f.admin, { from: "2026-01-01", to: "2026-02-01" }),
      { status: 400 },
    );
    assert.equal(
      (await t.report(f.admin, { from: "2026-01-01", to: "2026-01-31" })).rows
        .length,
      0,
    );
    const settings = (await t.ledger(f.admin)).configuration;
    await t.changeTimeSettings(f.admin, {
      expectedPolicyId: settings.policyId,
      reason,
      rules: {
        timers: settings.timers,
        reports: { ...settings.reports, maxRows: 2 },
      },
    });
    await assert.rejects(
      t.reportCsv(f.admin, { ...filters, employeeId: f.ids.a }),
      { status: 400 },
    );
  } finally {
    await f.cleanup();
  }
});

test("15.12 exact overnight/day/week/year splits and paused rollover retain the original duty date", async () => {
  const year = new Date().getUTCFullYear() + 1;
  const first = `${year}-12-31`,
    next = `${year + 1}-01-01`;
  const f = await timeFixture(first);
  try {
    const cfg = (
      await f.owner.query(
        "SELECT p.configuration FROM company_settings c JOIN policy_versions p ON p.id=c.work_policy_id",
      )
    ).rows[0].configuration;
    await setPolicy(f, "WORK", {
      ...cfg,
      overnightEnabled: true,
      overnightCarryHours: 8,
    });
    const admin = await session(f.tokens.admin);
    await mutateDuty(admin, {
      employeeIds: [f.ids.a],
      date: f.day,
      action: "REVOKE",
      reason,
    });
    await mutateDuty(admin, {
      employeeIds: [f.ids.a],
      date: f.day,
      action: "REGRANT",
      reason,
      overnight: true,
      validUntil: next + "T08:00:00+08:00",
    });
    const network = digest(key());
    const ch = await startDuty(f.tokens.a, f.day, f.password, false, network);
    const issued = await completeDutyStage(
      f.tokens.a,
      ch.challenge,
      "TOTP",
      otp(f.duty.a.secret, f.now.getTime()),
      network,
    );
    assert.equal(issued.kind, "SESSION");
    if (issued.kind !== "SESSION") throw Error("Expected a duty session");
    f.duty.a.token = issued.token;
    f.a = await workSession(undefined, issued.token);
    // Refresh the same grant before the absolute limit, then continue after midnight.
    f.now = new Date(first + "T21:45:00+08:00");
    await freeze(f.owner, f.now);
    await freshDuty(f);
    f.now = new Date(first + "T23:30:00.123+08:00");
    await freeze(f.owner, f.now);
    await freshDuty(f);
    const { shift, root } = await clockAndStart(f, f.task);
    f.now = new Date(next + "T00:30:00.456+08:00");
    await freeze(f.owner, f.now);
    await assert.rejects(t.ledger(f.a), { status: 401 });
    await freshDuty(f);
    await timerAction(f, "PAUSE");
    await advance(f, 120);
    assert.equal((await t.ledger(f.a)).active?.seconds, "3600.333000");
    await timerAction(f, "RESUME");
    await advance(f, 60.777);
    await clockOut(f, shift);
    const total = (await t.ledger(f.a, undefined, 0, root)).items.reduce(
      (n, s) => n.plus(s.seconds),
      new Decimal(0),
    );
    const daily = (
      await t.report(f.a, { from: first, to: next, view: "segments" })
    ).rows;
    assert.deepEqual([...new Set(daily.map((r) => r.period))], [first, next]);
    assert.ok(daily.every((r) => r.duty_date === first));
    assert.equal(
      daily
        .reduce((n, r) => n.plus(String(r.seconds)), new Decimal(0))
        .toFixed(6),
      total.toFixed(6),
    );
    await freshAdmin(f);
    const settings = (await t.ledger(f.admin)).configuration;
    await t.changeTimeSettings(f.admin, {
      expectedPolicyId: settings.policyId,
      reason,
      rules: {
        timers: settings.timers,
        reports: {
          ...settings.reports,
          weekStartsOn: new Date(next + "T00:00:00Z").getUTCDay() || 7,
        },
      },
    });
    const weekly = (
      await t.report(f.a, {
        from: first,
        to: next,
        grain: "week",
        view: "segments",
      })
    ).rows;
    assert.equal(new Set(weekly.map((r) => r.period)).size, 2);
    assert.equal(
      weekly
        .reduce((n, r) => n.plus(String(r.seconds)), new Decimal(0))
        .toFixed(6),
      total.toFixed(6),
    );
    const repeat = await clockAndStart(f, f.task);
    assert.notEqual(repeat.root, root);
    assert.notEqual(repeat.shift, shift);
    await t.changeDaily(f.a, next, {
      action: "SAVE",
      expectedVersion: 0,
      operationKey: key(),
      notes: "Report for the actual Manila date",
    });
    assert.equal((await t.readDaily(f.a, next)).date, next);
  } finally {
    await f.cleanup();
  }
});
