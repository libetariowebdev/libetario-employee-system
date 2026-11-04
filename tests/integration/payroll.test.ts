import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { digest } from "../helpers";
import {
  addDays,
  fixturePay,
  payrollFixture,
  payReason,
  waitForPayrollLock,
} from "../payroll-helpers";
import { authPool, db } from "../../src/server/db";
import { addRate } from "../../src/server/services/employees";
import { changePayroll, readPayroll } from "../../src/server/services/payroll";
import { session } from "../../src/server/auth/service";

after(async () => {
  await db.$disconnect();
  await authPool.end();
});
const note = {
  reason: payReason,
  evidence: "Reviewed fixture source evidence",
};
const status = (wanted: number) => (error: unknown) =>
  (error as { status?: number }).status === wanted;

test("15.8 distinct daily/hourly rates, effective changes and frozen snapshot isolation", async () => {
  const f = await payrollFixture();
  const runtime = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await f.owner.query(
      "UPDATE employee_rate_history SET basis='DAILY',amount=800 WHERE employee_id=$1",
      [f.ids.a],
    );
    await f.owner.query(
      "UPDATE employee_rate_history SET amount=125.5000 WHERE employee_id=$1",
      [f.ids.b],
    );
    for (const date of [f.start, addDays(f.start, 1)]) {
      await f.shift(
        "a",
        date,
        date + "T00:00:00Z",
        date + "T08:00:00Z",
        "28800",
      );
    }
    await f.shift(
      "b",
      f.start,
      f.start + "T00:00:00Z",
      f.start + "T10:00:00Z",
      "36000",
    );
    const { id } = await f.prepare(["a", "b"]);
    const p = await f.period(id);
    const a = p.lines.find((x) => x.employeeId === f.ids.a)!;
    const b = p.lines.find((x) => x.employeeId === f.ids.b)!;
    assert.equal(a.gross, "1600.00");
    assert.equal(b.gross, "1255.00");
    const person = await session(f.tokens.a);
    await assert.rejects(
      () => readPayroll(person, "own-line", a.id),
      status(404),
    );
    await f.approve(id, p);
    const frozen = await f.line(a.id);
    assert.match(frozen.snapshotDigest!, /^[a-f0-9]{64}$/);
    assert.deepEqual(
      (await f.line(b.id)).items.map((i) => i.attendance.length),
      [1],
    );
    await f.owner.query(
      "UPDATE employee_rate_history SET amount=900,version=version+1 WHERE employee_id=$1",
      [f.ids.a],
    );
    await f.owner.query(
      "UPDATE employee_profiles SET legal_name='Updated fake name' WHERE user_id=$1",
      [f.ids.a],
    );
    await f.publish(
      { ...fixturePay, moneyRounding: "CEIL" },
      addDays(f.start, 2),
    );
    const unchanged = await f.line(a.id);
    assert.equal(unchanged.snapshotDigest, frozen.snapshotDigest);
    assert.deepEqual(unchanged.snapshot, frozen.snapshot);
    await assert.rejects(
      () => readPayroll(person, "own-line", b.id),
      status(404),
    );
    const own = await readPayroll<Record<string, unknown>>(
      person,
      "own-line",
      a.id,
    );
    assert.equal(own.gross, "1600.00");
    assert.ok(!("snapshot" in own) && !("adjustments" in own));
    await runtime.connect();
    await runtime.query("SELECT set_config('app.session_hash',$1,false)", [
      digest(f.tokens.a),
    ]);
    assert.deepEqual(
      (await runtime.query("SELECT id FROM payroll_lines ORDER BY id")).rows,
      [{ id: a.id }],
    );
    await assert.rejects(
      () => runtime.query("SELECT snapshot FROM payroll_lines"),
      /permission denied/,
    );
    await assert.rejects(
      () => runtime.query("SELECT * FROM payroll_item_attendance"),
      /permission denied/,
    );
    await assert.rejects(
      () => runtime.query("UPDATE payroll_lines SET gross=0"),
      /permission denied/,
    );
    await assert.rejects(
      () =>
        f.owner.query("UPDATE payroll_items SET amount=0 WHERE line_id=$1", [
          a.id,
        ]),
      /Frozen payroll source/,
    );
    assert.equal(
      (
        await f.owner.query(
          "SELECT count(*)::int AS payments FROM payments WHERE line_id IN (SELECT id FROM payroll_lines WHERE period_id=$1)",
          [id],
        )
      ).rows[0].payments,
      0,
    );
  } finally {
    await runtime.end().catch(() => {});
    await f.cleanup();
  }
});

