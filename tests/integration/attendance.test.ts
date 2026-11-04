import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  attendanceFixture,
  advance,
  clockIn,
  clockOut,
  freshAdmin,
  freshDuty,
} from "../attendance-helpers";
import * as a from "../../src/server/services/attendance";
import { db, authPool } from "../../src/server/db";
import { session } from "../../src/server/auth/service";
import { digest } from "../helpers";
import { setPolicy, freeze } from "../duty-helpers";
import { startDuty, completeDutyStage } from "../../src/server/auth/duty";
import { otp } from "../../src/lib/mfa-crypto";
import { workSession } from "../../src/server/dal/work";
import { runtime, blocked } from "../work-helpers";
import { mutateDuty } from "../../src/server/services/duty";
const reason = "Verified actual attendance with the employee";
after(async () => {
  await db.$disconnect();
  await authPool.end();
});
test("explicit clocks and MEAL/SHORT events use exact server time; suggestion is not approval, override bounded/reasoned", async () => {
  const f = await attendanceFixture();
  try {
    assert.equal((await a.currentAttendance(f.a)).active, null);
    const key = randomUUID(),
      id = await clockIn(f, "a", key);
    assert.equal(await clockIn(f, "a", key), id);
    let s = await a.attendanceDetail(f.a, id);
    assert.equal(
      s.shift.clocked_in_at,
      new Date(f.now).toISOString().replace(".000Z", "+00:00"),
    );
    await advance(f, 600);
    let bid = await a.attendanceCommand(f.a, "BREAK_START", id, {
      operationKey: randomUUID(),
      expectedVersion: s.shift.version,
      code: "MEAL",
    });
    await advance(f, 600);
    let b = (await a.attendanceDetail(f.a, id)).breaks.find(
      (b) => b.id === bid,
    )!;
    await a.attendanceCommand(f.a, "BREAK_END", bid, {
      operationKey: randomUUID(),
      expectedVersion: b.version,
    });
    s = await a.attendanceDetail(f.a, id);
    bid = await a.attendanceCommand(f.a, "BREAK_START", id, {
      operationKey: randomUUID(),
      expectedVersion: s.shift.version,
      code: "SHORT",
    });
    await advance(f, 300);
    await clockOut(f, id);
    s = await a.attendanceDetail(f.a, id);
    assert.equal(s.grossSeconds, "1500.000000");
    assert.equal(s.unpaidBreakSeconds, "600.000000");
    assert.equal(s.paidBreakSeconds, "300.000000");
    assert.equal(s.suggestedSeconds, "900.000000");
    assert.equal(s.shift.approved_payable_seconds, null);
    assert.equal(
      s.breaks.find((b) => b.id === bid)!.ended_at,
      s.shift.clocked_out_at,
    );
    assert.deepEqual(s.flags, []);
    const closeAudit = (
      await f.owner.query(
        "SELECT actor_user_id,payload FROM audit_log WHERE action='attendance.clock_out' AND payload->>'shift_id'=$1",
        [id],
      )
    ).rows[0];
    assert.equal(closeAudit.actor_user_id, f.ids.a);
    assert.equal(closeAudit.payload.before.shift.clocked_out_at, null);
    assert.equal(
      closeAudit.payload.after.shift.clocked_out_at,
      s.shift.clocked_out_at,
    );
    await freshAdmin(f);
    await a.reviewAttendance(f.admin, id, {
      operationKey: randomUUID(),
      expectedVersion: s.shift.version,
      decision: "APPROVED",
    });
    s = await a.attendanceDetail(f.a, id);
    assert.equal(s.shift.approved_payable_seconds, "900.000000");
    await assert.rejects(() =>
      a.reviewAttendance(f.admin, id, {
        operationKey: randomUUID(),
        expectedVersion: s.shift.version,
        decision: "APPROVED",
        mode: "OVERRIDE",
        value: "1600",
        reason,
      }),
    );
    await assert.rejects(() =>
      a.reviewAttendance(f.admin, id, {
        operationKey: randomUUID(),
        expectedVersion: s.shift.version,
        decision: "APPROVED",
        mode: "OVERRIDE",
        value: "1400",
        reason: "short",
      }),
    );
    await a.reviewAttendance(f.admin, id, {
      operationKey: randomUUID(),
      expectedVersion: s.shift.version,
      decision: "APPROVED",
      mode: "OVERRIDE",
      value: "1400",
      reason,
    });
    assert.equal(
      (await a.attendanceDetail(f.a, id)).shift.approved_payable_seconds,
      "1400.000000",
    );
  } finally {
    await f.cleanup();
  }
});
test("DUTY-only RLS isolates shifts, breaks and corrections; direct mutations/foreign IDs are denied", async () => {
  const f = await attendanceFixture();
  try {
    const id = await clockIn(f);
    const active = await a.attendanceDetail(f.a, id);
    const breakId = await a.attendanceCommand(f.a, "BREAK_START", id, {
      operationKey: randomUUID(),
      expectedVersion: active.shift.version,
      code: "SHORT",
    });
    await advance(f, 60);
    await clockOut(f, id);
    const row = await a.attendanceDetail(f.a, id);
    const request = await a.requestAttendanceCorrection(f.a, {
      operationKey: randomUUID(),
      kind: "AMEND_SHIFT",
      shiftId: id,
      expectedVersion: row.shift.version,
      reason,
      proposed: {
        clockedInAt: row.shift.clocked_in_at,
        clockedOutAt: row.shift.clocked_out_at,
      },
    });
    await assert.rejects(
      () => a.attendanceDetail(f.b, id),
      (e) => (e as any).status === 404,
    );
    await assert.rejects(
      () =>
        a.attendanceCommand(f.b, "CLOCK_OUT", id, {
          operationKey: randomUUID(),
          expectedVersion: row.shift.version,
        }),
      (e) => (e as any).status === 404,
    );
    await assert.rejects(
      () =>
        a.listAttendance(f.b, { from: f.day, to: f.day, employeeId: f.ids.a }),
      (e) => (e as any).status === 404,
    );
    for (const token of [f.duty.b.token, f.tokens.a])
      await runtime(token, async (c) => {
        assert.equal(
          (
            await c.query("SELECT id FROM attendance_breaks WHERE id=$1", [
              breakId,
            ])
          ).rowCount,
          0,
        );
        assert.equal(
          (await c.query("SELECT id FROM attendance_shifts WHERE id=$1", [id]))
            .rowCount,
          0,
        );
        assert.equal(
          (
            await c.query("SELECT id FROM attendance_adjustments WHERE id=$1", [
              request,
            ])
          ).rowCount,
          0,
        );
        await assert.rejects(() =>
          c.query(
            "UPDATE attendance_shifts SET approved_payable_seconds=999 WHERE id=$1",
            [id],
          ),
        );
      });
    assert.equal((await a.attendanceDetail(f.admin, id)).shift.id, id);
    await runtime(f.duty.a.token, async (c) =>
      assert.equal(
        (
          await c.query("SELECT id FROM attendance_breaks WHERE id=$1", [
            breakId,
          ])
        ).rowCount,
        1,
      ),
    );
    for (const table of [
      "attendance_shifts",
      "attendance_breaks",
      "attendance_adjustments",
    ])
      await assert.rejects(() => authPool.query(`SELECT id FROM ${table}`));
  } finally {
    await f.cleanup();
  }
});
test("double Clock In serializes; same-key retries are idempotent; multiple adjacent shifts retain distinct numbers", async () => {
  const f = await attendanceFixture();
  try {
    const first = randomUUID(),
      second = randomUUID();
    const r = await Promise.allSettled([
      clockIn(f, "a", first),
      clockIn(f, "a", second),
    ]);
    assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
    const winner = r[0].status === "fulfilled" ? first : second,
      id = (
        r.find(
          (x) => x.status === "fulfilled",
        ) as PromiseFulfilledResult<string>
      ).value;
    assert.equal(await clockIn(f, "a", winner), id);
    assert.equal(
      (
        await f.owner.query(
          "SELECT id FROM attendance_shifts WHERE employee_id=$1",
          [f.ids.a],
        )
      ).rowCount,
      1,
    );
    await clockOut(f, id);
    const next = await clockIn(f);
    assert.notEqual(next, id);
    assert.deepEqual(
      (
        await f.owner.query(
          "SELECT shift_number FROM attendance_shifts WHERE employee_id=$1 ORDER BY shift_number",
          [f.ids.a],
        )
      ).rows.map((x) => x.shift_number),
      [1, 2],
    );
    assert.ok(
      (await a.attendanceDetail(f.a, id)).flags.includes("ZERO_DURATION"),
    );
  } finally {
    await f.cleanup();
  }
});
test("clean bulk approval previews exact suggestions; flags/pending requests excluded; stale batch rolls back and retry never reapproves corrections", async () => {
  const f = await attendanceFixture();
  try {
    const one = await clockIn(f);
    await advance(f, 600);
    await clockOut(f, one);
    const two = await clockIn(f);
    await advance(f, 600);
    await clockOut(f, two);
    await freshAdmin(f);
    const filters = { from: f.day, to: f.day, employeeId: f.ids.a };
    const preview = await a.bulkAttendancePreview(f.admin, filters);
    assert.equal(preview.eligible.length, 1); // Second shift is late relative to its schedule.
    assert.equal(preview.eligible[0].id, one);
    assert.equal(preview.excluded, 1);
    const bad = {
      filters,
      operationKey: randomUUID(),
      expected: [{ id: one, version: preview.eligible[0].version + 1 }],
    };
    await assert.rejects(() => a.bulkApproveAttendance(f.admin, bad));
    assert.equal(
      (await a.attendanceDetail(f.a, one)).shift.approved_payable_seconds,
      null,
    );
    const input = {
      filters,
      operationKey: randomUUID(),
      expected: preview.eligible.map(({ id, version }) => ({ id, version })),
    };
    assert.equal(
      (await a.bulkApproveAttendance(f.admin, input)).replayed,
      false,
    );
    assert.equal(
      (await a.bulkApproveAttendance(f.admin, input)).replayed,
      true,
    );
    const original = await a.attendanceDetail(f.a, one);
    const req = await a.requestAttendanceCorrection(f.a, {
      operationKey: randomUUID(),
      kind: "AMEND_SHIFT",
      shiftId: one,
      expectedVersion: original.shift.version,
      reason,
      proposed: {
        clockedInAt: original.shift.clocked_in_at,
        clockedOutAt: original.shift.clocked_out_at,
      },
    });
    assert.equal(
      (await a.bulkAttendancePreview(f.admin, filters)).eligible.length,
      0,
    );
    const entry = (await a.attendanceCorrections(f.admin, filters)).items.find(
      (x) => x.id === req,
    )!;
    await a.decideAttendanceCorrection(f.admin, req, {
      operationKey: randomUUID(),
      expectedVersion: entry.version,
      decision: "APPROVED",
      reason,
    });
    assert.equal(
      (await a.attendanceDetail(f.a, one)).shift.approved_payable_seconds,
      null,
    );
    assert.equal(
      (await a.bulkApproveAttendance(f.admin, input)).replayed,
      true,
    );
    assert.equal(
      (await a.attendanceDetail(f.a, one)).shift.approved_payable_seconds,
      null,
    );
  } finally {
    await f.cleanup();
  }
});
test("AMEND and ADD_MISSING_SHIFT preserve actual punches, immutable requests/decisions and break ownership; approval invalidated", async () => {
  const f = await attendanceFixture();
  try {
    const id = await clockIn(f);
    await advance(f, 3600);
    await clockOut(f, id);
    await freshAdmin(f);
    let row = await a.attendanceDetail(f.a, id);
    const oldIn = row.shift.recorded_in_at,
      oldOut = row.shift.recorded_out_at;
    await a.reviewAttendance(f.admin, id, {
      operationKey: randomUUID(),
      expectedVersion: row.shift.version,
      decision: "APPROVED",
    });
    row = await a.attendanceDetail(f.a, id);
    const before = await a.requestAttendanceCorrection(f.a, {
      operationKey: randomUUID(),
      kind: "AMEND_SHIFT",
      shiftId: id,
      expectedVersion: row.shift.version,
      reason,
      proposed: {
        clockedInAt: new Date(new Date(oldIn!).getTime() - 60000).toISOString(),
        clockedOutAt: oldOut,
        breaks: [
          {
            code: "MEAL",
            startedAt: new Date(
              new Date(oldIn!).getTime() + 60000,
            ).toISOString(),
            endedAt: new Date(
              new Date(oldIn!).getTime() + 120000,
            ).toISOString(),
          },
        ],
      },
    });
    const original = (
      await a.attendanceCorrections(f.a, { from: f.day, to: f.day })
    ).items.find((x) => x.id === before)!;
    await a.decideAttendanceCorrection(f.admin, before, {
      operationKey: randomUUID(),
      expectedVersion: original.version,
      decision: "APPROVED",
      reason,
    });
    row = await a.attendanceDetail(f.a, id);
    assert.equal(row.shift.recorded_in_at, oldIn);
    assert.equal(row.shift.recorded_out_at, oldOut);
    assert.equal(row.shift.approval_status, "PENDING");
    assert.equal(row.shift.approved_payable_seconds, null);
    assert.equal(row.grossSeconds, "3660.000000");
    assert.equal(row.breaks[0].recorded_start, null);
    const correctionAudit = (
      await f.owner.query(
        "SELECT actor_user_id,occurred_at,payload FROM audit_log WHERE action='attendance.correction_approved' AND payload->>'adjustment_id'=$1",
        [before],
      )
    ).rows[0];
    assert.equal(correctionAudit.actor_user_id, f.ids.admin);
    assert.equal(
      correctionAudit.occurred_at.toISOString(),
      f.now.toISOString(),
    );
    assert.equal(correctionAudit.payload.reason, reason);
    assert.equal(correctionAudit.payload.before.shift.clocked_in_at, oldIn);
    assert.equal(
      correctionAudit.payload.after.shift.clocked_in_at,
      row.shift.clocked_in_at,
    );
    await assert.rejects(() =>
      f.owner.query(
        "UPDATE attendance_shifts SET recorded_in_at=recorded_in_at+interval '1 second' WHERE id=$1",
        [id],
      ),
    );
    await assert.rejects(() =>
      f.owner.query(
        "UPDATE attendance_adjustments SET reason='Changed after review' WHERE id=$1",
        [before],
      ),
    );
    await freshDuty(f, "b");
    const duty = (await a.attendanceDuties(f.b, f.day))[0];
    const add = await a.requestAttendanceCorrection(f.b, {
      operationKey: randomUUID(),
      kind: "ADD_MISSING_SHIFT",
      dutyId: duty.id,
      reason,
      proposed: {
        clockedInAt: oldIn,
        clockedOutAt: oldOut,
        breaks: [
          {
            code: "MEAL",
            startedAt: new Date(
              new Date(oldIn!).getTime() + 1000,
            ).toISOString(),
            endedAt: new Date(new Date(oldIn!).getTime() + 2000).toISOString(),
          },
        ],
      },
    });
    const added = await a.decideAttendanceCorrection(f.admin, add, {
      operationKey: randomUUID(),
      expectedVersion: 1,
      decision: "APPROVED",
      reason,
    });
    const b = await a.attendanceDetail(f.b, added);
    assert.equal(b.breaks[0].allowance_seconds, 1800);
    assert.equal(b.shift.source, "CORRECTION");
    assert.equal(b.shift.recorded_in_at, null);
    assert.equal(b.shift.recorded_out_at, null);
    assert.equal(b.shift.approved_payable_seconds, null);
    await assert.rejects(
      () => a.attendanceDetail(f.a, added),
      (e) => (e as any).status === 404,
    );
  } finally {
    await f.cleanup();
  }
});
test("revocation wins a real employee-lock race against Clock In; recorded intervals close atomically on revoke and never revive", async () => {
  const f = await attendanceFixture();
  try {
    await f.owner.query("BEGIN");
    await f.owner.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
      f.ids.a,
    ]);
    const pending = a
      .attendanceCommand(f.a, "CLOCK_IN", null, { operationKey: randomUUID() })
      .then(
        () => null,
        (e) => e,
      );
    await blocked(f.owner, "private.attendance_command");
    await f.owner.query("SELECT set_config('app.session_hash',$1,true)", [
      digest(f.tokens.admin),
    ]);
    await f.owner.query(
      "SELECT private.mutate_duty($1::uuid[],$2::date,'REVOKE',$3)",
      [[f.ids.a], f.day, reason],
    );
    await f.owner.query("COMMIT");
    assert.ok(await pending);
    assert.equal(
      (
        await f.owner.query(
          "SELECT id FROM attendance_shifts WHERE employee_id=$1",
          [f.ids.a],
        )
      ).rowCount,
      0,
    );
    const id = await clockIn(f, "b");
    await advance(f, 60);
    let row = await a.attendanceDetail(f.b, id);
    await a.attendanceCommand(f.b, "BREAK_START", id, {
      operationKey: randomUUID(),
      expectedVersion: row.shift.version,
      code: "MEAL",
    });
    await advance(f, 60);
    await mutateDuty(await session(f.tokens.admin), {
      employeeIds: [f.ids.b],
      date: f.day,
      action: "REVOKE",
      reason,
    });
    const saved = (
      await f.owner.query("SELECT * FROM attendance_shifts WHERE id=$1", [id])
    ).rows[0];
    assert.equal(saved.clocked_out_at.toISOString(), f.now.toISOString());
    assert.ok(saved.flags.includes("DUTY_REVOKED"));
    assert.equal(saved.approved_payable_seconds, null);
    assert.equal(
      (
        await f.owner.query(
          "SELECT ended_at FROM attendance_breaks WHERE shift_id=$1",
          [id],
        )
      ).rows[0].ended_at.toISOString(),
      f.now.toISOString(),
    );
    await assert.rejects(() => a.attendanceDetail(f.b, id));
    await runtime(f.duty.b.token, async (c) =>
      assert.equal(
        (await c.query("SELECT id FROM attendance_shifts WHERE id=$1", [id]))
          .rowCount,
        0,
      ),
    );
  } finally {
    await f.owner.query("ROLLBACK");
    await f.cleanup();
  }
});
test("Clock Out versus break start serializes on the employee; correction versus punch rejects stale change without a global gate", async () => {
  const f = await attendanceFixture();
  try {
    const id = await clockIn(f);
    await advance(f, 60);
    let row = await a.attendanceDetail(f.a, id);
    await f.owner.query("BEGIN");
    await f.owner.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
      f.ids.a,
    ]);
    const out = a.attendanceCommand(f.a, "CLOCK_OUT", id, {
        operationKey: randomUUID(),
        expectedVersion: row.shift.version,
      }),
      br = a.attendanceCommand(f.a, "BREAK_START", id, {
        operationKey: randomUUID(),
        expectedVersion: row.shift.version,
        code: "MEAL",
      });
    const both = Promise.allSettled([out, br]);
    await blocked(f.owner, "private.attendance_command");
    await f.owner.query("COMMIT");
    const result = await both;
    assert.equal(result.filter((x) => x.status === "fulfilled").length, 1);
    row = await a.attendanceDetail(f.a, id);
    if (!row.shift.clocked_out_at) await clockOut(f, id);
    const next = await clockIn(f);
    await advance(f, 60);
    row = await a.attendanceDetail(f.a, next);
    const request = await a.requestAttendanceCorrection(f.a, {
      operationKey: randomUUID(),
      kind: "AMEND_SHIFT",
      shiftId: next,
      expectedVersion: row.shift.version,
      reason,
      proposed: {
        clockedInAt: row.shift.clocked_in_at,
        clockedOutAt: f.now.toISOString(),
      },
    });
    await freshAdmin(f);
    await f.owner.query("BEGIN");
    await f.owner.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
      f.ids.a,
    ]);
    const pending = a
      .decideAttendanceCorrection(f.admin, request, {
        operationKey: randomUUID(),
        expectedVersion: 1,
        decision: "APPROVED",
        reason,
      })
      .then(
        () => null,
        (e) => e,
      );
    await blocked(f.owner, "private.attendance_decide");
    await f.owner.query("SELECT set_config('app.session_hash',$1,true)", [
      digest(f.duty.a.token),
    ]);
    await f.owner.query(
      "SELECT private.attendance_command('CLOCK_OUT',$1,$2,$3,NULL)",
      [next, randomUUID(), row.shift.version],
    );
    await f.owner.query("COMMIT");
    assert.equal((await pending).status, 409);
    assert.equal(
      (await a.attendanceDetail(f.a, next)).shift.recorded_out_at,
      f.now.toISOString().replace(".000Z", "+00:00"),
    );
  } finally {
    await f.owner.query("ROLLBACK");
    await f.cleanup();
  }
});
test("session expiry is not Clock Out; grant expiry reconciles at valid_until and does not create a next-day authorization", async () => {
  const f = await attendanceFixture();
  try {
    const id = await clockIn(f);
    await advance(f, 31 * 60);
    await assert.rejects(() => a.currentAttendance(f.a));
    assert.equal(
      (
        await f.owner.query(
          "SELECT clocked_out_at FROM attendance_shifts WHERE id=$1",
          [id],
        )
      ).rows[0].clocked_out_at,
      null,
    );
    await freshDuty(f);
    assert.equal((await a.currentAttendance(f.a)).active!.shift.id, id);
    await advance(f, 86400);
    await f.owner.query("SELECT private.attendance_reconcile_due()");
    const s = (
      await f.owner.query("SELECT * FROM attendance_shifts WHERE id=$1", [id])
    ).rows[0];
    assert.equal(s.clocked_out_at.toISOString(), s.grant_until.toISOString());
    assert.ok(s.flags.includes("MISSING_CLOCK_OUT"));
    assert.equal(s.approved_payable_seconds, null);
    assert.equal(
      (
        await f.owner.query(
          "SELECT id FROM duty_authorizations WHERE employee_id=$1 AND duty_date>$2::date",
          [f.ids.a, f.day],
        )
      ).rowCount,
      0,
    );
  } finally {
    await f.cleanup();
  }
});

