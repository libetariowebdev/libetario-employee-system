import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  attendanceFixture,
  advance,
  freshAdmin,
  freshDuty,
  type AF,
} from "../attendance-helpers";
import * as a from "../../src/server/services/attendance";
import { db, authPool } from "../../src/server/db";
import { csrfForSession } from "../../src/server/auth/security";
import { digest } from "../helpers";
import { blocked, runtime } from "../work-helpers";
import { setPolicy } from "../duty-helpers";
import { mutateDuty } from "../../src/server/services/duty";
import { session, login } from "../../src/server/auth/service";
import { startDuty, completeDutyStage } from "../../src/server/auth/duty";
import { otp } from "../../src/lib/mfa-crypto";
import { workSession } from "../../src/server/dal/work";
const origin = process.env.HTTP_TEST_ORIGIN ?? "http://127.0.0.1:3001";
if (!["127.0.0.1", "localhost"].includes(new URL(origin).hostname))
  throw new Error("Local HTTP test server required");
after(async () => {
  await db.$disconnect();
  await authPool.end();
});
const reason = "Verified actual punches with employee and administrator";
function jar(f: AF, who = "a") {
  return who === "admin"
    ? { token: f.tokens.admin, cookie: "libetario_session=" + f.tokens.admin }
    : {
        token: f.duty[who].token,
        cookie: "libetario_duty=" + f.duty[who].token,
      };
}
async function get(f: AF, path = "", who = "a") {
  return fetch(origin + "/api/attendance" + path, {
    headers: { cookie: jar(f, who).cookie },
  });
}
async function send(
  f: AF,
  path: string,
  data: unknown = {},
  who = "a",
  headers: Record<string, string> = {},
) {
  const j = jar(f, who);
  return fetch(origin + "/api/attendance/" + path, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      cookie: j.cookie,
      ...headers,
    },
    body: JSON.stringify({
      operationKey: randomUUID(),
      ...(data as object),
      csrf: csrfForSession(j.token),
    }),
  });
}
async function ok(r: Response, status = 200) {
  assert.equal(r.status, status, await r.clone().text());
  assert.equal(r.headers.get("cache-control"), "private, no-store");
  return r.json();
}
async function start(f: AF, who = "a") {
  return (await ok(await send(f, "clock-in", {}, who), 201)).id as string;
}
async function detail(f: AF, id: string, who = "a") {
  return ok(await get(f, "/shifts/" + id, who));
}
async function out(f: AF, id: string, who = "a") {
  const s = await detail(f, id, who);
  return ok(
    await send(
      f,
      "shifts/" + id + "/clock-out",
      { expectedVersion: s.shift.version },
      who,
    ),
  );
}

test("HTTP DUTY attendance is explicit server time, not sign-in or client counters; exact breaks and suggested review stay separate", async () => {
  const f = await attendanceFixture();
  try {
    assert.equal((await ok(await get(f, "/current"))).active, null);
    const id = (
      await ok(
        await send(f, "clock-in", {
          clockedInAt: "2000-01-01T00:00:00Z",
          duration: 999999,
        }),
        201,
      )
    ).id;
    let r = await detail(f, id);
    assert.equal(new Date(r.shift.clocked_in_at).getTime(), f.now.getTime());
    await advance(f, 60);
    const b = (
      await ok(
        await send(f, "shifts/" + id + "/breaks", {
          expectedVersion: r.shift.version,
          code: "MEAL",
        }),
        201,
      )
    ).id;
    await advance(f, 60);
    await out(f, id);
    r = await detail(f, id);
    assert.equal(r.breaks[0].id, b);
    assert.equal(r.breaks[0].ended_at, r.shift.clocked_out_at);
    assert.equal(r.grossSeconds, "120.000000");
    assert.equal(r.suggestedSeconds, "60.000000");
    assert.equal(r.shift.approved_payable_seconds, null);
    await ok(
      await send(
        f,
        "shifts/" + id + "/review",
        { expectedVersion: r.shift.version, decision: "APPROVED" },
        "admin",
      ),
    );
    assert.equal(
      (await detail(f, id)).shift.approved_payable_seconds,
      "60.000000",
    );
  } finally {
    await f.cleanup();
  }
});