test("incomplete policy blocks the draft, catalog rejects percentage rules and weekday locks after period creation", async () => {
  const f = await payrollFixture({ weekday: 6, paydayOffset: 1 });
  try {
    const settings = await readPayroll<{ missing: string[] }>(
      f.admin,
      "settings",
    );
    assert.ok(
      settings.missing.includes("paymentMethods") &&
        settings.missing.includes("moneyRounding"),
    );
    const { id } = await f.prepare();
    const p = await f.period(id);
    assert.ok(
      p.lines[0].issues.some(
        (issue) => issue.code === "PAY_POLICY_UNCONFIGURED",
      ),
    );
    await assert.rejects(() => f.approve(id), status(422));
    await assert.rejects(
      () => f.publish({ ...fixturePay, weekday: 7 }, addDays(f.start, 1)),
      status(409),
    );
    await assert.rejects(
      () =>
        f.owner.query("SELECT private.payroll_catalog($1)", [
          JSON.stringify({
            kind: "DEDUCTION",
            code: "PERCENT_TEST",
            label: "Unsupported rate",
            category: "OTHER",
            effectiveDate: f.start,
            enabled: true,
            reason: payReason,
            employeeId: f.ids.a,
            rule: { mode: "PERCENT", amount: "1.00" },
          }),
        ]),
      /check constraint/,
    );
    await f.publish(fixturePay, addDays(f.start, -1));
    // The incomplete newer revision remains effective for the reviewed service date.
    assert.equal((await f.line(p.lines[0].id)).net, "0.00");
  } finally {
    await f.cleanup();
  }
});

test("manual earnings, fixed and reviewed deductions are exact, scoped and audited; negative net blocks", async () => {
  const f = await payrollFixture();
  try {
    const { id: earning } = await changePayroll(f.admin, "catalog", {
      kind: "EARNING",
      code: "BONUS_" + f.suffix,
      category: "BONUS",
      label: "Reviewed bonus",
      effectiveDate: f.start,
      reason: payReason,
      enabled: true,
      rule: { mode: "MANUAL" },
    });
    const { id: reviewed } = await changePayroll(f.admin, "catalog", {
      kind: "DEDUCTION",
      code: "REVIEW_" + f.suffix,
      category: "OTHER",
      label: "Reviewed charge",
      effectiveDate: f.start,
      reason: payReason,
      enabled: true,
      employeeId: f.ids.a,
      rule: { mode: "MANUAL" },
    });
    await changePayroll(f.admin, "catalog", {
      kind: "DEDUCTION",
      code: "FIXED_" + f.suffix,
      category: "OTHER",
      label: "Fixed fixture charge",
      effectiveDate: f.start,
      reason: payReason,
      enabled: true,
      employeeId: f.ids.a,
      rule: { mode: "FIXED", amount: "10.25" },
    });
    const { id } = await f.prepare();
    let l = (await f.period(id)).lines[0];
    assert.equal(l.net, "-10.25");
    assert.ok(l.issues.some((i) => i.code === "NEGATIVE_NET"));
    await assert.rejects(() => f.approve(id), status(422));
    await f.command(l.id, l.version, "MANUAL", {
      ...note,
      typeId: earning,
      kind: "EARNING",
      date: f.start,
      amount: "100.35",
    });
    l = await f.line(l.id);
    assert.ok(l.issues.some((i) => i.code === "MANUAL_DEDUCTION_REQUIRED"));
    await f.command(l.id, l.version, "MANUAL", {
      ...note,
      typeId: reviewed,
      kind: "DEDUCTION",
      date: f.start,
      amount: "0.10",
    });
    l = await f.line(l.id);
    assert.deepEqual(
      [l.gross, l.deductions, l.net],
      ["100.35", "10.35", "90.00"],
    );
    assert.deepEqual(l.issues, []);
    const audit = (
      await f.owner.query(
        "SELECT payload FROM audit_log WHERE action='payroll.manual' AND payload->>'lineId'=$1 ORDER BY occurred_at,id",
        [l.id],
      )
    ).rows;
    assert.equal(audit.length, 2);
    assert.ok(
      audit.every(
        (row) =>
          row.payload.evidence === note.evidence &&
          row.payload.before &&
          row.payload.after,
      ),
    );
  } finally {
    await f.cleanup();
  }
});