test("overnight shift preserves the original grant/date across midnight and 12-hour sessions; 16-hour flag never clips time", async () => {
  const f = await attendanceFixture();
  try {
    const cfg = (
      await f.owner.query(
        "SELECT p.configuration FROM company_settings c JOIN policy_versions p ON p.id=c.work_policy_id",
      )
    ).rows[0].configuration;
    assert.equal(cfg.overnightEnabled ?? false, false);
    await setPolicy(f, "WORK", {
      ...cfg,
      overnightEnabled: true,
      overnightCarryHours: 8,
    });
    await mutateDuty(await session(f.tokens.admin), {
      employeeIds: [f.ids.a],
      date: f.day,
      action: "REVOKE",
      reason,
    });
    const tomorrow = new Date(
      new Date(f.day + "T00:00:00Z").getTime() + 86400000,
    )
      .toISOString()
      .slice(0, 10);
    const administrator = await session(f.tokens.admin);
    await assert.rejects(() =>
      mutateDuty(administrator, {
        employeeIds: [f.ids.a],
        date: f.day,
        action: "REGRANT",
        reason,
        overnight: true,
        validUntil: tomorrow + "T08:00:01+08:00",
      }),
    );
    await mutateDuty(administrator, {
      employeeIds: [f.ids.a],
      date: f.day,
      action: "REGRANT",
      reason,
      overnight: true,
      validUntil: tomorrow + "T08:00:00+08:00",
    });
    const network = digest(randomUUID()),
      ch = await startDuty(f.tokens.a, f.day, f.password, false, network),
      issued = await completeDutyStage(
        f.tokens.a,
        ch.challenge,
        "TOTP",
        otp(f.duty.a.secret, f.now.getTime()),
        network,
      );
    assert.equal(issued.kind, "SESSION");
    if (issued.kind !== "SESSION") throw new Error("Session required");
    f.duty.a.token = issued.token;
    f.tokens.a = issued.account!.token;
    f.a = await workSession(undefined, issued.token);
    const id = await clockIn(f),
      original = (await a.attendanceDetail(f.a, id)).shift;
    await advance(f, 16 * 3600);
    await freshDuty(f);
    let row = await a.attendanceDetail(f.a, id);
    assert.equal(row.shift.duty_date, f.day);
    assert.equal(row.shift.duty_id, original.duty_id);
    assert.equal(row.grossSeconds, "57600.000000");
    assert.ok(!row.flags.includes("LONG_SHIFT"));
    assert.equal(
      new Date(f.now.getTime() + 8 * 3600000).toISOString().slice(0, 10),
      tomorrow,
    );
    await advance(f, 0.001);
    row = await a.attendanceDetail(f.a, id);
    assert.ok(row.flags.includes("LONG_SHIFT"));
    await a.reconcileAttendance(f.a);
    assert.equal(
      (await a.attendanceDetail(f.a, id)).shift.clocked_out_at,
      null,
    );
    await clockOut(f, id);
    row = await a.attendanceDetail(f.a, id);
    assert.equal(row.grossSeconds, "57600.001000");
    assert.equal(row.shift.approved_payable_seconds, null);
    await freshAdmin(f);
    await assert.rejects(() =>
      a.reviewAttendance(f.admin, id, {
        operationKey: randomUUID(),
        expectedVersion: row.shift.version,
        decision: "APPROVED",
      }),
    );
    await a.reviewAttendance(f.admin, id, {
      operationKey: randomUUID(),
      expectedVersion: row.shift.version,
      decision: "APPROVED",
      acknowledgeFlags: true,
      reason,
    });
    assert.equal(
      (await a.attendanceDetail(f.a, id)).shift.approved_payable_seconds,
      "57600.001000",
    );
  } finally {
    await f.cleanup();
  }
});