test("HTTP/SSR/RLS isolate attendance and corrections; missing and guessed IDs are indistinguishable; ACCOUNT cannot access history", async () => {
  const f = await attendanceFixture();
  try {
    const id = await start(f);
    await advance(f, 60);
    await out(f, id);
    const r = await detail(f, id);
    const req = (
      await ok(
        await send(f, "corrections", {
          kind: "AMEND_SHIFT",
          shiftId: id,
          expectedVersion: r.shift.version,
          reason,
          proposed: {
            clockedInAt: r.shift.clocked_in_at,
            clockedOutAt: r.shift.clocked_out_at,
          },
        }),
        201,
      )
    ).id;
    const foreign = await get(f, "/shifts/" + id, "b"),
      missing = await get(f, "/shifts/" + randomUUID(), "b");
    assert.equal(foreign.status, 404);
    assert.equal(await foreign.text(), await missing.text());
    assert.equal(
      (
        await send(
          f,
          "shifts/" + id + "/clock-out",
          { expectedVersion: r.shift.version },
          "b",
        )
      ).status,
      404,
    );
    assert.equal(
      (await ok(await get(f, "/corrections", "b"))).items.some(
        (x: any) => x.id === req,
      ),
      false,
    );
    const account = { cookie: "libetario_session=" + f.tokens.a };
    assert.equal(
      (await fetch(origin + "/api/attendance", { headers: account })).status,
      401,
    );
    for (const cookie of [account.cookie, jar(f, "b").cookie]) {
      const p = await fetch(origin + "/work/attendance/" + id, {
        headers: { cookie },
        redirect: "manual",
      });
      assert.ok(p.status === 404 || p.status === 307);
      assert.ok(!(await p.text()).includes(f.ids.a));
    }
    await runtime(f.duty.b.token, async (c) => {
      for (const table of [
        "attendance_shifts",
        "attendance_breaks",
        "attendance_adjustments",
      ])
        assert.equal(
          (
            await c.query(`SELECT id FROM ${table} WHERE employee_id=$1`, [
              f.ids.a,
            ])
          ).rowCount,
          0,
        );
    });
  } finally {
    await f.cleanup();
  }
});

test("HTTP shift approvals enforce recent MFA, override bounds/reason and flag acknowledgement; no automatic approval", async () => {
  const f = await attendanceFixture();
  try {
    const id = await start(f);
    await out(f, id);
    let r = await detail(f, id);
    assert.ok(r.flags.includes("ZERO_DURATION"));
    for (const input of [
      { decision: "APPROVED" },
      {
        decision: "APPROVED",
        mode: "OVERRIDE",
        value: "1",
        reason,
        acknowledgeFlags: true,
      },
      { decision: "REJECTED", reason: "short" },
    ])
      assert.ok(
        (
          await send(
            f,
            "shifts/" + id + "/review",
            { ...input, expectedVersion: r.shift.version },
            "admin",
          )
        ).status >= 400,
      );
    await advance(f, 301);
    await freshDuty(f);
    assert.equal(
      (
        await send(
          f,
          "shifts/" + id + "/review",
          {
            decision: "APPROVED",
            expectedVersion: r.shift.version,
            acknowledgeFlags: true,
            reason,
          },
          "admin",
        )
      ).status,
      403,
    );
    await freshAdmin(f);
    await ok(
      await send(
        f,
        "shifts/" + id + "/review",
        {
          decision: "APPROVED",
          expectedVersion: r.shift.version,
          acknowledgeFlags: true,
          reason,
        },
        "admin",
      ),
    );
    r = await detail(f, id);
    assert.equal(r.shift.approved_payable_seconds, "0.000000");
  } finally {
    await f.cleanup();
  }
});