test("15.12 Saturday cutoff splits overnight at Manila midnight and conserves approved override seconds", async () => {
  const f = await payrollFixture();
  try {
    await f.publish(fixturePay, addDays(f.start, -7));
    await f.regular(addDays(f.start, -7));
    const prior = addDays(f.start, -1);
    const shift = await f.shift(
      "a",
      prior,
      prior + "T15:00:00Z",
      prior + "T17:00:00Z",
      "5400.000001",
      true,
    );
    const nextFriday = addDays(f.start, 6);
    await f.shift(
      "a",
      nextFriday,
      nextFriday + "T00:00:00Z",
      nextFriday + "T01:00:00Z",
      "3600",
    );
    const previous = await f.prepare(["a"], addDays(f.start, -7));
    const current = await f.prepare();
    const a = (await f.period(previous.id)).lines[0],
      b = (await f.period(current.id)).lines[0];
    assert.ok(a.issues.some((i) => i.code === "REVIEWED_ALLOCATION_REQUIRED"));
    assert.ok(b.issues.some((i) => i.code === "REVIEWED_ALLOCATION_REQUIRED"));
    const payload = {
      ...note,
      shiftId: shift.id,
      shiftVersion: shift.version,
      flags: [],
      allocations: [
        { date: prior, seconds: "3600" },
        { date: f.start, seconds: "1800" },
      ],
    };
    await assert.rejects(
      () => f.command(a.id, a.version, "SOURCE", payload),
      status(400),
    );
    await f.command(a.id, a.version, "SOURCE", {
      ...payload,
      allocations: [
        payload.allocations[0],
        { date: f.start, seconds: "1800.000001" },
      ],
    });
    await f.command(b.id, b.version, "RECALCULATE");
    const original = await f.line(a.id),
      carried = await f.line(b.id);
    assert.deepEqual(
      original.items[0].attendance.map((s) => [s.seconds, s.dutyDate]),
      [["3600.000000", prior]],
    );
    assert.deepEqual(
      carried.items[0].attendance.map((s) => [s.seconds, s.dutyDate]),
      [["1800.000001", prior]],
    );
    assert.deepEqual(
      [original.net, carried.items[0].amount, carried.net],
      ["100.12", "50.06", "150.18"],
    );
    await f.approve(previous.id);
    await f.approve(current.id);
  } finally {
    await f.cleanup();
  }
});

test("15.9 recalculation after time changes, unpaid replacement and frozen original amounts", async () => {
  const f = await payrollFixture();
  try {
    const shift = await f.shift(
      "a",
      f.start,
      f.start + "T00:00:00Z",
      f.start + "T02:00:00Z",
      null,
    );
    const { id } = await f.prepare();
    let l = (await f.period(id)).lines[0];
    assert.ok(l.issues.some((i) => i.code === "ATTENDANCE_NOT_APPROVED"));
    await f.owner.query("SELECT private.attendance_review($1,$2)", [
      shift.id,
      JSON.stringify({
        expectedVersion: shift.version,
        operationKey: randomUUID(),
        decision: "APPROVED",
        mode: "SUGGESTED",
        reason: payReason,
      }),
    ]);
    await f.command(l.id, l.version, "RECALCULATE");
    l = await f.line(l.id);
    assert.equal(l.net, "200.25");
    await f.approve(id);
    const original = await f.line(l.id);
    await f.at(f.end + "T02:01:00Z");
    await f.owner.query(
      `UPDATE attendance_shifts SET clocked_out_at=clocked_in_at+interval '3 hours',
      approved_payable_seconds=10800,version=version+1 WHERE id=$1`,
      [shift.id],
    );
    assert.equal((await f.line(l.id)).sourceChanged, true);
    const result = await f.command(l.id, original.version, "REPLACE", note);
    const replacement = await f.line(result.id);
    assert.equal(replacement.net, "300.38");
    await f.command(
      replacement.id,
      replacement.version,
      "APPROVE_REPLACEMENT",
      note,
    );
    const adjusted = await f.line(l.id);
    assert.equal(adjusted.state, "ADJUSTED");
    assert.equal(adjusted.snapshotDigest, original.snapshotDigest);
    assert.equal(adjusted.net, "200.25");
    const approved = await f.line(replacement.id);
    await f.command(approved.id, approved.version, "VOID", note);
    assert.equal((await f.line(approved.id)).state, "VOIDED");
  } finally {
    await f.cleanup();
  }
});

