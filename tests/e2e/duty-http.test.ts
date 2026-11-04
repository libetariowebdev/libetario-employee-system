import {
  dutyFixture,
  enrollDuty,
  freeze,
  setPolicy,
  securityConfig,
} from "../duty-helpers";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { db, authPool } from "../../src/server/db";
import { digest, csrfForSession } from "../../src/server/auth/security";
import { otp } from "../../src/lib/mfa-crypto";
const origin = process.env.HTTP_TEST_ORIGIN ?? "http://127.0.0.1:3001";
if (!["127.0.0.1", "localhost"].includes(new URL(origin).hostname))
  throw new Error("Local test origin required");
after(async () => {
  await db.$disconnect();
  await authPool.end();
});
type F = Awaited<ReturnType<typeof dutyFixture>>;
type Jar = Record<string, string>;
const account = (token: string): Jar => ({ libetario_session: token });
function cookies(jar: Jar) {
  return Object.entries(jar)
    .map(([k, v]) => k + "=" + v)
    .join("; ");
}
function absorb(jar: Jar, r: Response) {
  for (const value of r.headers.getSetCookie()) {
    const [name, ...rest] = value.split(";")[0].split("=");
    jar[name] = rest.join("=");
  }
}
async function get(path: string, jar: Jar = {}) {
  return fetch(origin + "/api/" + path, { headers: { cookie: cookies(jar) } });
}
async function post(
  path: string,
  jar: Jar,
  csrf: string,
  data: Record<string, unknown> = {},
) {
  const r = await fetch(origin + "/api/" + path, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      cookie: cookies(jar),
    },
    body: JSON.stringify({ ...data, csrf }),
  });
  absorb(jar, r);
  return r;
}
async function jsonOK(r: Response) {
  assert.equal(r.status, 200);
  return r.json();
}
async function activate(
  f: F,
  who: "a" | "b" = "a",
  action = "ACTIVATE",
  extra: Record<string, unknown> = {},
) {
  return post(
    "admin/duty",
    account(f.tokens.admin),
    csrfForSession(f.tokens.admin),
    {
      employeeIds: [f.ids[who]],
      date: f.day,
      action,
      reason: "Approved HTTP duty authorization test",
      ...extra,
    },
  );
}
async function advance(f: F, seconds = 30) {
  f.now = new Date(f.now.getTime() + seconds * 1000);
  await freeze(f.owner, f.now);
}
async function start(f: F, jar: Jar) {
  return jsonOK(
    await post("auth/duty/start", jar, csrfForSession(jar.libetario_session), {
      date: f.day,
      password: f.password,
    }),
  );
}
async function stage(
  jar: Jar,
  ch: any,
  code: string,
  type = "totp",
  binding = "ACCOUNT",
) {
  return post("auth/duty/" + type, jar, ch.csrf, {
    challenge: ch.challenge,
    code,
    binding,
  });
}
async function authenticated(f: F) {
  const e = await enrollDuty(f, f.now),
    jar = account(e.token);
  await jsonOK(await activate(f));
  await advance(f);
  const ch = await start(f, jar);
  await jsonOK(await stage(jar, ch, otp(e.secret, f.now.getTime())));
  return { ...e, jar };
}
async function blocked(c: pg.Client, fragment: string) {
  for (let i = 0; i < 150; i++) {
    await c.query("SELECT pg_stat_clear_snapshot()");
    const r = await c.query(
      "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid() AND query LIKE $1",
      ["%" + fragment + "%"],
    );
    if (r.rowCount) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Expected database lock was not observed");
}

test("HTTP scenario 1: admin activates A, B denied; ACCOUNT cannot reach duty endpoint/page; own status and runtime guard isolate users", async () => {
  const f = await dutyFixture(),
    c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    const e = await enrollDuty(f, f.now),
      jar = account(e.token),
      b = account(f.tokens.b);
    await jsonOK(await activate(f));
    assert.equal((await get("duty/context", jar)).status, 401);
    assert.equal(
      (
        await post("auth/duty/start", b, csrfForSession(f.tokens.b), {
          date: f.day,
          password: f.password,
        })
      ).status,
      401,
    );
    const mine = await jsonOK(await get("duty/status?date=" + f.day, jar)),
      other = await jsonOK(await get("duty/status?date=" + f.day, b));
    assert.equal(mine.grants.length, 1);
    assert.equal(other.grants.length, 0);
    const wrong = await post("auth/duty/start", jar, csrfForSession(e.token), {
      date: f.day,
      password: "Wrong-password-for-test",
    });
    assert.equal(wrong.status, 401);
    assert.equal(
      (await wrong.json()).error,
      "Authentication failed or temporarily unavailable",
    );
    await advance(f);
    const ch = await start(f, jar);
    assert.equal(ch.stage, "TOTP");
    await jsonOK(await stage(jar, ch, otp(e.secret, f.now.getTime())));
    const context = await jsonOK(await get("duty/context", jar));
    assert.equal(context.user_id, f.ids.a);
    assert.equal(context.duty_date.slice(0, 10), f.day);
    const punched = await post(
      "attendance/clock-in",
      jar,
      csrfForSession(jar.libetario_duty),
      { operationKey: randomUUID() },
    );
    assert.equal(punched.status, 201);
    const shift = (await punched.json()).id;
    assert.equal(
      (
        await post("attendance/clock-in", b, csrfForSession(f.tokens.b), {
          operationKey: randomUUID(),
        })
      ).status,
      401,
    );
    await jsonOK(
      await post(
        `attendance/shifts/${shift}/clock-out`,
        jar,
        csrfForSession(jar.libetario_duty),
        { operationKey: randomUUID(), expectedVersion: 1 },
      ),
    );
    const page = await fetch(origin + "/duty/context", {
      headers: { cookie: cookies(jar) },
    });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes("Duty access verified."));
    assert.ok(!html.includes("otpauth://"));
    assert.ok(!html.includes("password_hash"));
    const accountOnly = await fetch(origin + "/duty/context", {
      headers: { cookie: cookies(b) },
      redirect: "manual",
    });
    assert.equal(accountOnly.status, 307);
    assert.equal(accountOnly.headers.get("location"), "/duty/reauth");
    await c.connect();
    await c.query("SELECT set_config('app.session_hash',$1,false)", [
      digest(jar.libetario_duty),
    ]);
    assert.equal(
      (await c.query("SELECT * FROM private.duty_context()")).rowCount,
      1,
    );
    assert.equal(
      (await get("duty/context", { libetario_duty: jar.libetario_session }))
        .status,
      401,
    );
    const dashboard = await jsonOK(
      await get("admin/duty?date=" + f.day, account(f.tokens.admin)),
    );
    assert.equal(
      dashboard.grants.filter((g: any) => g.employee_id === f.ids.a).length,
      1,
    );
    assert.ok(!JSON.stringify(dashboard.events).includes("network_digest"));
    const adminPage = await fetch(origin + "/admin/duty?date=" + f.day, {
      headers: { cookie: cookies(account(f.tokens.admin)) },
    });
    assert.equal(adminPage.status, 200);
    assert.ok((await adminPage.text()).includes("Authorize the workday."));
    const employeePage = await fetch(origin + "/duty?date=" + f.day, {
      headers: { cookie: cookies(jar) },
    });
    assert.equal(employeePage.status, 200);
    const employeeHtml = await employeePage.text();
    assert.ok(employeeHtml.includes("Secure duty access."));
    assert.ok(!employeeHtml.includes(f.ids.b));
    const oldDuty = jar.libetario_duty;
    await jsonOK(await post("auth/duty/logout", jar, csrfForSession(oldDuty)));
    assert.equal(
      (await get("duty/context", { libetario_duty: oldDuty })).status,
      401,
    );
    assert.equal(
      (await get("duty/access", { libetario_duty: oldDuty })).status,
      401,
    );
    assert.equal((await get("me", jar)).status, 200);
  } finally {
    await c.end();
    await f.cleanup();
  }
});