test("HTTP clean bulk approval is reviewed, atomic, versioned and safely retryable; corrections invalidate approval", async () => {
  const f = await attendanceFixture();
  try {
    const id = await start(f);
    await advance(f, 60);
    await out(f, id);
    const filters = { from: f.day, to: f.day, employeeId: f.ids.a };
    const p = await ok(await send(f, "bulk-preview", { filters }, "admin"));
    assert.equal(p.eligible.length, 1);
    assert.equal(p.eligible[0].employeeName, "Test A " + f.suffix);
    assert.equal((await detail(f, id)).shift.approved_payable_seconds, null);
    assert.equal(
      (
        await send(
          f,
          "bulk-approve",
          { filters, expected: [{ id, version: p.eligible[0].version + 1 }] },
          "admin",
        )
      ).status,
      409,
    );
    const input = {
      operationKey: randomUUID(),
      filters,
      expected: p.eligible.map(({ id, version }: any) => ({ id, version })),
    };
    await ok(await send(f, "bulk-approve", input, "admin"));
    assert.equal(
      (await ok(await send(f, "bulk-approve", input, "admin"))).replayed,
      true,
    );
    const row = await detail(f, id),
      req = (
        await ok(
          await send(f, "corrections", {
            kind: "AMEND_SHIFT",
            shiftId: id,
            expectedVersion: row.shift.version,
            reason,
            proposed: {
              clockedInAt: row.shift.clocked_in_at,
              clockedOutAt: row.shift.clocked_out_at,
            },
          }),
          201,
        )
      ).id;
    await ok(
      await send(
        f,
        "corrections/" + req + "/review",
        { expectedVersion: 1, decision: "APPROVED", reason },
        "admin",
      ),
    );
    assert.equal((await detail(f, id)).shift.approved_payable_seconds, null);
    await ok(await send(f, "bulk-approve", input, "admin"));
    assert.equal((await detail(f, id)).shift.approved_payable_seconds, null);
  } finally {
    await f.cleanup();
  }
});

test("HTTP AMEND/ADD requests and immutable decisions preserve actual evidence; invalid targets and conflicting operation keys fail", async () => {
  const f = await attendanceFixture();
  try {
    const id = await start(f);
    await advance(f, 60);
    await out(f, id);
    const row = await detail(f, id),
      input = {
        operationKey: randomUUID(),
        kind: "AMEND_SHIFT",
        shiftId: id,
        expectedVersion: row.shift.version,
        reason,
        proposed: {
          clockedInAt: row.shift.clocked_in_at,
          clockedOutAt: row.shift.clocked_out_at,
        },
      };
    const req = (await ok(await send(f, "corrections", input), 201)).id;
    assert.equal((await ok(await send(f, "corrections", input), 201)).id, req);
    assert.equal(
      (await send(f, "corrections", { ...input, reason: reason + " changed" }))
        .status,
      409,
    );
    await ok(
      await send(
        f,
        "corrections/" + req + "/review",
        { expectedVersion: 1, decision: "REJECTED", reason },
        "admin",
      ),
    );
    assert.equal(
      (
        await send(
          f,
          "corrections/" + req + "/review",
          { expectedVersion: 1, decision: "APPROVED", reason },
          "admin",
        )
      ).status,
      409,
    );
    const grant = (await ok(await get(f, "/duties?date=" + f.day, "b")))[0];
    const add = (
      await ok(
        await send(
          f,
          "corrections",
          {
            kind: "ADD_MISSING_SHIFT",
            dutyId: grant.id,
            reason,
            proposed: {
              clockedInAt: row.shift.clocked_in_at,
              clockedOutAt: row.shift.clocked_out_at,
            },
          },
          "b",
        ),
        201,
      )
    ).id;
    const added = (
      await ok(
        await send(
          f,
          "corrections/" + add + "/review",
          { expectedVersion: 1, decision: "APPROVED", reason },
          "admin",
        ),
      )
    ).id;
    const b = await detail(f, added, "b");
    assert.equal(b.shift.recorded_in_at, null);
    assert.equal(b.shift.source, "CORRECTION");
    assert.equal(b.shift.approved_payable_seconds, null);
    assert.equal((await get(f, "/shifts/" + added)).status, 404);
  } finally {
    await f.cleanup();
  }
});

test("HTTP double Clock In and duplicate-click retries serialize without a global time gate", async () => {
  const f = await attendanceFixture();
  try {
    const key = randomUUID();
    const results = await Promise.all([
      send(f, "clock-in", { operationKey: key }),
      send(f, "clock-in", { operationKey: key }),
    ]);
    const ids = await Promise.all(results.map((r) => ok(r, 201)));
    assert.equal(ids[0].id, ids[1].id);
    assert.equal((await send(f, "clock-in", {})).status, 409);
    await advance(f, 60);
    await out(f, ids[0].id);
    const both = await Promise.all([
      send(f, "clock-in", {}),
      send(f, "clock-in", {}),
    ]);
    assert.deepEqual(both.map((r) => r.status).sort(), [201, 409]);
  } finally {
    await f.cleanup();
  }
});