test("break allowance overage is flagged without clipping; policy edits preserve recorded treatment and require recent MFA", async () => {
  const f = await attendanceFixture();
  try {
    const { policyId: initialPolicyId, ...policy } = await a.attendancePolicy(
      f.admin,
    );
    await a.updateAttendancePolicy(f.admin, {
      expectedPolicyId: initialPolicyId,
      configuration: {
        ...policy,
        breakCodes: policy.breakCodes.map((b) => ({
          ...b,
          allowanceSeconds: 30,
        })),
      },
      reason,
    });
    const id = await clockIn(f);
    let row = await a.attendanceDetail(f.a, id);
    const bid = await a.attendanceCommand(f.a, "BREAK_START", id, {
      operationKey: randomUUID(),
      expectedVersion: row.shift.version,
      code: "MEAL",
    });
    await advance(f, 60);
    await clockOut(f, id);
    row = await a.attendanceDetail(f.a, id);
    assert.ok(row.flags.includes("BREAK_OVER_ALLOWANCE"));
    assert.equal(row.unpaidBreakSeconds, "60.000000");
    assert.equal(row.suggestedSeconds, "0");
    assert.equal(row.breaks[0].allowance_seconds, 30);
    await advance(f, 6 * 60);
    await freshDuty(f);
    await assert.rejects(
      () =>
        a.reviewAttendance(f.admin, id, {
          operationKey: randomUUID(),
          expectedVersion: row.shift.version,
          decision: "APPROVED",
          acknowledgeFlags: true,
          reason,
        }),
      (e) => (e as any).status === 403,
    );
    await freshAdmin(f);
    const changed = await a.attendancePolicy(f.admin);
    const { policyId, ...configuration } = changed;
    await a.updateAttendancePolicy(f.admin, {
      expectedPolicyId: policyId,
      configuration: {
        ...configuration,
        breakCodes: configuration.breakCodes.map((b) => ({ ...b, paid: true })),
      },
      reason,
    });
    assert.equal(
      (await a.attendanceDetail(f.a, id)).breaks.find((b) => b.id === bid)!
        .paid,
      false,
    );
    assert.equal(
      (
        await a.bulkAttendancePreview(f.admin, {
          from: f.day,
          to: f.day,
          employeeId: f.ids.a,
        })
      ).eligible.length,
      0,
    );
  } finally {
    await f.cleanup();
  }
});