test("HTTP PIN on: missing PIN denied, wrong/reordered/foreign stages fail, tokens and CSRF rotate without extending deadline", async () => {
  const f = await dutyFixture();
  try {
    const e = await enrollDuty(f, f.now),
      jar = account(e.token);
    await jsonOK(await activate(f));
    await setPolicy(f, "SECURITY", {
      ...(await securityConfig(f)),
      pinEnabled: true,
    });
    assert.equal(
      (
        await post("auth/duty/start", jar, csrfForSession(e.token), {
          date: f.day,
          password: f.password,
        })
      ).status,
      401,
    );
    await advance(f);
    await jsonOK(
      await post("auth/mfa/pin", jar, csrfForSession(e.token), {
        password: f.password,
        pin: "654321",
        code: otp(e.secret, f.now.getTime()),
      }),
    );
    await advance(f);
    const ch = await start(f, jar);
    assert.equal(ch.stage, "PIN");
    assert.equal(
      (await stage(jar, ch, otp(e.secret, f.now.getTime()))).status,
      401,
    );
    assert.equal((await stage(jar, ch, "123123", "pin")).status, 401);
    assert.equal(
      (await stage(account(f.tokens.b), ch, "654321", "pin")).status,
      403,
    );
    assert.equal(
      (
        await post("auth/duty/pin", jar, ch.csrf, {
          challenge: ch.challenge,
          code: "654321",
          binding: "ACCOUNT",
          purpose: "DUTY_REAUTH",
        })
      ).status,
      400,
    );
    const next = await jsonOK(await stage(jar, ch, "654321", "pin"));
    assert.equal(next.stage, "TOTP");
    assert.notEqual(next.challenge, ch.challenge);
    assert.notEqual(next.csrf, ch.csrf);
    assert.equal(next.expiresAt, ch.expiresAt);
    assert.equal((await stage(jar, ch, "654321", "pin")).status, 401);
    assert.equal(
      (
        await post("auth/duty/totp", jar, ch.csrf, {
          challenge: next.challenge,
          code: otp(e.secret, f.now.getTime()),
          binding: "ACCOUNT",
        })
      ).status,
      403,
    );
    await jsonOK(await stage(jar, next, otp(e.secret, f.now.getTime())));
    assert.equal((await get("duty/context", jar)).status, 200);
    await advance(f);
    const access = await jsonOK(await get("duty/access", jar)),
      resume = await jsonOK(await post("auth/duty/reauth", jar, access.csrf));
    assert.equal(resume.stage, "PIN");
    assert.equal(
      (await stage(jar, resume, otp(e.secret, f.now.getTime()), "totp", "DUTY"))
        .status,
      401,
    );
    const resumed = await jsonOK(
      await stage(jar, resume, "654321", "pin", "DUTY"),
    );
    await jsonOK(
      await stage(jar, resumed, otp(e.secret, f.now.getTime()), "totp", "DUTY"),
    );
    // A PIN replacement also revokes already issued duty and any unfinished challenge.
    await advance(f);
    const pending = await start(f, jar);
    await jsonOK(
      await post("auth/mfa/pin", jar, csrfForSession(jar.libetario_session), {
        password: f.password,
        pin: "987654",
        code: otp(e.secret, f.now.getTime()),
      }),
    );
    assert.equal((await get("duty/context", jar)).status, 401);
    assert.equal((await stage(jar, pending, "654321", "pin")).status, 401);
  } finally {
    await f.cleanup();
  }
});