test("HTTP revoke versus Clock In uses real row contention; committed revoke prevents next HTTP and direct duty query access", async () => {
  const f = await attendanceFixture();
  try {
    await f.owner.query("BEGIN");
    await f.owner.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
      f.ids.a,
    ]);
    const pending = send(f, "clock-in", {});
    await blocked(f.owner, "private.attendance_command");
    await f.owner.query("SELECT set_config('app.session_hash',$1,true)", [
      digest(f.tokens.admin),
    ]);
    await f.owner.query(
      "SELECT private.mutate_duty($1::uuid[],$2::date,'REVOKE',$3)",
      [[f.ids.a], f.day, reason],
    );
    await f.owner.query("COMMIT");
    assert.ok((await pending).status >= 400);
    const id = await start(f, "b");
    await advance(f, 60);
    const row = await detail(f, id, "b");
    await ok(
      await send(
        f,
        "shifts/" + id + "/breaks",
        { expectedVersion: row.shift.version, code: "SHORT" },
        "b",
      ),
      201,
    );
    await advance(f, 60);
    await mutateDuty(await session(f.tokens.admin), {
      employeeIds: [f.ids.b],
      date: f.day,
      action: "REVOKE",
      reason,
    });
    assert.equal((await get(f, "/current", "b")).status, 401);
    const saved = (
      await f.owner.query(
        "SELECT clocked_out_at,flags,approved_payable_seconds FROM attendance_shifts WHERE id=$1",
        [id],
      )
    ).rows[0];
    assert.equal(saved.clocked_out_at.toISOString(), f.now.toISOString());
    assert.ok(saved.flags.includes("DUTY_REVOKED"));
    assert.equal(saved.approved_payable_seconds, null);
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

test("HTTP Clock Out versus break and correction versus punch retain valid serial outcomes", async () => {
  const f = await attendanceFixture();
  try {
    const id = await start(f);
    await advance(f, 60);
    let row = await detail(f, id);
    const results = await Promise.all([
      send(f, "shifts/" + id + "/clock-out", {
        expectedVersion: row.shift.version,
      }),
      send(f, "shifts/" + id + "/breaks", {
        expectedVersion: row.shift.version,
        code: "MEAL",
      }),
    ]);
    assert.equal(results.filter((r) => r.ok).length, 1);
    row = await detail(f, id);
    if (!row.shift.clocked_out_at) await out(f, id);
    const next = await start(f);
    await advance(f, 60);
    row = await detail(f, next);
    const req = (
      await ok(
        await send(f, "corrections", {
          kind: "AMEND_SHIFT",
          shiftId: next,
          expectedVersion: row.shift.version,
          reason,
          proposed: {
            clockedInAt: row.shift.clocked_in_at,
            clockedOutAt: f.now.toISOString(),
          },
        }),
        201,
      )
    ).id;
    await f.owner.query("BEGIN");
    await f.owner.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
      f.ids.a,
    ]);
    const review = send(
      f,
      "corrections/" + req + "/review",
      { expectedVersion: 1, decision: "APPROVED", reason },
      "admin",
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
    assert.equal((await review).status, 409);
    assert.equal(
      (await detail(f, next)).shift.recorded_out_at,
      f.now.toISOString().replace(".000Z", "+00:00"),
    );
  } finally {
    await f.owner.query("ROLLBACK");
    await f.cleanup();
  }
});

