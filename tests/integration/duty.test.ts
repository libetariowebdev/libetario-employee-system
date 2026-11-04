import {
  dutyFixture,
  enrollDuty,
  freeze,
  setPolicy,
  securityConfig,
} from "../duty-helpers";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomUUID } from "node:crypto";
import {
  hashPassword,
  digest,
  randomToken,
} from "../../src/server/auth/security";
import { db, authPool } from "../../src/server/db";
import { session, login } from "../../src/server/auth/service";
import {
  startDuty,
  completeDutyStage,
  dutyBinding,
} from "../../src/server/auth/duty";
import {
  reauthenticateMfa,
  setPin,
  verifyAdminMfa,
} from "../../src/server/auth/mfa";
import { mutateDuty } from "../../src/server/services/duty";
import { requireDuty } from "../../src/server/dal/duty";
import { otp } from "../../src/lib/mfa-crypto";
const network = () => digest(randomUUID());
after(async () => {
  await db.$disconnect();
  await authPool.end();
});
type F = Awaited<ReturnType<typeof dutyFixture>>;
async function grant(
  f: F,
  who: "a" | "b" = "a",
  action: "ACTIVATE" | "REVOKE" | "REGRANT" = "ACTIVATE",
  overnight = false,
  validUntil?: string,
) {
  return mutateDuty(await session(f.tokens.admin), {
    employeeIds: [f.ids[who]],
    date: f.day,
    action,
    reason: "Owner approved test duty authorization",
    overnight,
    validUntil,
  });
}
async function advance(f: F, seconds = 30) {
  f.now = new Date(f.now.getTime() + seconds * 1000);
  await freeze(f.owner, f.now);
}
async function authenticated(f: F) {
  const e = await enrollDuty(f, f.now);
  await grant(f);
  await advance(f);
  const ch = await startDuty(e.token, f.day, f.password, false, network());
  const result = await completeDutyStage(
    e.token,
    ch.challenge,
    "TOTP",
    otp(e.secret, f.now.getTime()),
    network(),
  );
  assert.equal(result.kind, "SESSION");
  if (result.kind !== "SESSION") throw new Error("Session expected");
  return { ...e, login: result };
}

test("duty grant functions: active no-op, bulk atomicity/max 100, reasoned regrant and versioned history", async () => {
  const f = await dutyFixture();
  try {
    assert.equal((await grant(f)).changed, 1);
    assert.equal((await grant(f)).changed, 0);
    const admin = await session(f.tokens.admin);
    await assert.rejects(() =>
      mutateDuty(admin, {
        employeeIds: [f.ids.b, randomUUID()],
        date: f.day,
        action: "ACTIVATE",
        reason: "Atomic bulk must roll back entirely",
      }),
    );
    assert.equal(
      (
        await f.owner.query(
          "SELECT id FROM duty_authorizations WHERE employee_id=$1",
          [f.ids.b],
        )
      ).rowCount,
      0,
    );
    await assert.rejects(() =>
      mutateDuty(admin, {
        employeeIds: Array.from({ length: 101 }, () => randomUUID()),
        date: f.day,
        action: "ACTIVATE",
        reason: "Bulk selection exceeds approved maximum",
      }),
    );
    await assert.rejects(() => mutateDuty(awaitSession(), {}));
    function awaitSession() {
      return { role: "EMPLOYEE", scope: "ACCOUNT" } as any;
    }
    await grant(f, "a", "REVOKE");
    await assert.rejects(() => grant(f));
    await assert.rejects(() =>
      mutateDuty(admin, {
        employeeIds: [f.ids.a],
        date: f.day,
        action: "REGRANT",
        reason: "",
      }),
    );
    await grant(f, "a", "REGRANT");
    const d = (
      await f.owner.query(
        "SELECT authorization_version,status FROM duty_authorizations WHERE employee_id=$1",
        [f.ids.a],
      )
    ).rows[0];
    assert.equal(d.authorization_version, 3);
    assert.equal(d.status, "ACTIVATED");
    assert.equal(
      (
        await f.owner.query(
          "SELECT id FROM audit_log WHERE action IN ('duty.activate','duty.revoke','duty.regrant') AND payload->>'employee_id'=$1",
          [f.ids.a],
        )
      ).rowCount,
      3,
    );
    const bulk = (
      await f.owner.query(
        "WITH added AS(INSERT INTO users(email,username,password_hash,role,must_change_password) SELECT 'bulk_'||$1||'_'||n||'@example.invalid','bulk_'||$1||'_'||n,password_hash,'EMPLOYEE',false FROM users CROSS JOIN generate_series(1,100)n WHERE id=$2 RETURNING id) INSERT INTO employee_profiles(user_id,employee_number,legal_name,display_name,designation,start_date) SELECT id,'BULK-'||id,'Fake bulk fixture','Fake bulk fixture','Test','2026-01-01' FROM added RETURNING user_id",
        [f.suffix, f.ids.a],
      )
    ).rows.map((r) => r.user_id);
    assert.equal(
      (
        await mutateDuty(admin, {
          employeeIds: bulk,
          date: f.day,
          action: "ACTIVATE",
          reason: "Verify exact maximum bulk selection",
        })
      ).changed,
      100,
    );
  } finally {
    await f.cleanup();
  }
});