test("HTTP expired/replayed challenges and TOTP across purposes/concurrent sessions cannot bypass persistent lockouts", async () => {
  const f = await dutyFixture();
  try {
    const e = await enrollDuty(f, f.now),
      jar = account(e.token);
    await jsonOK(await activate(f));
    await advance(f);
    await jsonOK(
      await post("auth/mfa/reauth", jar, csrfForSession(e.token), {
        code: otp(e.secret, f.now.getTime()),
      }),
    );
    const ch = await start(f, jar);
    assert.equal(
      (await stage(jar, ch, otp(e.secret, f.now.getTime()))).status,
      401,
    );
    await advance(f, 301);
    assert.equal(
      (await stage(jar, ch, otp(e.secret, f.now.getTime()))).status,
      401,
    );
    const fresh = await start(f, jar),
      competing = await start(f, jar),
      copy = { ...jar };
    const responses = await Promise.all([
      stage(jar, fresh, otp(e.secret, f.now.getTime())),
      stage(copy, competing, otp(e.secret, f.now.getTime())),
    ]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 401]);
    const winner = responses[0].status === 200 ? jar : copy;
    assert.equal((await get("duty/context", winner)).status, 200);
    assert.equal(
      (await stage(account(e.token), fresh, otp(e.secret, f.now.getTime())))
        .status,
      401,
    );
    await advance(f);
    const lockChallenge = await start(f, winner);
    for (let i = 0; i < 5; i++)
      assert.equal((await stage(winner, lockChallenge, "bad")).status, 401);
    const retry = await start(f, winner);
    assert.equal(
      (await stage(winner, retry, otp(e.secret, f.now.getTime()))).status,
      401,
    );
    const row = (
      await f.owner.query(
        "SELECT locked_until>private.security_now() locked FROM security_throttles WHERE scope='TOTP' AND subject_digest=$1",
        [digest(f.ids.a)],
      )
    ).rows[0];
    assert.equal(row.locked, true);
  } finally {
    await f.cleanup();
  }
});