test("exclusion/containment constraints prevent overlapping corrections atomically; rejected and out-of-window claims preserve evidence", async () => {
  const f = await attendanceFixture();
  try {
    const first = await clockIn(f);
    await advance(f, 60);
    await clockOut(f, first);
    const second = await clockIn(f);
    await advance(f, 60);
    await clockOut(f, second);
    const one = await a.attendanceDetail(f.a, first),
      two = await a.attendanceDetail(f.a, second);
    const request = await a.requestAttendanceCorrection(f.a, {
      operationKey: randomUUID(),
      kind: "AMEND_SHIFT",
      shiftId: second,
      expectedVersion: two.shift.version,
      reason,
      proposed: {
        clockedInAt: one.shift.clocked_in_at,
        clockedOutAt: two.shift.clocked_out_at,
      },
    });
    await assert.rejects(
      () =>
        a.decideAttendanceCorrection(f.admin, request, {
          operationKey: randomUUID(),
          expectedVersion: 1,
          decision: "APPROVED",
          reason,
        }),
      (e) => (e as any).status === 409,
    );
    assert.equal(
      (await a.attendanceDetail(f.a, second)).shift.clocked_in_at,
      two.shift.clocked_in_at,
    );
    await a.decideAttendanceCorrection(f.admin, request, {
      operationKey: randomUUID(),
      expectedVersion: 1,
      decision: "REJECTED",
      reason,
    });
    const bad = await a.requestAttendanceCorrection(f.a, {
      operationKey: randomUUID(),
      kind: "AMEND_SHIFT",
      shiftId: second,
      expectedVersion: two.shift.version,
      reason,
      proposed: {
        clockedInAt: new Date(
          new Date(f.day + "T00:00:00+08:00").getTime() - 1000,
        ).toISOString(),
        clockedOutAt: two.shift.clocked_out_at,
      },
    });
    await assert.rejects(() =>
      a.decideAttendanceCorrection(f.admin, bad, {
        operationKey: randomUUID(),
        expectedVersion: 1,
        decision: "APPROVED",
        reason,
      }),
    );
    assert.equal(
      (
        await a.attendanceCorrections(f.a, { from: f.day, to: f.day })
      ).items.find((c) => c.id === request)!.status,
      "REJECTED",
    );
    await assert.rejects(
      () =>
        f.owner.query(
          "UPDATE attendance_shifts SET clocked_in_at=$2,clocked_out_at=$3 WHERE id=$1",
          [second, one.shift.clocked_in_at, two.shift.clocked_out_at],
        ),
      (e) => (e as any).code === "23P01",
    );
    assert.equal(
      (
        await f.owner.query(
          "SELECT count(*)::int n FROM pg_constraint WHERE conrelid IN ('attendance_shifts'::regclass,'attendance_breaks'::regclass) AND contype='x'",
        )
      ).rows[0].n,
      2,
    );
  } finally {
    await f.cleanup();
  }
});