test("scenario 1: A granted/B absent, real DAL and restricted role require exact DUTY cookie; no direct grant/challenge writes", async () => {
  const f = await dutyFixture(),
    c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    const e = await authenticated(f),
      own = await requireDuty(e.login.token, false);
    assert.equal(own.user_id, f.ids.a);
    assert.equal(own.duty_date.toISOString().slice(0, 10), f.day);
    await assert.rejects(() => requireDuty(e.login.account!.token));
    await assert.rejects(() =>
      startDuty(f.tokens.b, f.day, f.password, false, network()),
    );
    await c.connect();
    await c.query("SELECT set_config('app.session_hash',$1,false)", [
      digest(e.login.token),
    ]);
    assert.equal(
      (await c.query("SELECT * FROM private.duty_context()")).rowCount,
      1,
    );
    assert.equal(
      (await c.query("SELECT * FROM private.identity()")).rowCount,
      0,
    );
    await c.query("SELECT set_config('app.session_hash',$1,false)", [
      digest(f.tokens.b),
    ]);
    assert.equal(
      (
        await c.query(
          "SELECT id FROM duty_authorizations WHERE employee_id=$1",
          [f.ids.a],
        )
      ).rowCount,
      0,
    );
    for (const sql of [
      "UPDATE duty_authorizations SET authorization_version=99",
      "SELECT challenge_token_hash FROM auth_challenges",
      "SET ROLE libetario_auth",
      "SELECT * FROM private.lock_duty(NULL,NULL)",
    ])
      await assert.rejects(() => c.query(sql));
    await c.query("SELECT set_config('app.session_hash',$1,false)", [
      digest(f.tokens.admin),
    ]);
    await assert.rejects(() =>
      c.query(
        "SELECT private.mutate_duty($1::uuid[],$2::date,NULL,$3,false,NULL)",
        [[f.ids.a], f.day, "NULL action cannot resurrect a grant"],
      ),
    );
    await assert.rejects(() =>
      c.query("SELECT * FROM private.duty_context_base()"),
    );
  } finally {
    await c.end();
    await f.cleanup();
  }
});