test("HTTP protections enforce CSRF, origin, bounded bodies, configured policy and privileged review controls", async () => {
  const f = await attendanceFixture();
  try {
    assert.equal(
      (await send(f, "clock-in", {}, "a", { origin: "http://evil.invalid" }))
        .status,
      403,
    );
    assert.equal(
      (
        await fetch(origin + "/api/attendance/clock-in", {
          method: "POST",
          headers: {
            origin,
            "content-type": "application/json",
            cookie: jar(f).cookie,
          },
          body: JSON.stringify({ operationKey: randomUUID(), csrf: "bad" }),
        })
      ).status,
      403,
    );
    assert.equal(
      (await send(f, "clock-in", { padding: "x".repeat(131073) })).status,
      413,
    );
    const p = await ok(await get(f, "/policy", "admin"));
    const { policyId, ...configuration } = p;
    assert.equal(
      (
        await send(f, "policy", {
          expectedPolicyId: policyId,
          configuration,
          reason,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await send(
          f,
          "policy",
          {
            expectedPolicyId: policyId,
            configuration: {
              ...configuration,
              breakCodes: [{ ...configuration.breakCodes[0], paid: "false" }],
            },
            reason,
          },
          "admin",
        )
      ).status,
      400,
    );
    await ok(
      await send(
        f,
        "policy",
        {
          expectedPolicyId: policyId,
          configuration: { ...configuration, bulkMaxDays: 1 },
          reason,
        },
        "admin",
      ),
    );
    assert.equal(
      (
        await send(
          f,
          "bulk-preview",
          {
            filters: {
              to: new Date(new Date(f.day + "T00:00:00Z").getTime() + 86400000)
                .toISOString()
                .slice(0, 10),
            },
          },
          "admin",
        )
      ).status,
      400,
    );
  } finally {
    await f.cleanup();
  }
});

test("HTTP overnight grant switching cannot strand an open shift; expiry reconciles at original window with no next-date grant", async () => {
  const f = await attendanceFixture();
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
    const administrator = await session(f.tokens.admin);
    await mutateDuty(administrator, {
      employeeIds: [f.ids.a],
      date: f.day,
      action: "REVOKE",
      reason,
    });
    const next = new Date(new Date(f.day + "T00:00:00Z").getTime() + 86400000)
      .toISOString()
      .slice(0, 10);
    await mutateDuty(administrator, {
      employeeIds: [f.ids.a],
      date: f.day,
      action: "REGRANT",
      overnight: true,
      validUntil: next + "T08:00:00+08:00",
      reason,
    });
    const net = digest(randomUUID()),
      ch = await startDuty(f.tokens.a, f.day, f.password, false, net),
      issued = await completeDutyStage(
        f.tokens.a,
        ch.challenge,
        "TOTP",
        otp(f.duty.a.secret, f.now.getTime()),
        net,
      );
    if (issued.kind !== "SESSION") throw new Error("Session required");
    f.duty.a.token = issued.token;
    f.tokens.a = issued.account!.token;
    f.a = await workSession(undefined, issued.token);
    const id = await start(f);
    await advance(f, 14 * 3600);
    await freshDuty(f);
    let current = await ok(await get(f, "/current"));
    assert.equal(current.active.shift.duty_date, f.day);
    await freshAdmin(f);
    await mutateDuty(await session(f.tokens.admin), {
      employeeIds: [f.ids.a],
      date: next,
      action: "ACTIVATE",
      reason,
    });
    await advance(f, 30); // New TOTP step, same original open shift.
    const account = await login("a_" + f.suffix, f.password, net);
    f.tokens.a = account.token;
    const pending = await startDuty(f.tokens.a, next, f.password, false, net);
    const r = await fetch(origin + "/api/auth/duty/totp", {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        cookie: "libetario_session=" + f.tokens.a,
      },
      body: JSON.stringify({
        csrf: pending.csrf,
        challenge: pending.challenge,
        binding: "ACCOUNT",
        code: otp(f.duty.a.secret, f.now.getTime()),
      }),
    });
    assert.equal(r.status, 409, await r.text());
    current = await ok(await get(f, "/current"));
    assert.equal(current.active.shift.id, id);
    await advance(f, 8 * 3600);
    await f.owner.query("SELECT private.attendance_reconcile_due()");
    const saved = (
      await f.owner.query("SELECT * FROM attendance_shifts WHERE id=$1", [id])
    ).rows[0];
    assert.equal(
      saved.clocked_out_at.toISOString(),
      saved.grant_until.toISOString(),
    );
    assert.ok(saved.flags.includes("MISSING_CLOCK_OUT"));
    assert.equal(saved.approved_payable_seconds, null);
    assert.equal((await get(f, "/current")).status, 401);
  } finally {
    await f.cleanup();
  }
});