test("15.11 duplicate creation and approval serialize; cutoff and MFA are enforced", async () => {
  const f = await payrollFixture();
  try {
    await f.shift(
      "a",
      f.start,
      f.start + "T00:00:00Z",
      f.start + "T02:00:00Z",
      "7200",
    );
    const duplicate = await Promise.allSettled([f.prepare(), f.prepare()]);
    assert.equal(
      duplicate.filter((item) => item.status === "fulfilled").length,
      1,
    );
    const { id } = duplicate.find((item) => item.status === "fulfilled")!.value;
    const p = await f.period(id);
    assert.equal(p.lines.length, 1);
    await f.at(addDays(f.end, -1) + "T15:59:59.999Z");
    await assert.rejects(() => f.approve(id, p), status(422));
    await f.at(addDays(f.end, -1) + "T16:00:00.000Z");
    await f.owner.query(
      "UPDATE sessions SET mfa_verified_at=private.security_now()-interval '6 minutes' WHERE token_hash=$1",
      [digest(f.tokens.admin)],
    );
    await assert.rejects(() => f.approve(id, p), status(403));
    await f.at(f.end + "T02:00:00Z");
    const key = randomUUID();
    await Promise.all([f.approve(id, p, key), f.approve(id, p, key)]);
    await assert.rejects(() => f.approve(id, p), status(409));
    const line = (await f.period(id)).lines[0];
    assert.equal(line.state, "APPROVED");
    assert.equal(
      (
        await f.owner.query(
          "SELECT count(*)::int n FROM audit_log WHERE action='payroll.period_approved' AND payload->>'periodId'=$1",
          [id],
        )
      ).rows[0].n,
      1,
    );
  } finally {
    await f.cleanup();
  }
});

test("approval waits for the employee lock and rejects a correction that wins the race", async () => {
  const f = await payrollFixture();
  const other = new pg.Client({
    connectionString: process.env.MIGRATION_DATABASE_URL,
  });
  try {
    const shift = await f.shift(
      "a",
      f.start,
      f.start + "T00:00:00Z",
      f.start + "T02:00:00Z",
      "7200",
    );
    const { id } = await f.prepare(),
      p = await f.period(id);
    await other.connect();
    await other.query("BEGIN");
    await other.query("SELECT 1 FROM users WHERE id=$1 FOR UPDATE", [f.ids.a]);
    const pending = assert.rejects(() => f.approve(id, p), status(409));
    await waitForPayrollLock(f.owner, "%private.payroll_approve(%");
    await other.query(
      `UPDATE attendance_shifts SET approval_status='PENDING',approved_payable_seconds=NULL,
      reviewed_at=NULL,reviewed_by=NULL,review_reason=NULL,version=version+1 WHERE id=$1`,
      [shift.id],
    );
    await other.query("COMMIT");
    await pending;
    assert.equal((await f.period(id)).state, "DRAFT");
  } finally {
    await other.end().catch(() => {});
    await f.cleanup();
  }
});

test("an attendance correction queued behind approval leaves the frozen line intact and flags review", async () => {
  const f = await payrollFixture();
  const lock = new pg.Client({
    connectionString: process.env.MIGRATION_DATABASE_URL,
  });
  const correction = new pg.Client({
    connectionString: process.env.MIGRATION_DATABASE_URL,
  });
  try {
    const shift = await f.shift(
      "a",
      f.start,
      f.start + "T00:00:00Z",
      f.start + "T02:00:00Z",
      "7200",
    );
    const { id } = await f.prepare(),
      p = await f.period(id);
    await lock.connect();
    await correction.connect();
    await lock.query("BEGIN");
    await lock.query("SELECT 1 FROM payroll_periods WHERE id=$1 FOR UPDATE", [
      id,
    ]);
    const approve = f.approve(id, p);
    await waitForPayrollLock(f.owner, "%private.payroll_approve(%");
    await correction.query("SELECT set_config('app.session_hash',$1,false)", [
      digest(f.tokens.admin),
    ]);
    const amend = correction.query("SELECT private.attendance_request($1)", [
      JSON.stringify({
        kind: "AMEND_SHIFT",
        shiftId: shift.id,
        expectedVersion: shift.version,
        operationKey: randomUUID(),
        reason: payReason,
        proposed: {
          clockedInAt: f.start + "T00:00:00Z",
          clockedOutAt: f.start + "T03:00:00Z",
          breaks: [],
        },
      }),
    ]);
    await waitForPayrollLock(f.owner, "%private.attendance_request(%");
    await lock.query("COMMIT");
    await approve;
    await amend;
    const frozen = await f.line(p.lines[0].id);
    assert.equal(frozen.state, "APPROVED");
    assert.equal(frozen.net, "200.25");
    assert.equal(frozen.sourceChanged, true);
  } finally {
    await lock.end().catch(() => {});
    await correction.end().catch(() => {});
    await f.cleanup();
  }
});