test("HTTP scenario 3: committed revoke denies next HTTP and direct guard query, regrant cannot revive tokens, no history deleted", async () => {
  const f = await dutyFixture(),
    c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    const e = await authenticated(f),
      old = e.jar.libetario_duty;
    await advance(f);
    const pending = await start(f, e.jar);
    const counts = (
      await f.owner.query(
        "SELECT (SELECT count(*) FROM sessions WHERE user_id=$1)::int sessions,(SELECT count(*) FROM employee_rate_history WHERE employee_id=$1)::int rates,(SELECT count(*) FROM mfa_enrollments WHERE user_id=$1)::int enrollments",
        [f.ids.a],
      )
    ).rows[0];
    await jsonOK(await activate(f, "a", "REVOKE"));
    assert.equal((await get("duty/context", e.jar)).status, 401);
    await c.connect();
    await c.query("SELECT set_config('app.session_hash',$1,false)", [
      digest(old),
    ]);
    assert.equal(
      (await c.query("SELECT * FROM private.duty_context()")).rowCount,
      0,
    );
    assert.equal(
      (await stage(e.jar, pending, otp(e.secret, f.now.getTime()))).status,
      401,
    );
    assert.equal((await activate(f)).status, 409);
    await jsonOK(await activate(f, "a", "REGRANT"));
    assert.equal((await get("duty/context", e.jar)).status, 401);
    assert.equal(
      (await post("auth/duty/reauth", e.jar, csrfForSession(old))).status,
      401,
    );
    const after = (
      await f.owner.query(
        "SELECT (SELECT count(*) FROM sessions WHERE user_id=$1)::int sessions,(SELECT count(*) FROM employee_rate_history WHERE employee_id=$1)::int rates,(SELECT count(*) FROM mfa_enrollments WHERE user_id=$1)::int enrollments",
        [f.ids.a],
      )
    ).rows[0];
    assert.deepEqual(after, counts);
    const audit = (
      await f.owner.query(
        "SELECT payload FROM audit_log WHERE action='duty.revoke' AND payload->>'employee_id'=$1",
        [f.ids.a],
      )
    ).rows[0].payload;
    assert.ok(audit.previous.first_authenticated_at);
    assert.equal(audit.previous.authorization_version, 1);
  } finally {
    await c.end();
    await f.cleanup();
  }
});