test("PIN off/on, missing PIN, wrong/reordered PIN, rotated stage tokens and unchanged absolute challenge deadline", async () => {
  const f = await dutyFixture();
  try {
    const e = await enrollDuty(f, f.now);
    await grant(f);
    const cfg = await securityConfig(f);
    assert.equal(cfg.pinEnabled, false);
    await setPolicy(f, "SECURITY", { ...cfg, pinEnabled: true });
    await assert.rejects(() =>
      startDuty(e.token, f.day, f.password, false, network()),
    );
    await advance(f);
    await setPin(
      await session(e.token),
      f.password,
      otp(e.secret, f.now.getTime()),
      "654321",
      network(),
    );
    await advance(f);
    const ch = await startDuty(e.token, f.day, f.password, false, network());
    assert.equal(ch.stage, "PIN");
    await assert.rejects(() =>
      completeDutyStage(
        e.token,
        ch.challenge,
        "TOTP",
        otp(e.secret, f.now.getTime()),
        network(),
      ),
    );
    await assert.rejects(() =>
      completeDutyStage(e.token, ch.challenge, "PIN", "wrong", network()),
    );
    const next = await completeDutyStage(
      e.token,
      ch.challenge,
      "PIN",
      "654321",
      network(),
    );
    assert.equal(next.kind, "CHALLENGE");
    if (next.kind !== "CHALLENGE") throw new Error("Challenge expected");
    assert.notEqual(next.challenge, ch.challenge);
    assert.notEqual(next.csrf, ch.csrf);
    assert.equal(next.expiresAt.getTime(), ch.expiresAt.getTime());
    await assert.rejects(() =>
      completeDutyStage(e.token, ch.challenge, "PIN", "654321", network()),
    );
    const done = await completeDutyStage(
      e.token,
      next.challenge,
      "TOTP",
      otp(e.secret, f.now.getTime()),
      network(),
    );
    assert.equal(done.kind, "SESSION");
  } finally {
    await f.cleanup();
  }
});