test("rate edits share approval locks in both orders and cannot revise a frozen line", async () => {
  const f = await payrollFixture();
  const blocker = new pg.Client({
    connectionString: process.env.MIGRATION_DATABASE_URL,
  });
  const later = addDays(f.start, 1);
  const rate = (date: string, amount: string) =>
    addRate(f.admin, f.ids.a, {
      basis: "HOURLY",
      amount,
      effective_from: date,
      expected_daily_seconds: 28800,
      reason: payReason,
    });
  const hold = async () => {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT id FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
      [[f.ids.admin, f.ids.a]],
    );
  };
  try {
    await f.shift(
      "a",
      f.start,
      f.start + "T00:00:00Z",
      f.start + "T02:00:00Z",
      "7200",
    );
    await f.shift(
      "a",
      later,
      later + "T00:00:00Z",
      later + "T02:00:00Z",
      "7200",
    );
    const { id } = await f.prepare();
    const old = await f.period(id);
    await blocker.connect();
    await hold();
    const firstEdit = rate(f.start, "125.0000");
    await waitForPayrollLock(f.owner, "%private.lock_employee_profile(%");
    const stale = assert.rejects(() => f.approve(id, old), status(409));
    await waitForPayrollLock(f.owner, "%private.payroll_approve(%");
    await blocker.query("COMMIT");
    await firstEdit;
    await stale;
    await f.command(old.lines[0].id, old.lines[0].version, "RECALCULATE");
    const fresh = await f.period(id);
    assert.equal(fresh.lines[0].net, "500.00");
    await hold();
    const approval = f.approve(id, fresh);
    await waitForPayrollLock(f.owner, "%private.payroll_approve(%");
    const secondEdit = rate(later, "180.0000");
    await waitForPayrollLock(f.owner, "%private.lock_employee_profile(%");
    await blocker.query("COMMIT");
    await approval;
    await secondEdit;
    const frozen = await f.line(fresh.lines[0].id);
    assert.equal(frozen.net, "500.00");
    assert.deepEqual(
      frozen.items.map((item) => item.detail.rate),
      ["125.0000", "125.0000"],
    );
  } finally {
    await blocker.end().catch(() => {});
    await f.cleanup();
  }
});

test("15.9 real missing-punch request blocks until correction, attendance approval and payroll source review", async () => {
  const f = await payrollFixture();
  try {
    const grant = await f.grant("a", f.start);
    await f.workingDay("a", f.start);
    const request = (
      await f.owner.query("SELECT private.attendance_request($1) AS id", [
        JSON.stringify({
          kind: "ADD_MISSING_SHIFT",
          dutyId: grant.id,
          operationKey: randomUUID(),
          reason: payReason,
          proposed: {
            clockedInAt: f.start + "T00:00:00Z",
            clockedOutAt: f.start + "T02:00:00Z",
            breaks: [],
          },
        }),
      ])
    ).rows[0].id;
    const { id } = await f.prepare();
    let l = (await f.period(id)).lines[0];
    assert.ok(l.issues.some((i) => i.code === "ATTENDANCE_CORRECTION_PENDING"));
    await assert.rejects(() => f.approve(id), status(422));
    await f.owner.query("SELECT private.attendance_decide($1,$2)", [
      request,
      JSON.stringify({
        expectedVersion: 1,
        operationKey: randomUUID(),
        decision: "APPROVED",
        reason: payReason,
      }),
    ]);
    const shift = (
      await f.owner.query(
        "SELECT id,version FROM attendance_shifts WHERE duty_id=$1",
        [grant.id],
      )
    ).rows[0];
    await f.owner.query("SELECT private.attendance_review($1,$2)", [
      shift.id,
      JSON.stringify({
        expectedVersion: shift.version,
        operationKey: randomUUID(),
        decision: "APPROVED",
        mode: "SUGGESTED",
        reason: payReason,
        acknowledgeFlags: true,
      }),
    ]);
    await f.command(l.id, l.version, "RECALCULATE");
    l = await f.line(l.id);
    const issue = l.issues.find((i) => i.code === "UNRESOLVED_FLAGS")!;
    assert.ok(issue.flags?.includes("MISSING_PUNCH"));
    await f.command(l.id, l.version, "SOURCE", {
      ...note,
      shiftId: shift.id,
      shiftVersion: shift.version + 1,
      flags: issue.flags,
      allocations: [{ date: f.start, seconds: "7200" }],
    });
    l = await f.line(l.id);
    assert.deepEqual(l.issues, []);
    assert.equal(l.net, "200.25");
    await f.approve(id);
  } finally {
    await f.cleanup();
  }
});