test("HTTP revoke races final issuance in both lock orders: revoke wins or issued cookie is unusable after revoke commits", async () => {
  for (const order of ["REVOKE_FIRST", "ISSUE_FIRST"]) {
    const f = await dutyFixture();
    let issue: Promise<Response> | undefined,
      revoke: Promise<Response> | undefined;
    try {
      const e = await enrollDuty(f, f.now),
        jar = account(e.token);
      await jsonOK(await activate(f));
      await advance(f);
      const ch = await start(f, jar);
      if (order === "REVOKE_FIRST") {
        await f.owner.query("BEGIN");
        await f.owner.query(
          "SELECT private.mutate_duty($1::uuid[],$2::date,'REVOKE','Deterministic revoke before final issuance',false,NULL)",
          [[f.ids.a], f.day],
        );
        issue = stage(jar, ch, otp(e.secret, f.now.getTime()));
        await blocked(f.owner, "users WHERE id=");
        await f.owner.query("COMMIT");
        assert.equal((await issue).status, 401);
      } else {
        await f.owner.query("BEGIN");
        await f.owner.query(
          "SELECT id FROM mfa_enrollments WHERE id=$1 FOR UPDATE",
          [e.enrollmentId],
        );
        issue = stage(jar, ch, otp(e.secret, f.now.getTime()));
        await blocked(f.owner, "mfa_enrollments");
        revoke = activate(f, "a", "REVOKE");
        await blocked(f.owner, "mutate_duty");
        await f.owner.query("COMMIT");
        assert.equal((await issue).status, 200);
        await jsonOK(await revoke);
      }
      assert.equal((await get("duty/context", jar)).status, 401);
    } finally {
      await f.owner.query("ROLLBACK");
      await Promise.allSettled(
        [issue, revoke].filter(Boolean) as Promise<Response>[],
      );
      await f.cleanup();
    }
  }
});

test("HTTP SECURITY switch invalidates unfinished challenges and duty sessions; account disable and MFA recovery deny duty immediately", async () => {
  const f = await dutyFixture();
  try {
    const e = await authenticated(f);
    await advance(f);
    const ch = await start(f, e.jar);
    const p = (
      await f.owner.query(
        "SELECT security_policy_id FROM company_settings WHERE id=1",
      )
    ).rows[0].security_policy_id;
    await jsonOK(
      await post(
        "admin/settings/security",
        account(f.tokens.admin),
        csrfForSession(f.tokens.admin),
        {
          expectedPolicyId: p,
          configuration: { dutyIdleMinutes: 40 },
          reason: "Test SECURITY policy session invalidation",
        },
      ),
    );
    assert.equal((await get("duty/context", e.jar)).status, 401);
    assert.equal(
      (await stage(e.jar, ch, otp(e.secret, f.now.getTime()))).status,
      401,
    );
    const handle = await jsonOK(await get("duty/access", e.jar)),
      reauth = await jsonOK(await post("auth/duty/reauth", e.jar, handle.csrf));
    await jsonOK(
      await stage(
        e.jar,
        reauth,
        otp(e.secret, f.now.getTime()),
        "totp",
        "DUTY",
      ),
    );
    await advance(f);
    const again = await start(f, e.jar);
    await jsonOK(await stage(e.jar, again, otp(e.secret, f.now.getTime())));
    const pending = await start(f, e.jar),
      anon = await get("auth/csrf"),
      anonJar: Jar = {};
    absorb(anonJar, anon);
    const anonCsrf = (await anon.json()).csrf;
    await jsonOK(
      await post("auth/mfa/recover", anonJar, anonCsrf, {
        identifier: "a_" + f.suffix,
        password: f.password,
        code: e.codes[0],
      }),
    );
    assert.equal((await get("duty/context", e.jar)).status, 401);
    assert.equal((await stage(e.jar, pending, "123456")).status, 401);
    assert.equal((await get("duty/context", anonJar)).status, 401);
    assert.equal((await get("duty/status", anonJar)).status, 403);
    const b = await enrollDuty(f, f.now, "b"),
      bj = account(b.token);
    await jsonOK(await activate(f, "b"));
    await advance(f);
    const bc = await start(f, bj);
    await jsonOK(await stage(bj, bc, otp(b.secret, f.now.getTime())));
    await f.owner.query(
      "UPDATE users SET disabled_at=private.security_now(),authorization_version=authorization_version+1 WHERE id=$1",
      [f.ids.b],
    );
    assert.equal((await get("duty/context", bj)).status, 401);
    assert.equal(
      (await post("auth/duty/reauth", bj, csrfForSession(bj.libetario_duty)))
        .status,
      401,
    );
  } finally {
    await f.cleanup();
  }
});