test("account disable and grant regrant preserve time; later valid DUTY reads history while stale tokens stay denied", async () => {
  const f = await attendanceFixture();
  try {
    const id = await clockIn(f);
    const row = await a.attendanceDetail(f.a, id);
    const bid = await a.attendanceCommand(f.a, "BREAK_START", id, {
      operationKey: randomUUID(),
      expectedVersion: row.shift.version,
      code: "SHORT",
    });
    await a.attendanceCommand(f.a, "BREAK_END", bid, {
      operationKey: randomUUID(),
      expectedVersion: 1,
    });
    assert.ok(
      (await a.attendanceDetail(f.a, id)).flags.includes("ZERO_DURATION_BREAK"),
    );
    await advance(f, 60);
    await f.owner.query(
      "UPDATE users SET disabled_at=private.security_now() WHERE id=$1",
      [f.ids.a],
    );
    const saved = (
      await f.owner.query("SELECT * FROM attendance_shifts WHERE id=$1", [id])
    ).rows[0];
    assert.ok(saved.flags.includes("ACCOUNT_DISABLED"));
    assert.equal(saved.clocked_out_at.toISOString(), f.now.toISOString());
    assert.equal(saved.approved_payable_seconds, null);
    await assert.rejects(() => a.attendanceDetail(f.a, id));
    await f.owner.query("UPDATE users SET disabled_at=NULL WHERE id=$1", [
      f.ids.a,
    ]);
    await mutateDuty(await session(f.tokens.admin), {
      employeeIds: [f.ids.a],
      date: f.day,
      action: "REVOKE",
      reason,
    });
    await mutateDuty(await session(f.tokens.admin), {
      employeeIds: [f.ids.a],
      date: f.day,
      action: "REGRANT",
      reason,
    });
    await assert.rejects(() => a.attendanceDetail(f.a, id));
    const { login } = await import("../../src/server/auth/service");
    const net = digest(randomUUID()),
      account = await login("a_" + f.suffix, f.password, net),
      ch = await startDuty(account.token, f.day, f.password, false, net),
      issued = await completeDutyStage(
        account.token,
        ch.challenge,
        "TOTP",
        otp(f.duty.a.secret, f.now.getTime()),
        net,
      );
    if (issued.kind !== "SESSION") throw new Error("Session required");
    f.a = await workSession(undefined, issued.token);
    const history = await a.attendanceDetail(f.a, id);
    assert.equal(
      history.shift.duty_authorization_version,
      saved.duty_authorization_version,
    );
    assert.equal(history.breaks[0].recorded_start, row.shift.clocked_in_at);
    assert.equal(history.shift.recorded_out_at, null);
  } finally {
    await f.cleanup();
  }
});