test("TOTP reuse across account reauth and concurrent independent challenges succeeds once; expiry, foreign binding and consumed tokens fail", async () => {
  const f = await dutyFixture();
  try {
    const e = await enrollDuty(f, f.now);
    await grant(f);
    await advance(f);
    const current = await session(e.token);
    await reauthenticateMfa(current, otp(e.secret, f.now.getTime()), network());
    const ch = await startDuty(e.token, f.day, f.password, false, network());
    await assert.rejects(() =>
      completeDutyStage(
        e.token,
        ch.challenge,
        "TOTP",
        otp(e.secret, f.now.getTime()),
        network(),
      ),
    );
    const before = (
      await f.owner.query(
        "SELECT coalesce(sum(failure_count),0)::int n FROM security_throttles WHERE scope='TOTP' AND subject_digest=$1",
        [digest(f.ids.a)],
      )
    ).rows[0].n;
    await assert.rejects(() =>
      completeDutyStage(f.tokens.b, ch.challenge, "TOTP", "123456", network()),
    );
    assert.equal(
      (
        await f.owner.query(
          "SELECT coalesce(sum(failure_count),0)::int n FROM security_throttles WHERE scope='TOTP' AND subject_digest=$1",
          [digest(f.ids.a)],
        )
      ).rows[0].n,
      before,
    );
    await advance(f, 301);
    await assert.rejects(() =>
      completeDutyStage(
        e.token,
        ch.challenge,
        "TOTP",
        otp(e.secret, f.now.getTime()),
        network(),
      ),
    );
    // Independent account sessions for the same user, not two copies of one cookie.
    const alternateToken = randomToken(),
      alternate = (
        await f.owner.query(
          "INSERT INTO sessions(user_id,token_hash,csrf_token_hash,authorization_version,created_at,idle_expires_at,absolute_expires_at) VALUES($1,$2,$3,1,private.security_now(),private.security_now()+interval '15 min',private.security_now()+interval '60 min') RETURNING id",
          [f.ids.a, digest(alternateToken), digest("x")],
        )
      ).rows[0];
    assert.ok(alternate.id);
    const a = await startDuty(e.token, f.day, f.password, false, network()),
      b = await startDuty(alternateToken, f.day, f.password, false, network());
    await assert.rejects(() =>
      completeDutyStage(
        alternateToken,
        a.challenge,
        "TOTP",
        otp(e.secret, f.now.getTime()),
        network(),
      ),
    );
    const results = await Promise.allSettled([
      completeDutyStage(
        e.token,
        a.challenge,
        "TOTP",
        otp(e.secret, f.now.getTime()),
        network(),
      ),
      completeDutyStage(
        alternateToken,
        b.challenge,
        "TOTP",
        otp(e.secret, f.now.getTime()),
        network(),
      ),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  } finally {
    await f.cleanup();
  }
});

test("inactive employment blocks activation and guard; reactivation cannot revive an expired duty handle; admin may revoke a disabled employee", async () => {
  const f = await dutyFixture();
  try {
    await f.owner.query(
      "UPDATE employee_profiles SET employment_status='INACTIVE' WHERE user_id=$1",
      [f.ids.b],
    );
    await assert.rejects(() => grant(f, "b"));
    const e = await authenticated(f);
    await advance(f, 31 * 60);
    await assert.rejects(() => requireDuty(e.login.token, false));
    await f.owner.query(
      "UPDATE sessions SET revoked_at=private.security_now(),revocation_reason='EXPIRED' WHERE token_hash=$1",
      [digest(e.login.token)],
    );
    await f.owner.query(
      "UPDATE employee_profiles SET employment_status='INACTIVE' WHERE user_id=$1",
      [f.ids.a],
    );
    await f.owner.query(
      "UPDATE employee_profiles SET employment_status='ACTIVE' WHERE user_id=$1",
      [f.ids.a],
    );
    await assert.rejects(() => dutyBinding(e.login.token));
    await f.owner.query(
      "UPDATE users SET disabled_at=private.security_now(),authorization_version=authorization_version+1 WHERE id=$1",
      [f.ids.a],
    );
    const setup = await session(
        (await login("admin_" + f.suffix, f.password, network())).token,
        true,
        true,
      ),
      verified = await verifyAdminMfa(
        setup,
        otp(f.adminSecret, f.now.getTime()),
        network(),
      );
    assert.equal(
      (
        await mutateDuty(await session(verified.token), {
          employeeIds: [f.ids.a],
          date: f.day,
          action: "REVOKE",
          reason: "Revoke disabled employee authorization",
        })
      ).changed,
      1,
    );
  } finally {
    await f.cleanup();
  }
});

test("revocation and regrant remove guard access immediately, preserve records and cannot revive tokens; final issuance races serialize", async () => {
  const f = await dutyFixture();
  try {
    const e = await authenticated(f),
      before = (
        await f.owner.query(
          "SELECT count(*)::int n FROM employee_rate_history WHERE employee_id=$1",
          [f.ids.a],
        )
      ).rows[0].n;
    await grant(f, "a", "REVOKE");
    await assert.rejects(() => requireDuty(e.login.token));
    await assert.rejects(() => dutyBinding(e.login.token));
    await grant(f, "a", "REGRANT");
    await assert.rejects(() => requireDuty(e.login.token));
    await assert.rejects(() =>
      startDuty(e.login.token, undefined, undefined, true, network()),
    );
    await advance(f);
    const ch = await startDuty(
      e.login.account!.token,
      f.day,
      f.password,
      false,
      network(),
    );
    const results = await Promise.allSettled([
      completeDutyStage(
        e.login.account!.token,
        ch.challenge,
        "TOTP",
        otp(e.secret, f.now.getTime()),
        network(),
      ),
      grant(f, "a", "REVOKE"),
    ]);
    assert.equal(results[1].status, "fulfilled");
    if (
      results[0].status === "fulfilled" &&
      results[0].value.kind === "SESSION"
    ) {
      const issued = results[0].value;
      await assert.rejects(() => requireDuty(issued.token));
    }
    assert.equal(
      (
        await f.owner.query(
          "SELECT count(*)::int n FROM employee_rate_history WHERE employee_id=$1",
          [f.ids.a],
        )
      ).rows[0].n,
      before,
    );
    assert.ok(
      (
        await f.owner.query(
          "SELECT id FROM sessions WHERE duty_id IN(SELECT id FROM duty_authorizations WHERE employee_id=$1)",
          [f.ids.a],
        )
      ).rowCount! >= 1,
    );
  } finally {
    await f.cleanup();
  }
});

test("policy switch and PIN replacement invalidate duty sessions/challenges; wrong factors persist lockout across new challenges", async () => {
  const f = await dutyFixture();
  try {
    const e = await authenticated(f),
      account = e.login.account!.token;
    await advance(f);
    const ch = await startDuty(account, f.day, f.password, false, network());
    await setPolicy(f, "SECURITY", {
      ...(await securityConfig(f)),
      dutyIdleMinutes: 35,
    });
    await assert.rejects(() => requireDuty(e.login.token));
    await assert.rejects(() =>
      completeDutyStage(
        account,
        ch.challenge,
        "TOTP",
        otp(e.secret, f.now.getTime()),
        network(),
      ),
    );
    const next = await startDuty(account, f.day, f.password, false, network());
    for (let i = 0; i < 5; i++)
      await assert.rejects(() =>
        completeDutyStage(account, next.challenge, "TOTP", "bad", network()),
      );
    const again = await startDuty(account, f.day, f.password, false, network());
    await assert.rejects(() =>
      completeDutyStage(
        account,
        again.challenge,
        "TOTP",
        otp(e.secret, f.now.getTime()),
        network(),
      ),
    );
    const lock = (
      await f.owner.query(
        "SELECT locked_until>private.security_now() locked FROM security_throttles WHERE scope='TOTP' AND subject_digest=$1",
        [digest(f.ids.a)],
      )
    ).rows[0];
    assert.equal(lock.locked, true);
  } finally {
    await f.cleanup();
  }
});

test("Manila midnight: default non-overnight expires, explicit overnight carries original grant/date, TOTP-only resume, no implicit next day", async () => {
  const f = await dutyFixture();
  try {
    const e = await enrollDuty(f, f.now);
    await setPolicy(f, "WORK", {
      overnightEnabled: true,
      overnightCarryHours: 8,
    });
    const tomorrow = new Date(
        new Date(f.day + "T00:00:00Z").getTime() + 86400000,
      )
        .toISOString()
        .slice(0, 10),
      end = tomorrow + "T07:00:00+08:00";
    await assert.rejects(() =>
      grant(f, "a", "ACTIVATE", true, tomorrow + "T09:00:00+08:00"),
    );
    await grant(f, "a", "ACTIVATE", true, end);
    await grant(f, "b");
    f.now = new Date(f.day + "T23:55:00+08:00");
    await freeze(f.owner, f.now);
    // Initial employee ACCOUNT expires normally; explicitly refresh the fixture binding to reach the pre-midnight login.
    await f.owner.query(
      "UPDATE sessions SET idle_expires_at=$2::timestamptz+interval '30 min',absolute_expires_at=$2::timestamptz+interval '60 min' WHERE token_hash=$1",
      [digest(e.token), f.now],
    );
    const ch = await startDuty(e.token, f.day, f.password, false, network()),
      issued = await completeDutyStage(
        e.token,
        ch.challenge,
        "TOTP",
        otp(e.secret, f.now.getTime()),
        network(),
      );
    assert.equal(issued.kind, "SESSION");
    if (issued.kind !== "SESSION") throw new Error("Session expected");
    f.now = new Date(tomorrow + "T00:05:00+08:00");
    await freeze(f.owner, f.now);
    assert.equal(
      (await requireDuty(issued.token, false)).duty_id,
      (await dutyBinding(issued.token)).dutyId,
    );
    f.now = new Date(tomorrow + "T00:26:00+08:00");
    await freeze(f.owner, f.now);
    await assert.rejects(() => requireDuty(issued.token, false));
    const resume = await startDuty(
      issued.token,
      undefined,
      undefined,
      true,
      network(),
    );
    const refreshed = await completeDutyStage(
      issued.token,
      resume.challenge,
      "TOTP",
      otp(e.secret, f.now.getTime()),
      network(),
    );
    assert.equal(refreshed.kind, "SESSION");
    if (refreshed.kind !== "SESSION") throw new Error("Session expected");
    assert.equal(
      (await requireDuty(refreshed.token, false)).duty_date
        .toISOString()
        .slice(0, 10),
      f.day,
    );
    assert.equal(refreshed.account, undefined);
    await assert.rejects(() =>
      startDuty(f.tokens.b, f.day, f.password, false, network()),
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
    f.now = new Date(end);
    await freeze(f.owner, f.now);
    await assert.rejects(() => requireDuty(refreshed.token));
    await assert.rejects(() => dutyBinding(refreshed.token));
  } finally {
    await f.cleanup();
  }
});