test("HTTP midnight and overnight: same duty date survives midnight, idle expiry resumes without password, window end denies and next date is never activated", async () => {
  const f = await dutyFixture();
  try {
    const e = await enrollDuty(f, f.now),
      bEnrolled = await enrollDuty(f, f.now, "b"),
      jar = account(e.token),
      bj = account(bEnrolled.token),
      tomorrow = new Date(new Date(f.day + "T00:00:00Z").getTime() + 86400000)
        .toISOString()
        .slice(0, 10);
    assert.equal(
      (
        await activate(f, "a", "ACTIVATE", {
          overnight: true,
          validUntil: tomorrow + "T07:00:00+08:00",
        })
      ).status,
      409,
    );
    const wp = (
      await f.owner.query(
        "SELECT work_policy_id FROM company_settings WHERE id=1",
      )
    ).rows[0].work_policy_id;
    await jsonOK(
      await post(
        "admin/settings/overnight",
        account(f.tokens.admin),
        csrfForSession(f.tokens.admin),
        {
          expectedPolicyId: wp,
          overnightEnabled: true,
          overnightCarryHours: 8,
          reason: "Enable explicit overnight window for testing",
        },
      ),
    );
    await jsonOK(
      await activate(f, "a", "ACTIVATE", {
        overnight: true,
        validUntil: tomorrow + "T07:00:00+08:00",
      }),
    );
    await jsonOK(await activate(f, "b"));
    f.now = new Date(f.day + "T23:55:00+08:00");
    await freeze(f.owner, f.now);
    await f.owner.query(
      "UPDATE sessions SET idle_expires_at=private.security_now()+interval '15 min',absolute_expires_at=private.security_now()+interval '60 min' WHERE token_hash=ANY($1::text[])",
      [[digest(e.token), digest(bEnrolled.token)]],
    );
    const ch = await start(f, jar);
    await jsonOK(await stage(jar, ch, otp(e.secret, f.now.getTime())));
    const bch = await start(f, bj);
    await jsonOK(await stage(bj, bch, otp(bEnrolled.secret, f.now.getTime())));
    f.now = new Date(tomorrow + "T00:05:00+08:00");
    await freeze(f.owner, f.now);
    const context = await jsonOK(await get("duty/context", jar));
    assert.equal(context.duty_date.slice(0, 10), f.day);
    assert.equal((await get("duty/context", bj)).status, 401);
    assert.equal((await get("duty/access", bj)).status, 401);
    // The administrator's ACCOUNT also expired overnight; sign in afresh with password + TOTP.
    const anon = await get("auth/csrf"),
      adminJar: Jar = {};
    absorb(adminJar, anon);
    const csrf = (await anon.json()).csrf;
    await jsonOK(
      await post("auth/login", adminJar, csrf, {
        identifier: "admin_" + f.suffix,
        password: f.password,
      }),
    );
    await jsonOK(
      await post(
        "auth/mfa/verify",
        adminJar,
        csrfForSession(adminJar.libetario_session),
        { code: otp(f.adminSecret, f.now.getTime()) },
      ),
    );
    f.tokens.admin = adminJar.libetario_session;
    await jsonOK(await activate(f, "b", "REVOKE"));
    await jsonOK(
      await activate(f, "b", "REGRANT", {
        overnight: true,
        validUntil: tomorrow + "T07:00:00+08:00",
      }),
    );
    assert.equal(
      (
        await post(
          "auth/duty/start",
          bj,
          csrfForSession(bj.libetario_session),
          { date: f.day, password: f.password },
        )
      ).status,
      401,
    );
    assert.equal((await get("duty/access", bj)).status, 401);
    const currentWork = (
      await f.owner.query(
        "SELECT work_policy_id FROM company_settings WHERE id=1",
      )
    ).rows[0].work_policy_id;
    await jsonOK(
      await post(
        "admin/settings/overnight",
        adminJar,
        csrfForSession(adminJar.libetario_session),
        {
          expectedPolicyId: currentWork,
          overnightEnabled: false,
          overnightCarryHours: 8,
          reason: "Disabling policy preserves approved grant snapshots",
        },
      ),
    );
    assert.equal(
      (
        await jsonOK(
          await activate(f, "a", "ACTIVATE", {
            overnight: true,
            validUntil: tomorrow + "T07:00:00+08:00",
          }),
        )
      ).changed,
      0,
    );
    assert.equal((await get("duty/context", jar)).status, 200);
    f.now = new Date(tomorrow + "T00:36:00+08:00");
    await freeze(f.owner, f.now);
    assert.equal((await get("duty/context", jar)).status, 401);
    const access = await jsonOK(await get("duty/access", jar)),
      resume = await jsonOK(await post("auth/duty/reauth", jar, access.csrf));
    assert.equal(resume.stage, "TOTP");
    await jsonOK(
      await stage(jar, resume, otp(e.secret, f.now.getTime()), "totp", "DUTY"),
    );
    assert.equal(
      (await jsonOK(await get("duty/context", jar))).duty_date.slice(0, 10),
      f.day,
    );
    assert.equal(
      (
        await f.owner.query(
          "SELECT id FROM duty_authorizations WHERE duty_date=$1 AND employee_id=ANY($2::uuid[])",
          [tomorrow, [f.ids.a, f.ids.b]],
        )
      ).rowCount,
      0,
    );
    const b = account(f.tokens.b);
    assert.equal(
      (
        await post("auth/duty/start", b, csrfForSession(f.tokens.b), {
          date: f.day,
          password: f.password,
        })
      ).status,
      401,
    );
    f.now = new Date(tomorrow + "T07:00:00+08:00");
    await freeze(f.owner, f.now);
    assert.equal((await get("duty/context", jar)).status, 401);
    assert.equal((await get("duty/access", jar)).status, 401);
  } finally {
    await f.cleanup();
  }
});