test("service dates select their own rate and rounding revision; explicit NONE blocks non-cent items", async () => {
  const f = await payrollFixture({ ...fixturePay, moneyRounding: "NONE" });
  try {
    const later = addDays(f.start, 1);
    await f.publish(
      {
        ...fixturePay,
        timeRounding: "HALF_UP",
        timeUnitSeconds: 60,
        moneyRounding: "HALF_UP",
      },
      later,
    );
    await f.owner.query(
      "UPDATE employee_rate_history SET effective_to=$2 WHERE employee_id=$1",
      [f.ids.a, later],
    );
    await f.owner.query(
      `INSERT INTO employee_rate_history(employee_id,basis,amount,effective_from,expected_daily_seconds,pay_policy_id,created_by)
      SELECT $1,'HOURLY',120.25,$2,28800,pay_policy_id,$3 FROM company_settings`,
      [f.ids.a, later, f.ids.admin],
    );
    await f.shift(
      "a",
      f.start,
      f.start + "T00:00:00Z",
      f.start + "T01:00:00Z",
      "3600",
    );
    await f.shift(
      "a",
      later,
      later + "T00:00:00Z",
      later + "T01:00:31Z",
      "3631",
    );
    const { id } = await f.prepare(),
      line = await f.line((await f.period(id)).lines[0].id);
    assert.ok(
      line.issues.some(
        (i) => i.code === "NON_CENT_EXACT" && i.date === f.start,
      ),
    );
    assert.deepEqual(
      line.items.map((i) => [
        i.detail.rate,
        i.detail.approvedSeconds,
        i.detail.payableSeconds,
        i.amount,
      ]),
      [["120.2500", "3631.000000", "3660.000000", "122.25"]],
    );
    await assert.rejects(() => f.approve(id), status(422));
  } finally {
    await f.cleanup();
  }
});

test("exact quotient and remainder match independent BigInt rounding properties", async () => {
  const f = await payrollFixture(null);
  try {
    const results = (
      await f.owner
        .query(`SELECT n,d,u,m,private.payroll_quantize(n,d,u,m)::text actual
     FROM generate_series(0,31) n CROSS JOIN generate_series(1,7) d CROSS JOIN (VALUES(1),(5),(30)) units(u)
     CROSS JOIN (VALUES('NONE'),('HALF_UP'),('HALF_EVEN'),('FLOOR'),('CEIL'),('TRUNCATE')) modes(m)`)
    ).rows;
    for (const { n, d, u, m, actual } of results) {
      const numerator = BigInt(n),
        unit = BigInt(u),
        denominator = BigInt(d) * unit;
      const q = numerator / denominator,
        r = numerator % denominator;
      const bump =
        (m === "CEIL" && r > 0n) ||
        (m === "HALF_UP" && r * 2n >= denominator) ||
        (m === "HALF_EVEN" &&
          (r * 2n > denominator || (r * 2n === denominator && q % 2n === 1n)));
      assert.equal(
        actual,
        m === "NONE" && r > 0n
          ? null
          : ((q + (bump ? 1n : 0n)) * unit).toString(),
      );
    }
  } finally {
    await f.cleanup();
  }
});
