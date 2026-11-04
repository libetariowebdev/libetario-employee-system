import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { fixture, digest } from "../helpers";
import {
  session,
  login,
  logout,
  changePassword,
  requestReset,
  completeReset,
} from "../../src/server/auth/service";
import { db, authPool, scoped } from "../../src/server/db";
import { api } from "../../src/server/http/api";
import {
  employeeDetails,
  addRate,
  addSchedule,
  editEmployee,
  createEmployee,
  updateSecurity,
} from "../../src/server/services/employees";
import { csrfAnonymous } from "../../src/server/auth/security";
let f: Awaited<ReturnType<typeof fixture>>;
before(async () => {
  f = await fixture();
});
after(async () => {
  await f.owner.end();
  await db.$disconnect();
  await authPool.end();
});
const net = () => digest(randomUUID());
function request(
  path: string,
  method = "GET",
  body?: unknown,
  token?: string,
  origin = "http://127.0.0.1:3000",
) {
  return new Request("http://127.0.0.1:3000/api/" + path, {
    method,
    headers: {
      origin,
      "Content-Type": "application/json",
      ...(token ? { cookie: `libetario_session=${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
test("password authentication supports email and username, hashes tokens, and logout revokes replay", async () => {
  const result = await login(
    `A_${f.suffix}@EXAMPLE.INVALID`,
    f.password,
    net(),
  );
  const s = await session(result.token);
  assert.equal(s.user_id, f.ids.a);
  assert.equal(s.role, "EMPLOYEE");
  const row = (
    await f.owner.query("SELECT token_hash,scope FROM sessions WHERE id=$1", [
      s.session_id,
    ])
  ).rows[0];
  assert.equal(row.token_hash, digest(result.token));
  assert.equal(row.scope, "ACCOUNT");
  await logout(s);
  await assert.rejects(() => session(result.token));
  assert.equal(
    (await session((await login(`a_${f.suffix}`, f.password, net())).token))
      .user_id,
    f.ids.a,
  );
});
test("five failures lock the canonical account across email/username; expiry permits a new login", async () => {
  const n = net();
  for (let i = 0; i < 5; i++)
    await assert.rejects(() =>
      login(
        i % 2 ? `a_${f.suffix}` : `a_${f.suffix}@example.invalid`,
        "Incorrect-Password-Value",
        n,
      ),
    );
  await assert.rejects(() => login(`a_${f.suffix}`, f.password, net()));
  const counter = (
    await f.owner.query(
      "SELECT failure_count,locked_until FROM security_throttles WHERE scope='LOGIN_ACCOUNT' AND subject_digest=$1",
      [digest(f.ids.a)],
    )
  ).rows[0];
  assert.equal(counter.failure_count, 5);
  assert.ok(counter.locked_until);
  await f.owner.query(
    "UPDATE security_throttles SET locked_until=clock_timestamp()-interval '1 second' WHERE scope='LOGIN_ACCOUNT' AND subject_digest=$1",
    [digest(f.ids.a)],
  );
  assert.ok((await login(`a_${f.suffix}`, f.password, net())).token);
});
test("concurrent wrong passwords serialize counters and cannot bypass account lockout", async () => {
  const n = net();
  await Promise.all(
    Array.from({ length: 7 }, () =>
      login(`b_${f.suffix}`, "Incorrect-Password-Value", n).catch(() => null),
    ),
  );
  const row = (
    await f.owner.query(
      "SELECT failure_count FROM security_throttles WHERE scope='LOGIN_ACCOUNT' AND subject_digest=$1",
      [digest(f.ids.b)],
    )
  ).rows[0];
  assert.equal(row.failure_count, 5);
  await f.owner.query(
    "UPDATE security_throttles SET locked_until=clock_timestamp()-interval '1 second' WHERE scope='LOGIN_ACCOUNT' AND subject_digest=$1",
    [digest(f.ids.b)],
  );
});
test("session idle/absolute expiration and credential-version mismatch are rejected", async () => {
  for (const mode of ["idle", "absolute", "version"]) {
    const x = await login(`a_${f.suffix}`, f.password, net());
    if (mode === "idle")
      await f.owner.query(
        "UPDATE sessions SET created_at=clock_timestamp()-interval '2 hour',idle_expires_at=clock_timestamp()-interval '1 minute' WHERE token_hash=$1",
        [digest(x.token)],
      );
    if (mode === "absolute")
      await f.owner.query(
        "UPDATE sessions SET created_at=clock_timestamp()-interval '2 hour',idle_expires_at=clock_timestamp()-interval '1 minute',absolute_expires_at=clock_timestamp()-interval '1 minute' WHERE token_hash=$1",
        [digest(x.token)],
      );
    if (mode === "version")
      await f.owner.query(
        "UPDATE sessions SET authorization_version=authorization_version+1 WHERE token_hash=$1",
        [digest(x.token)],
      );
    await assert.rejects(() => session(x.token));
  }
});
test("server API blocks cross-employee, forged admin, and forged ownership access", async () => {
  assert.equal(
    (
      await api(request("admin/employees", "GET", undefined, f.tokens.a), [
        "admin",
        "employees",
      ])
    ).status,
    403,
  );
  const a = await session(f.tokens.a);
  const denied = await api(
    request(
      "admin/employees",
      "POST",
      { csrf: a.csrf, role: "ADMINISTRATOR" },
      f.tokens.a,
    ),
    ["admin", "employees"],
  );
  assert.equal(denied.status, 403);
  const own = await api(
    request("me?employee_id=" + f.ids.b, "GET", undefined, f.tokens.a),
    ["me"],
  );
  assert.equal(own.status, 200);
  const body = await own.json();
  assert.equal(body.user_id, f.ids.a);
  assert.ok(!JSON.stringify(body).includes("250.5000"));
  await assert.rejects(() => employeeDetails(a, f.ids.b));
});
test("CSRF rejects missing token, mismatched token, hostile origin, and cross-site metadata", async () => {
  const s = await session(f.tokens.admin);
  for (const [csrf, origin] of [
    ["", "http://127.0.0.1:3000"],
    ["bad", "http://127.0.0.1:3000"],
    [s.csrf, "https://attacker.invalid"],
  ])
    assert.equal(
      (
        await api(
          request("auth/logout", "POST", { csrf }, f.tokens.admin, origin),
          ["auth", "logout"],
        )
      ).status,
      403,
    );
  const req = request("auth/logout", "POST", { csrf: s.csrf }, f.tokens.admin);
  req.headers.set("sec-fetch-site", "cross-site");
  assert.equal((await api(req, ["auth", "logout"])).status, 403);
  const anon = csrfAnonymous();
  const r = request("auth/login", "POST", {
    identifier: "a_" + f.suffix,
    password: f.password,
    csrf: anon,
  });
  r.headers.set("cookie", "libetario_csrf=" + anon);
  assert.equal((await api(r, ["auth", "login"])).status, 200);
});
test("restricted runtime role cannot read credentials, session-token hashes, reset tokens or other schedules", async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query("SELECT set_config('app.session_hash',$1,false)", [
      digest(f.tokens.a),
    ]);
    for (const sql of [
      "SELECT password_hash FROM users",
      "SELECT token_hash FROM sessions",
      "SELECT * FROM credential_resets",
      "SELECT * FROM security_throttles",
      "SET ROLE libetario_auth",
    ])
      await assert.rejects(() => c.query(sql));
    assert.equal(
      (await c.query("SELECT id FROM users WHERE id=$1", [f.ids.b])).rowCount,
      0,
    );
    assert.equal((await c.query("SELECT * FROM auth_events")).rowCount, 0);
    assert.equal((await c.query("SELECT * FROM audit_log")).rowCount, 0);
    assert.equal((await c.query("SELECT * FROM company_settings")).rowCount, 0);
  } finally {
    await c.end();
  }
});
test("new employee credentials force a password change; change revokes all sessions", async () => {
  const admin = await session(f.tokens.admin);
  const created = await createEmployee(admin, {
    employee_number: "NEW-" + f.suffix,
    legal_name: "New Test Employee",
    display_name: "New Test",
    contact: null,
    designation: "Editor",
    start_date: "2026-01-01",
    email: `new_${f.suffix}@example.invalid`,
    username: `new_${f.suffix}`,
  });
  const x = await login(`new_${f.suffix}`, created.temporaryPassword, net());
  await assert.rejects(() => session(x.token));
  const s = await session(x.token, true);
  assert.equal(s.must_change_password, true);
  const next = "Changed-" + randomUUID();
  await changePassword(s, created.temporaryPassword, next, net());
  await assert.rejects(() => session(x.token));
  const fresh = await session(
    (await login(`new_${f.suffix}`, next, net())).token,
  );
  assert.equal(fresh.must_change_password, false);
});
test("rate changes retain exact historical amount, close old interval, and reject concurrent duplicate dates", async () => {
  const s = await session(f.tokens.admin);
  const rate = {
    basis: "HOURLY",
    amount: "175.4321",
    effective_from: "2026-10-30",
    expected_daily_seconds: 28800,
    reason: "Owner approved a new hourly rate",
  };
  const results = await Promise.allSettled([
    addRate(s, f.ids.a, rate),
    addRate(s, f.ids.a, rate),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const p = await employeeDetails(await session(f.tokens.a), f.ids.a);
  assert.equal(p.employee_rate_history.length, 2);
  assert.equal(p.employee_rate_history[1].amount, "100.1250");
  assert.equal(
    p.employee_rate_history[1].effective_to?.toISOString().slice(0, 10),
    "2026-10-30",
  );
  await assert.rejects(() => addRate(awaitSession as never, f.ids.a, rate));
});
// A deliberately invalid context cannot manufacture administrative authority.
const awaitSession = {
  role: "EMPLOYEE",
  must_change_password: false,
  hash: "0".repeat(64),
};
test("database exclusion constraints reject overlapping rates, not just service validation", async () => {
  await assert.rejects(
    () =>
      f.owner.query(
        "INSERT INTO employee_rate_history(employee_id,basis,amount,effective_from,expected_daily_seconds,pay_policy_id,created_by) VALUES($1,'DAILY','200','2026-10-29',28800,$2,$3)",
        [f.ids.a, f.policies.pay_policy_id, f.ids.admin],
      ),
    (e: unknown) => (e as { code: string }).code === "23P01",
  );
});
test("schedule history is owner-only, keeps distinct days, and invalid overlaps/overnight defaults fail", async () => {
  const s = await session(f.tokens.admin);
  const schedule = {
    effective_from: "2026-10-30",
    expected_daily_seconds: 28800,
    reason: "Owner approved the weekly schedule",
    days: Array.from({ length: 7 }, (_, i) => ({
      weekday: i + 1,
      working_day: i < 5,
      start_local: i < 5 ? "09:00" : null,
      end_local: i < 5 ? "17:00" : null,
      ends_next_day: false,
      paid_break_seconds: i < 5 ? 1800 : 0,
      unpaid_break_seconds: 0,
    })),
  };
  const created = await addSchedule(s, f.ids.a, schedule);
  const own = await employeeDetails(await session(f.tokens.a), f.ids.a);
  assert.equal(
    own.employee_schedule_history[0].employee_schedule_days.length,
    7,
  );
  const other = await scoped(digest(f.tokens.b), (tx) =>
    tx.employee_schedule_days.findMany({ where: { schedule_id: created.id } }),
  );
  assert.equal(other.length, 0);
  await assert.rejects(() => addSchedule(s, f.ids.a, schedule));
  await assert.rejects(() =>
    addSchedule(s, f.ids.a, {
      ...schedule,
      effective_from: "2026-11-01",
      days: schedule.days.map((d) =>
        d.weekday === 1
          ? {
              ...d,
              start_local: "22:00",
              end_local: "06:00",
              ends_next_day: true,
            }
          : d,
      ),
    }),
  );
});
test("audit events are append-only and contain reasons but no password hashes or raw reset tokens", async () => {
  const events = await scoped(digest(f.tokens.admin), (tx) =>
    tx.audit_log.findMany({ where: { actor_user_id: f.ids.admin } }),
  );
  assert.ok(events.length > 0);
  assert.ok(
    JSON.stringify(events).includes("Owner approved a new hourly rate"),
  );
  assert.ok(!JSON.stringify(events).includes("$argon2id$"));
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    for (const table of ["audit_log", "auth_events"])
      for (const sql of [
        `UPDATE ${table} SET id=id`,
        `DELETE FROM ${table}`,
        `TRUNCATE ${table}`,
      ])
        await assert.rejects(() => c.query(sql));
  } finally {
    await c.end();
  }
});
test("admin reset invalidates existing sessions, stores only a hash, expires, and consumes once under concurrency", async () => {
  const admin = await session(f.tokens.admin),
    old = await login(`b_${f.suffix}`, f.password, net());
  const token = await requestReset(
    admin,
    f.ids.b,
    "Identity checked by a private video call",
  );
  await assert.rejects(() => session(old.token));
  const row = (
    await f.owner.query(
      "SELECT token_hash FROM credential_resets WHERE user_id=$1 ORDER BY created_at DESC",
      [f.ids.b],
    )
  ).rows[0];
  assert.equal(row.token_hash, digest(token));
  assert.notEqual(row.token_hash, token);
  const next = "Reset-" + randomUUID();
  const results = await Promise.allSettled([
    completeReset(token, next, net()),
    completeReset(token, next, net()),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    (await session((await login(`b_${f.suffix}`, next, net())).token)).user_id,
    f.ids.b,
  );
  const expired = await requestReset(
    admin,
    f.ids.b,
    "Identity verified via the registered contact",
  );
  await f.owner.query(
    "UPDATE credential_resets SET created_at=clock_timestamp()-interval '1 hour',expires_at=clock_timestamp()-interval '1 minute' WHERE token_hash=$1",
    [digest(expired)],
  );
  await assert.rejects(() =>
    completeReset(expired, "Expired-" + randomUUID(), net()),
  );
});
test("disabling staff immediately revokes sessions and retains their profile/rate history", async () => {
  const admin = await session(f.tokens.admin),
    p = await employeeDetails(admin, f.ids.a);
  await editEmployee(admin, f.ids.a, {
    employee_number: p.employee_number,
    legal_name: p.legal_name,
    display_name: p.display_name,
    contact: p.contact,
    designation: p.designation,
    start_date: p.start_date.toISOString().slice(0, 10),
    email: p.users.email,
    username: p.users.username,
    employment_status: "INACTIVE",
    version: p.version,
    reason: "Owner disabled the departing employee account",
  });
  await assert.rejects(() => session(f.tokens.a));
  await assert.rejects(() => login(`a_${f.suffix}`, f.password, net()));
  assert.equal(
    (await employeeDetails(admin, f.ids.a)).employee_rate_history.length,
    2,
  );
});
test("network lockout applies across unrelated identifiers and rejects a correct password while locked", async () => {
  const network = net();
  for (let i = 0; i < 30; i++)
    await assert.rejects(() =>
      login(`unknown_${randomUUID()}`, "Incorrect-Password-Value", network),
    );
  await assert.rejects(() => login(`admin_${f.suffix}`, f.password, network));
  const row = (
    await f.owner.query(
      "SELECT failure_count,locked_until>clock_timestamp() locked FROM security_throttles WHERE scope='LOGIN_NETWORK' AND subject_digest=$1",
      [network],
    )
  ).rows[0];
  assert.equal(row.failure_count, 30);
  assert.equal(row.locked, true);
});
test("replacement reset tokens invalidate predecessors; reset-token lockout prevents repeated reuse of current password", async () => {
  const temp = await fixture();
  try {
    const admin = await session(temp.tokens.admin);
    const first = await requestReset(
      admin,
      temp.ids.a,
      "Verified identity through a private call",
    );
    const second = await requestReset(
      admin,
      temp.ids.a,
      "Reissued after confirming the same identity",
    );
    await assert.rejects(() =>
      completeReset(first, "New-" + randomUUID(), net()),
    );
    for (let i = 0; i < 5; i++)
      await assert.rejects(() => completeReset(second, temp.password, net()));
    await assert.rejects(() =>
      completeReset(second, "New-" + randomUUID(), net()),
    );
    const row = (
      await temp.owner.query(
        "SELECT failure_count,locked_until>clock_timestamp() locked FROM security_throttles WHERE scope='RESET_TOKEN' AND subject_digest=$1",
        [digest(second)],
      )
    ).rows[0];
    assert.equal(row.failure_count, 5);
    assert.equal(row.locked, true);
  } finally {
    await temp.owner.end();
  }
});
test("only the forty-three checkpoint 5b tables migrate and every application table has RLS enabled", async () => {
  const rows = (
    await f.owner.query(
      "SELECT c.relname,c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname<>'_prisma_migrations' ORDER BY c.relname",
    )
  ).rows;
  assert.deepEqual(
    rows.map((r) => r.relname),
    [
      "attendance_adjustments",
      "attendance_breaks",
      "attendance_shifts",
      "audit_log",
      "auth_challenges",
      "auth_events",
      "company_settings",
      "credential_resets",
      "daily_report_entries",
      "daily_reports",
      "deduction_types",
      "duty_authorizations",
      "earning_types",
      "employee_pins",
      "employee_profiles",
      "employee_rate_history",
      "employee_schedule_days",
      "employee_schedule_history",
      "file_objects",
      "mfa_enrollments",
      "payments",
      "payroll_adjustments",
      "payroll_item_attendance",
      "payroll_items",
      "payroll_lines",
      "payroll_periods",
      "payslips",
      "policy_versions",
      "project_files",
      "projects",
      "recovery_codes",
      "security_throttles",
      "sessions",
      "submission_files",
      "task_assignments",
      "task_comments",
      "task_files",
      "task_reviews",
      "task_segment_adjustments",
      "task_submissions",
      "task_time_segments",
      "tasks",
      "users",
    ],
  );
  assert.ok(rows.every((r) => r.relrowsecurity));
});
test("invalid security policies, extra role fields and oversized streamed bodies are rejected", async () => {
  const s = await session(f.tokens.admin);
  await assert.rejects(() =>
    updateSecurity(s, {
      configuration: { idleMinutes: 9999 },
      reason: "Invalid policy should not save",
    }),
  );
  await assert.rejects(() => createEmployee(s, { role: "ADMINISTRATOR" }));
  const r = request("auth/login", "POST", {
    identifier: "x",
    password: "x",
    csrf: "a",
    padding: "x".repeat(33000),
  });
  assert.equal((await api(r, ["auth", "login"])).status, 413);
});