test("HTTP duty absolute limit is twelve hours and bounded by valid_until, independently of cookie retention for MFA reauth", async () => {
  const f = await dutyFixture();
  try {
    const e = await authenticated(f),
      initial = await jsonOK(await get("duty/context", e.jar));
    assert.equal(
      new Date(initial.absolute_expires_at).getTime() - f.now.getTime(),
      12 * 3600000,
    );
    f.now = new Date(f.now.getTime() + 12 * 3600000);
    await freeze(f.owner, f.now);
    assert.equal((await get("duty/context", e.jar)).status, 401);
    const a = await jsonOK(await get("duty/access", e.jar)),
      ch = await jsonOK(await post("auth/duty/reauth", e.jar, a.csrf));
    await jsonOK(
      await stage(e.jar, ch, otp(e.secret, f.now.getTime()), "totp", "DUTY"),
    );
    const ctx = await jsonOK(await get("duty/context", e.jar));
    assert.equal(ctx.absolute_expires_at, ctx.valid_until);
    const check = (
      await f.owner.query(
        "SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('shifts','time_segments','attendance')",
      )
    ).rows[0];
    assert.equal(check.n, 0);
  } finally {
    await f.cleanup();
  }
});

test("HTTP duty PIN lockout survives new challenges, expires safely; network TOTP lockout acts independently of account limit", async () => {
  const f = await dutyFixture();
  try {
    const e = await enrollDuty(f, f.now),
      jar = account(e.token);
    await jsonOK(await activate(f));
    await setPolicy(f, "SECURITY", {
      ...(await securityConfig(f)),
      pinEnabled: true,
    });
    await advance(f);
    await jsonOK(
      await post("auth/mfa/pin", jar, csrfForSession(e.token), {
        password: f.password,
        code: otp(e.secret, f.now.getTime()),
        pin: "654321",
      }),
    );
    await advance(f);
    const ch = await start(f, jar);
    for (let i = 0; i < 5; i++)
      assert.equal((await stage(jar, ch, "999999", "pin")).status, 401);
    const replacement = await start(f, jar);
    assert.equal((await stage(jar, replacement, "654321", "pin")).status, 401);
    const row = (
      await f.owner.query(
        "SELECT failed_attempts,invalidated_at FROM auth_challenges WHERE challenge_token_hash=$1",
        [digest(ch.challenge)],
      )
    ).rows[0];
    assert.equal(row.failed_attempts, 5);
    assert.ok(row.invalidated_at);
    await advance(f, 16 * 60);
    const anon = await get("auth/csrf"),
      aj: Jar = {};
    absorb(aj, anon);
    const csrf = (await anon.json()).csrf;
    await jsonOK(
      await post("auth/login", aj, csrf, {
        identifier: "a_" + f.suffix,
        password: f.password,
      }),
    );
    Object.assign(jar, aj);
    const retry = await start(f, jar),
      next = await jsonOK(await stage(jar, retry, "654321", "pin"));
    await jsonOK(await stage(jar, next, otp(e.secret, f.now.getTime())));
    await setPolicy(f, "SECURITY", {
      ...(await securityConfig(f)),
      pinEnabled: false,
      factorLimit: 10,
      factorNetworkLimit: 5,
    });
    await advance(f);
    const network = await start(f, jar);
    for (let i = 0; i < 5; i++)
      assert.equal((await stage(jar, network, "bad")).status, 401);
    assert.equal(
      (await stage(jar, network, otp(e.secret, f.now.getTime()))).status,
      401,
    );
    const locks = (
      await f.owner.query(
        "SELECT scope,locked_until>private.security_now() locked FROM security_throttles WHERE (scope='TOTP' AND subject_digest=$1) OR scope='TOTP_NETWORK'",
        [digest(f.ids.a)],
      )
    ).rows;
    assert.equal(locks.find((r) => r.scope === "TOTP").locked, null);
    assert.ok(locks.some((r) => r.scope === "TOTP_NETWORK" && r.locked));
  } finally {
    await f.cleanup();
  }
});

