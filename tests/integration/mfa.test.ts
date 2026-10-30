import { after, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomUUID, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fixture, digest } from "../helpers";
import { db, authPool, scoped } from "../../src/server/db";
import { login, session, completeReset } from "../../src/server/auth/service";
import {
  beginEnrollment,
  confirmEnrollment,
  verifyAdminMfa,
  recoverAuthenticator,
  requestMfaReset,
  redeemAuthenticatorReset,
  verifyPin,
  setPin,
  regenerateCodes,
  reauthenticateMfa,
} from "../../src/server/auth/mfa";
import { openSecret, otp } from "../../src/lib/mfa-crypto";
import { updateSecurity } from "../../src/server/services/employees";
const network = () => digest(randomUUID());
function wrongCode(secret: Buffer) {
  const valid = new Set(
    [-1, 0, 1].map((n) => otp(secret, Date.now() + n * 30000)),
  );
  return ["000000", "111111", "222222", "333333"].find(
    (code) => !valid.has(code),
  )!;
}
after(async () => {
  await db.$disconnect();
  await authPool.end();
});
async function enrolled(
  f: Awaited<ReturnType<typeof fixture>>,
  who: "a" | "b" = "a",
) {
  const s = await session(f.tokens[who]);
  const started = await beginEnrollment(s, f.password, false, network());
  const row = (
      await f.owner.query("SELECT * FROM mfa_enrollments WHERE id=$1", [
        started.enrollmentId,
      ])
    ).rows[0],
    secret = openSecret(row);
  const result = await confirmEnrollment(
    s,
    started.enrollmentId,
    otp(secret, Date.now()),
    network(),
  );
  return {
    s: await session(result.token),
    secret,
    codes: result.codes,
    enrollmentId: started.enrollmentId,
    qr: started.qr,
  };
}
async function child(
  script: string,
  args: string[],
  input = "",
  extraEnv: Record<string, string> = {},
) {
  return new Promise<{ code: number | null; out: string; err: string }>(
    (resolve, reject) => {
      const p = spawn(process.execPath, ["--import", "tsx", script, ...args], {
        env: { ...process.env, ...extraEnv },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "",
        err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("error", reject);
      p.on("exit", (code) => resolve({ code, out, err }));
      p.stdin.on("error", () => {});
      p.stdin.end(input);
    },
  );
}
test("administrator password yields a bound SETUP capability, no app/DAL/SQL staff access before TOTP", async () => {
  const f = await fixture();
  try {
    const issued = await login("admin_" + f.suffix, f.password, network());
    await assert.rejects(() => session(issued.token));
    const setup = await session(issued.token, true, true);
    assert.equal(setup.scope, "SETUP");
    const rows = await scoped(setup.hash, (tx) =>
      tx.employee_rate_history.findMany(),
    );
    assert.equal(rows.length, 0);
    const result = await verifyAdminMfa(
      setup,
      otp(f.adminSecret, Date.now()),
      network(),
    );
    assert.equal((await session(result.token)).scope, "ACCOUNT");
    await assert.rejects(() => session(issued.token, true, true));
    const second = await session(
      (await login("admin_" + f.suffix, f.password, network())).token,
      true,
      true,
    );
    await assert.rejects(() =>
      verifyAdminMfa(second, otp(f.adminSecret, Date.now()), network()),
    );
  } finally {
    await f.owner.end();
  }
});
test("one-time encrypted enrollment is bound to user/session, confirmation consumes its step and rotates the cookie", async () => {
  const f = await fixture();
  try {
    const s = await session(f.tokens.a),
      b = await session(f.tokens.b),
      start = await beginEnrollment(s, f.password, false, network());
    assert.match(start.qr, /^data:image\/png;base64,/);
    await assert.rejects(() =>
      beginEnrollment(s, f.password, false, network()),
    );
    const row = (
        await f.owner.query("SELECT * FROM mfa_enrollments WHERE id=$1", [
          start.enrollmentId,
        ])
      ).rows[0],
      secret = openSecret(row);
    assert.equal(row.ciphertext.length, 32);
    assert.ok(!Object.values(row).includes(secret.toString("hex")));
    await assert.rejects(() =>
      confirmEnrollment(
        b,
        start.enrollmentId,
        otp(secret, Date.now()),
        network(),
      ),
    );
    const result = await confirmEnrollment(
      s,
      start.enrollmentId,
      otp(secret, Date.now()),
      network(),
    );
    assert.equal(result.codes.length, 10);
    assert.notEqual(result.token, s.token);
    await assert.rejects(() => session(s.token));
    const account = await session(result.token);
    await assert.rejects(() =>
      reauthenticateMfa(account, otp(secret, Date.now()), network()),
    );
    const logs = JSON.stringify(
      (
        await f.owner.query(
          "SELECT payload FROM audit_log WHERE actor_user_id=$1",
          [f.ids.a],
        )
      ).rows,
    );
    assert.ok(!logs.includes(start.qr));
    assert.ok(!logs.includes(result.codes[0]));
    assert.ok(!logs.includes("$argon2id$"));
  } finally {
    await f.owner.end();
  }
});
test("TOTP lockout persists across new setup sessions; expired/replayed contexts fail", async () => {
  const f = await fixture();
  try {
    const setup = await session(
      (await login("admin_" + f.suffix, f.password, network())).token,
      true,
      true,
    );
    for (let i = 0; i < 5; i++)
      await assert.rejects(() =>
        verifyAdminMfa(setup, wrongCode(f.adminSecret), network()),
      );
    await assert.rejects(() => session(setup.token, true, true));
    const again = await session(
      (await login("admin_" + f.suffix, f.password, network())).token,
      true,
      true,
    );
    await assert.rejects(() =>
      verifyAdminMfa(again, otp(f.adminSecret, Date.now()), network()),
    );
    const lock = (
      await f.owner.query(
        "SELECT locked_until>now() locked FROM security_throttles WHERE scope='TOTP' AND subject_digest=$1",
        [digest(f.ids.admin)],
      )
    ).rows[0];
    assert.equal(lock.locked, true);
    await f.owner.query(
      "UPDATE sessions SET created_at=now()-interval '1 hour',idle_expires_at=now()-interval '1 minute',absolute_expires_at=now()-interval '1 minute' WHERE id=$1",
      [again.session_id],
    );
    await assert.rejects(() => session(again.token, true, true));
  } finally {
    await f.owner.end();
  }
});
test("password + one recovery code revokes old factor/all sessions and permits self-service generation 2 only after confirmation", async () => {
  const f = await fixture();
  try {
    const e = await enrolled(f),
      result = await recoverAuthenticator(
        "a_" + f.suffix,
        f.password,
        e.codes[0],
        network(),
      );
    await assert.rejects(() => session(e.s.token));
    const setup = await session(result.token, true, true);
    assert.equal(setup.scope, "SETUP");
    assert.equal(
      (await scoped(setup.hash, (tx) => tx.employee_profiles.findMany()))
        .length,
      0,
    );
    const old = (
      await f.owner.query(
        "SELECT state,ciphertext FROM mfa_enrollments WHERE id=$1",
        [e.enrollmentId],
      )
    ).rows[0];
    assert.equal(old.state, "REVOKED");
    assert.equal(old.ciphertext, null);
    await assert.rejects(() =>
      recoverAuthenticator("a_" + f.suffix, f.password, e.codes[0], network()),
    );
    const start = await beginEnrollment(setup, f.password, false, network()),
      row = (
        await f.owner.query("SELECT * FROM mfa_enrollments WHERE id=$1", [
          start.enrollmentId,
        ])
      ).rows[0];
    assert.equal(row.generation, 2);
    const secret = openSecret(row);
    assert.notDeepEqual(secret, e.secret);
    const done = await confirmEnrollment(
      setup,
      start.enrollmentId,
      otp(secret, Date.now()),
      network(),
    );
    assert.equal(done.codes.length, 10);
    assert.equal((await session(done.token)).scope, "ACCOUNT");
    await assert.rejects(() => session(result.token, true, true));
  } finally {
    await f.owner.end();
  }
});
test("concurrent recovery consumption succeeds once; wrong password/code locks out without privileged fallback", async () => {
  const f = await fixture();
  try {
    const e = await enrolled(f);
    const results = await Promise.allSettled([
      recoverAuthenticator("a_" + f.suffix, f.password, e.codes[0], network()),
      recoverAuthenticator("a_" + f.suffix, f.password, e.codes[0], network()),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    for (let i = 0; i < 5; i++)
      await assert.rejects(() =>
        recoverAuthenticator(
          "b_" + f.suffix,
          "Wrong-Password-Value",
          e.codes[1],
          network(),
        ),
      );
    const row = (
      await f.owner.query(
        "SELECT failure_count,locked_until>now() locked FROM security_throttles WHERE scope='RECOVERY' AND subject_digest=$1",
        [digest(f.ids.b)],
      )
    ).rows[0];
    assert.equal(row.failure_count, 5);
    assert.equal(row.locked, true);
  } finally {
    await f.owner.end();
  }
});
test("hashed PIN setup and replacement require password + fresh TOTP; PIN attempts lock independently", async () => {
  const f = await fixture();
  try {
    const e = await enrolled(f);
    await assert.rejects(() =>
      setPin(e.s, f.password, otp(e.secret, Date.now()), "654321", network()),
    );
    await setPin(
      e.s,
      f.password,
      otp(e.secret, Date.now() + 30000),
      "654321",
      network(),
    );
    const row = (
      await f.owner.query(
        "SELECT pin_hash FROM employee_pins WHERE user_id=$1",
        [f.ids.a],
      )
    ).rows[0];
    assert.match(row.pin_hash, /^\$argon2id\$/);
    assert.notEqual(row.pin_hash, "654321");
    assert.equal((await verifyPin(e.s, "654321", network())).ok, true);
    for (let i = 0; i < 5; i++)
      await assert.rejects(() => verifyPin(e.s, "111111", network()));
    await assert.rejects(() => verifyPin(e.s, "654321", network()));
  } finally {
    await f.owner.end();
  }
});
test("assisted authenticator reset requires another recent-MFA admin and note/reason; token is typed, bound, expiring and single-use", async () => {
  const f = await fixture();
  try {
    const e = await enrolled(f),
      admin = await session(f.tokens.admin);
    await assert.rejects(() =>
      requestMfaReset(
        admin,
        f.ids.admin,
        "Verified privately by owner",
        "Lost authenticator device",
      ),
    );
    await assert.rejects(() =>
      requestMfaReset(admin, f.ids.a, "short", "Lost authenticator device"),
    );
    const token = await requestMfaReset(
      admin,
      f.ids.a,
      "Verified identity via registered contact",
      "Employee lost device and recovery codes",
    );
    await assert.rejects(() => session(e.s.token));
    await assert.rejects(() =>
      completeReset(token, "Unrelated-" + randomUUID(), network()),
    );
    await assert.rejects(() =>
      redeemAuthenticatorReset("b_" + f.suffix, f.password, token, network()),
    );
    const setup = await redeemAuthenticatorReset(
      "a_" + f.suffix,
      f.password,
      token,
      network(),
    );
    assert.equal(
      (await session(setup.token, true, true)).setup_purpose,
      "MFA_RECOVERY",
    );
    await assert.rejects(() =>
      redeemAuthenticatorReset("a_" + f.suffix, f.password, token, network()),
    );
    const next = await requestMfaReset(
      admin,
      f.ids.a,
      "Verified again by registered contact",
      "Previous reset token delivery expired",
    );
    await f.owner.query(
      "UPDATE credential_resets SET created_at=now()-interval '1 hour',expires_at=now()-interval '1 minute' WHERE token_hash=$1",
      [digest(next)],
    );
    await assert.rejects(() =>
      redeemAuthenticatorReset("a_" + f.suffix, f.password, next, network()),
    );
  } finally {
    await f.owner.end();
  }
});
test("RLS/column grants protect new tables; setup admin and employees cannot alter MFA claims or call operator functions", async () => {
  const f = await fixture(),
    c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    const e = await enrolled(f),
      setup = await login("admin_" + f.suffix, f.password, network());
    await c.connect();
    for (const token of [e.s.token, setup.token]) {
      await c.query("SELECT set_config('app.session_hash',$1,false)", [
        digest(token),
      ]);
      for (const sql of [
        "SELECT ciphertext FROM mfa_enrollments",
        "SELECT pin_hash FROM employee_pins",
        "SELECT code_hash FROM recovery_codes",
        "UPDATE sessions SET scope='ACCOUNT'",
        "SET ROLE libetario_auth",
      ])
        await assert.rejects(() => c.query(sql));
      assert.equal(
        (
          await c.query("SELECT id FROM mfa_enrollments WHERE user_id=$1", [
            f.ids.b,
          ])
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await c.query(
            "SELECT has_function_privilege(current_user,'private.perform_mfa_reset(uuid,uuid,text,text,text,text,text)','EXECUTE') allowed",
          )
        ).rows[0].allowed,
        false,
      );
    }
  } finally {
    await c.end();
    await f.owner.end();
  }
});
test("operator CLI refuses production without flag, cancellation changes nothing, explicit flagged confirmation resets and audits without changing password/role", async () => {
  const f = await fixture();
  try {
    const args = ["--username", "admin_" + f.suffix],
      old = (
        await f.owner.query(
          "SELECT authorization_version,password_hash,role FROM users WHERE id=$1",
          [f.ids.admin],
        )
      ).rows[0];
    const denied = await child("scripts/reset-admin-mfa.ts", args, "", {
      NODE_ENV: "production",
    });
    assert.equal(denied.code, 1);
    assert.match(denied.err, /allow-production/);
    assert.ok(!denied.out.includes("Type RESET"));
    const cancelled = await child("scripts/reset-admin-mfa.ts", args, "NO\n");
    assert.equal(cancelled.code, 1);
    assert.equal(
      (
        await f.owner.query(
          "SELECT authorization_version FROM users WHERE id=$1",
          [f.ids.admin],
        )
      ).rows[0].authorization_version,
      old.authorization_version,
    );
    const done = await child(
      "scripts/reset-admin-mfa.ts",
      [...args, "--allow-production"],
      `RESET admin_${f.suffix}\nVerified by server owner privately\nLost last administrator authenticator\n`,
      { NODE_ENV: "production" },
    );
    assert.equal(done.code, 0, "Confirmed operator reset must succeed");
    const token = done.out.match(/Reset token: ([a-f0-9]{64})/)?.[1];
    assert.ok(token);
    const changed = (
      await f.owner.query(
        "SELECT authorization_version,password_hash,role FROM users WHERE id=$1",
        [f.ids.admin],
      )
    ).rows[0];
    assert.equal(changed.password_hash, old.password_hash);
    assert.equal(changed.role, old.role);
    assert.ok(changed.authorization_version > old.authorization_version);
    await assert.rejects(() => session(f.tokens.admin));
    const audit = (
      await f.owner.query(
        "SELECT actor_user_id,payload FROM audit_log WHERE action='mfa.reset_issued' AND payload->>'target_user_id'=$1",
        [f.ids.admin],
      )
    ).rows[0];
    assert.equal(audit.actor_user_id, null);
    assert.equal(audit.payload.source, "CLI");
    assert.ok(audit.payload.operator);
    assert.ok(!JSON.stringify(audit).includes(token!));
    const setup = await redeemAuthenticatorReset(
      "admin_" + f.suffix,
      f.password,
      token!,
      network(),
    );
    await assert.rejects(() => session(setup.token));
    assert.equal((await session(setup.token, true, true)).scope, "SETUP");
  } finally {
    await f.owner.end();
  }
});
test("operator key rotation preserves generations/replay counters and old-key backup decryption, then restores test key selection", async () => {
  const f = await fixture(),
    original = process.env.MFA_ENCRYPTION_KEYS!,
    active = process.env.MFA_ACTIVE_KEY_ID!;
  const extra = "test_" + randomBytes(5).toString("hex"),
    ring = JSON.stringify({
      ...JSON.parse(original),
      [extra]: randomBytes(32).toString("base64"),
    });
  try {
    const before = (
      await f.owner.query(
        "SELECT generation,last_accepted_step FROM mfa_enrollments WHERE id=$1",
        [f.adminEnrollmentId],
      )
    ).rows[0];
    const rotated = await child("scripts/rotate-mfa-keys.ts", [], "", {
      MFA_ENCRYPTION_KEYS: ring,
      MFA_ACTIVE_KEY_ID: extra,
    });
    assert.equal(rotated.code, 0, "Rotation should succeed");
    const after = (
      await f.owner.query("SELECT * FROM mfa_enrollments WHERE id=$1", [
        f.adminEnrollmentId,
      ])
    ).rows[0];
    assert.equal(after.generation, before.generation);
    assert.equal(after.last_accepted_step, before.last_accepted_step);
    assert.equal(after.encryption_key_id, extra);
    const crypto = await import("../../src/lib/mfa-crypto");
    assert.deepEqual(
      openSecret(
        after,
        crypto.mfaKeyring({
          MFA_ENCRYPTION_KEYS: ring,
          MFA_ACTIVE_KEY_ID: extra,
        }),
      ),
      f.adminSecret,
    );
  } finally {
    const restored = await child("scripts/rotate-mfa-keys.ts", [], "", {
      MFA_ENCRYPTION_KEYS: ring,
      MFA_ACTIVE_KEY_ID: active,
    });
    assert.equal(restored.code, 0, "Test key selection must be restored");
    await f.owner.end();
  }
});
test("second administrator seed is explicit, temporary-password/MFA-gated, and scripts are not reachable from request code", async () => {
  const f = await fixture();
  try {
    const username = "second_" + randomBytes(4).toString("hex"),
      done = await child("prisma/seed.ts", [
        "--second-admin",
        username,
        username + "@example.invalid",
      ]);
    assert.equal(done.code, 0);
    const row = (
      await f.owner.query(
        "SELECT role,must_change_password FROM users WHERE username=$1",
        [username],
      )
    ).rows[0];
    assert.equal(row.role, "ADMINISTRATOR");
    assert.equal(row.must_change_password, true);
    const refused = await child(
      "prisma/seed.ts",
      ["--second-admin", "blocked_" + f.suffix, "blocked@example.invalid"],
      "",
      { NODE_ENV: "production" },
    );
    assert.equal(refused.code, 1);
    const handler = await readFile("src/server/http/api.ts", "utf8");
    assert.ok(!handler.includes("scripts/"));
    assert.ok(!handler.includes("perform_mfa_reset"));
  } finally {
    await f.owner.end();
  }
});

test("pending enrollment expiry, concurrent TOTP use and disabled-account contexts fail closed", async () => {
  const f = await fixture();
  try {
    const s = await session(f.tokens.a),
      start = await beginEnrollment(s, f.password, false, network());
    const row = (
      await f.owner.query("SELECT * FROM mfa_enrollments WHERE id=$1", [
        start.enrollmentId,
      ])
    ).rows[0];
    await f.owner.query(
      "UPDATE mfa_enrollments SET pending_expires_at=now()-interval '1 minute' WHERE id=$1",
      [row.id],
    );
    await assert.rejects(() =>
      confirmEnrollment(s, row.id, otp(openSecret(row), Date.now()), network()),
    );
    const setup1 = await session(
        (await login("admin_" + f.suffix, f.password, network())).token,
        true,
        true,
      ),
      setup2 = await session(
        (await login("admin_" + f.suffix, f.password, network())).token,
        true,
        true,
      );
    const code = otp(f.adminSecret, Date.now()),
      results = await Promise.allSettled([
        verifyAdminMfa(setup1, code, network()),
        verifyAdminMfa(setup2, code, network()),
      ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    await f.owner.query(
      "UPDATE users SET disabled_at=now(),authorization_version=authorization_version+1 WHERE id=$1",
      [f.ids.a],
    );
    await assert.rejects(() => beginEnrollment(s, f.password, true, network()));
  } finally {
    await f.owner.end();
  }
});

test("recent administrator MFA is mandatory for reset/policy writes; omitted policy flags persist and stale updates cannot overwrite them", async () => {
  const f = await fixture();
  let original: Record<string, unknown> | undefined;
  try {
    await enrolled(f);
    const admin = await session(f.tokens.admin);
    await f.owner.query(
      "UPDATE sessions SET mfa_verified_at=now()-interval '6 minutes' WHERE token_hash=$1",
      [digest(admin.token)],
    );
    await assert.rejects(() =>
      requestMfaReset(
        admin,
        f.ids.a,
        "Identity verified through registered contact",
        "Employee lost both device and codes",
      ),
    );
    const read = async () =>
      (
        await f.owner.query(
          "SELECT p.id,p.configuration FROM company_settings s JOIN policy_versions p ON p.id=s.security_policy_id WHERE s.id=1",
        )
      ).rows[0];
    const initial = await read();
    original = initial.configuration;
    await assert.rejects(() =>
      updateSecurity(admin, {
        expectedPolicyId: initial.id,
        configuration: { pinEnabled: true },
        reason: "Verify recent MFA requirement",
      }),
    );
    await reauthenticateMfa(admin, otp(f.adminSecret, Date.now()), network());
    const pending = await login("admin_" + f.suffix, f.password, network());
    await updateSecurity(admin, {
      expectedPolicyId: initial.id,
      configuration: { pinEnabled: true },
      reason: "Test configurable PIN enforcement flag",
    });
    await assert.rejects(() => session(pending.token, true, true));
    const changed = await read();
    assert.equal(changed.configuration.pinEnabled, true);
    await updateSecurity(admin, {
      expectedPolicyId: changed.id,
      configuration: { dutyIdleMinutes: 45 },
      reason: "Test omitted security flag preservation",
    });
    const retained = await read();
    assert.equal(retained.configuration.pinEnabled, true);
    assert.equal(retained.configuration.dutyIdleMinutes, 45);
    await assert.rejects(() =>
      updateSecurity(admin, {
        expectedPolicyId: changed.id,
        configuration: { pinEnabled: false },
        reason: "Reject stale policy update attempts",
      }),
    );
    await assert.rejects(() =>
      updateSecurity(admin, {
        expectedPolicyId: retained.id,
        configuration: { adminTotpRequired: false },
        reason: "Reject disabling mandatory admin TOTP",
      }),
    );
  } finally {
    // Restore defaults with another immutable version; never delete policy/audit history.
    if (original) {
      await f.owner.query("BEGIN");
      try {
        const added = (
          await f.owner.query(
            "INSERT INTO policy_versions(policy_key,revision,configuration,created_by) SELECT 'SECURITY',max(revision)+1,$1,$2 FROM policy_versions WHERE policy_key='SECURITY' RETURNING id",
            [original, f.ids.admin],
          )
        ).rows[0];
        await f.owner.query(
          "UPDATE company_settings SET security_policy_id=$1,version=version+1 WHERE id=1",
          [added.id],
        );
        await f.owner.query("COMMIT");
      } catch (e) {
        await f.owner.query("ROLLBACK");
        throw e;
      }
    }
    await f.owner.end();
  }
});