test("HTTP assisted authenticator reset revokes active DUTY/challenges; replacement enrollment alone grants no duty and old tokens never revive", async () => {
  const f = await dutyFixture();
  try {
    const e = await authenticated(f),
      old = { ...e.jar };
    await advance(f);
    const pending = await start(f, e.jar);
    const issued = await jsonOK(
      await post(
        "admin/employees/" + f.ids.a + "/mfa-reset",
        account(f.tokens.admin),
        csrfForSession(f.tokens.admin),
        {
          note: "Identity verified privately by registered contact",
          reason: "Employee lost device and all recovery codes",
        },
      ),
    );
    assert.equal((await get("duty/context", old)).status, 401);
    assert.equal((await get("duty/access", old)).status, 401);
    assert.equal(
      (await stage(e.jar, pending, otp(e.secret, f.now.getTime()))).status,
      401,
    );
    const anon = await get("auth/csrf"),
      jar: Jar = {};
    absorb(jar, anon);
    const csrf = (await anon.json()).csrf;
    await jsonOK(
      await post("auth/mfa/reset/redeem", jar, csrf, {
        identifier: "a_" + f.suffix,
        password: f.password,
        code: issued.token,
      }),
    );
    assert.equal((await get("duty/context", jar)).status, 401);
    const startResponse = await jsonOK(
      await post(
        "auth/mfa/enroll",
        jar,
        csrfForSession(jar.libetario_session),
        { password: f.password },
      ),
    );
    const row = (
      await f.owner.query("SELECT * FROM mfa_enrollments WHERE id=$1", [
        startResponse.enrollmentId,
      ])
    ).rows[0];
    assert.equal(row.generation, 2);
    const { openSecret } = await import("../../src/lib/mfa-crypto"),
      secret = openSecret(row);
    await jsonOK(
      await post(
        "auth/mfa/confirm",
        jar,
        csrfForSession(jar.libetario_session),
        { enrollmentId: row.id, code: otp(secret, f.now.getTime()) },
      ),
    );
    assert.equal((await get("duty/context", jar)).status, 401);
    await advance(f);
    const renewed = await start(f, jar);
    await jsonOK(await stage(jar, renewed, otp(secret, f.now.getTime())));
    assert.equal((await get("duty/context", jar)).status, 200);
    assert.equal((await get("duty/context", old)).status, 401);
  } finally {
    await f.cleanup();
  }
});
