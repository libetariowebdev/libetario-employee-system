import { after, test } from "node:test";
import assert from "node:assert/strict";
import { fixture, digest } from "../helpers";
import { openSecret, otp } from "../../src/lib/mfa-crypto";
const origin = process.env.HTTP_TEST_ORIGIN ?? "http://127.0.0.1:3001";
if (!["127.0.0.1", "localhost"].includes(new URL(origin).hostname))
  throw new Error("Local test server required");
const owners: Awaited<ReturnType<typeof fixture>>["owner"][] = [];
after(async () => {
  for (const c of owners) await c.end();
});
async function fresh() {
  const f = await fixture();
  owners.push(f.owner);
  return f;
}
async function anonymous() {
  const r = await fetch(origin + "/api/auth/csrf");
  assert.equal(r.status, 200);
  return {
    cookie: r.headers.get("set-cookie")!.split(";")[0],
    csrf: (await r.json()).csrf as string,
  };
}
async function post(
  path: string,
  cookie: string,
  csrf: string,
  data: Record<string, unknown>,
) {
  return fetch(origin + "/api/" + path, {
    method: "POST",
    headers: { origin, "content-type": "application/json", cookie },
    body: JSON.stringify({ ...data, csrf }),
  });
}
async function state(cookie: string) {
  const r = await fetch(origin + "/api/session", { headers: { cookie } });
  assert.equal(r.status, 200);
  return r.json();
}
function rotated(r: Response) {
  return r.headers.get("set-cookie")!.split(";")[0];
}
async function signIn(f: Awaited<ReturnType<typeof fixture>>, who = "admin") {
  const a = await anonymous(),
    r = await post("auth/login", a.cookie, a.csrf, {
      identifier: who + "_" + f.suffix,
      password: f.password,
    });
  assert.equal(r.status, 200);
  return rotated(r);
}
async function adminAccount(f: Awaited<ReturnType<typeof fixture>>) {
  let cookie = await signIn(f);
  const s = await state(cookie),
    r = await post("auth/mfa/verify", cookie, s.csrf, {
      code: otp(f.adminSecret, Date.now()),
    });
  assert.equal(r.status, 200);
  return rotated(r);
}
function wrongCode(secret: Buffer) {
  const valid = new Set(
    [-1, 0, 1].map((n) => otp(secret, Date.now() + n * 30000)),
  );
  return ["000000", "111111", "222222", "333333"].find((c) => !valid.has(c))!;
}

test("HTTP administrator SETUP cannot access app/SSR before TOTP; rotation and replay checks use real cookies", async () => {
  const f = await fresh();
  let cookie = await signIn(f);
  const initial = cookie,
    s = await state(cookie);
  assert.equal(s.scope, "SETUP");
  assert.equal(
    (await fetch(origin + "/api/admin/employees", { headers: { cookie } }))
      .status,
    403,
  );
  const page = await fetch(origin + "/admin", {
    headers: { cookie },
    redirect: "manual",
  });
  assert.equal(page.status, 307);
  assert.equal(page.headers.get("location"), "/mfa/verify");
  const bad = await post("auth/mfa/verify", cookie, s.csrf, {
    code: wrongCode(f.adminSecret),
  });
  assert.equal(bad.status, 401);
  assert.equal(
    (await bad.json()).error,
    "Authentication failed or temporarily unavailable",
  );
  const r = await post("auth/mfa/verify", cookie, s.csrf, {
    code: otp(f.adminSecret, Date.now()),
  });
  assert.equal(r.status, 200);
  cookie = rotated(r);
  assert.notEqual(cookie, initial);
  assert.equal(
    (await fetch(origin + "/api/admin/employees", { headers: { cookie } }))
      .status,
    200,
  );
  assert.equal(
    (await fetch(origin + "/api/session", { headers: { cookie: initial } }))
      .status,
    401,
  );
  const again = await signIn(f),
    newState = await state(again);
  assert.equal(
    (
      await post("auth/mfa/verify", again, newState.csrf, {
        code: otp(f.adminSecret, Date.now()),
      })
    ).status,
    401,
  );
  await f.owner.query(
    "UPDATE users SET disabled_at=now(),authorization_version=authorization_version+1 WHERE id=$1",
    [f.ids.admin],
  );
  assert.equal(
    (await fetch(origin + "/api/admin/employees", { headers: { cookie } }))
      .status,
    401,
  );
});

test("HTTP password + recovery code revokes old admin factor and sessions, permits only fresh enrollment before privileges", async () => {
  const f = await fresh(),
    cookie = await adminAccount(f),
    s = await state(cookie);
  const codesResponse = await post("auth/mfa/codes", cookie, s.csrf, {
    password: f.password,
    code: otp(f.adminSecret, Date.now() + 30000),
  });
  assert.equal(codesResponse.status, 200);
  const { codes } = await codesResponse.json();
  assert.equal(codes.length, 10);
  const anon = await anonymous(),
    recovered = await post("auth/mfa/recover", anon.cookie, anon.csrf, {
      identifier: "admin_" + f.suffix,
      password: f.password,
      code: codes[0],
    });
  assert.equal(recovered.status, 200);
  const setup = rotated(recovered),
    ss = await state(setup);
  assert.equal(ss.scope, "SETUP");
  assert.equal(ss.setup_purpose, "MFA_RECOVERY");
  assert.equal(
    (
      await fetch(origin + "/api/admin/employees", {
        headers: { cookie: setup },
      })
    ).status,
    403,
  );
  assert.equal(
    (await fetch(origin + "/api/session", { headers: { cookie } })).status,
    401,
  );
  const old = (
    await f.owner.query(
      "SELECT state,ciphertext FROM mfa_enrollments WHERE id=$1",
      [f.adminEnrollmentId],
    )
  ).rows[0];
  assert.equal(old.state, "REVOKED");
  assert.equal(old.ciphertext, null);
  const enroll = await post("auth/mfa/enroll", setup, ss.csrf, {
    password: f.password,
  });
  assert.equal(enroll.status, 200);
  const start = await enroll.json();
  assert.match(start.qr, /^data:image\/png;base64,/);
  const row = (
    await f.owner.query("SELECT * FROM mfa_enrollments WHERE id=$1", [
      start.enrollmentId,
    ])
  ).rows[0];
  assert.equal(row.generation, 2);
  const secret = openSecret(row),
    other = await signIn(f, "b"),
    otherState = await state(other);
  assert.equal(
    (
      await post("auth/mfa/confirm", other, otherState.csrf, {
        enrollmentId: start.enrollmentId,
        code: otp(secret, Date.now()),
      })
    ).status,
    401,
  );
  const confirmed = await post("auth/mfa/confirm", setup, ss.csrf, {
    enrollmentId: start.enrollmentId,
    code: otp(secret, Date.now()),
  });
  assert.equal(confirmed.status, 200);
  assert.equal((await confirmed.json()).codes.length, 10);
  assert.equal(
    (
      await fetch(origin + "/api/admin/employees", {
        headers: { cookie: rotated(confirmed) },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await post("auth/mfa/confirm", setup, ss.csrf, {
        enrollmentId: start.enrollmentId,
        code: otp(secret, Date.now()),
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await post("auth/mfa/recover", anon.cookie, anon.csrf, {
        identifier: "admin_" + f.suffix,
        password: f.password,
        code: codes[0],
      })
    ).status,
    401,
  );
});

test("HTTP assisted reset requires verification note/reason and redeems once into enrollment only", async () => {
  const f = await fresh(),
    cookie = await adminAccount(f),
    s = await state(cookie),
    path = "admin/employees/" + f.ids.a + "/mfa-reset";
  // Enroll the target through real HTTP before testing factor replacement.
  let target = await signIn(f, "a");
  const ts = await state(target),
    startResponse = await post("auth/mfa/enroll", target, ts.csrf, {
      password: f.password,
    }),
    start = await startResponse.json();
  assert.equal(startResponse.status, 200);
  const row = (
    await f.owner.query("SELECT * FROM mfa_enrollments WHERE id=$1", [
      start.enrollmentId,
    ])
  ).rows[0];
  const done = await post("auth/mfa/confirm", target, ts.csrf, {
    enrollmentId: start.enrollmentId,
    code: otp(openSecret(row), Date.now()),
  });
  assert.equal(done.status, 200);
  target = rotated(done);
  assert.equal(
    (
      await post(path, cookie, s.csrf, {
        note: "Identity verified by private contact",
      })
    ).status,
    400,
  );
  const reset = await post(path, cookie, s.csrf, {
    note: "Identity verified by private contact",
    reason: "Lost device and all recovery codes",
  });
  assert.equal(reset.status, 200);
  const { token } = await reset.json();
  assert.equal(
    (await fetch(origin + "/api/me", { headers: { cookie: target } })).status,
    401,
  );
  const a = await anonymous(),
    data = { identifier: "a_" + f.suffix, password: f.password, code: token },
    redeemed = await post("auth/mfa/reset/redeem", a.cookie, a.csrf, data);
  assert.equal(redeemed.status, 200);
  assert.equal(
    (
      await fetch(origin + "/api/me", {
        headers: { cookie: rotated(redeemed) },
      })
    ).status,
    403,
  );
  assert.equal(
    (await post("auth/mfa/reset/redeem", a.cookie, a.csrf, data)).status,
    401,
  );
});

test("HTTP TOTP lockout survives new SETUP cookies and expired capabilities are rejected", async () => {
  const f = await fresh(),
    cookie = await signIn(f),
    s = await state(cookie);
  for (let i = 0; i < 5; i++)
    assert.equal(
      (
        await post("auth/mfa/verify", cookie, s.csrf, {
          code: wrongCode(f.adminSecret),
        })
      ).status,
      401,
    );
  assert.equal(
    (await fetch(origin + "/api/session", { headers: { cookie } })).status,
    401,
  );
  const again = await signIn(f),
    ss = await state(again);
  assert.equal(
    (
      await post("auth/mfa/verify", again, ss.csrf, {
        code: otp(f.adminSecret, Date.now()),
      })
    ).status,
    401,
  );
  await f.owner.query(
    "UPDATE sessions SET created_at=now()-interval '1 hour',idle_expires_at=now()-interval '1 minute',absolute_expires_at=now()-interval '1 minute' WHERE token_hash=$1",
    [digest(again.split("=")[1])],
  );
  assert.equal(
    (await fetch(origin + "/api/session", { headers: { cookie: again } }))
      .status,
    401,
  );
});

test("HTTP MFA mutations enforce CSRF and operator/duty handlers are absent", async () => {
  const f = await fresh(),
    cookie = await signIn(f, "a"),
    s = await state(cookie);
  assert.equal(
    (await post("auth/mfa/enroll", cookie, "invalid", { password: f.password }))
      .status,
    403,
  );
  for (const path of [
    "operator/reset-admin",
    "auth/duty/login",
    "auth/mfa/operator",
  ])
    assert.equal((await post(path, cookie, s.csrf, {})).status, 404);
  const page = await fetch(origin + "/mfa/recovery");
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes("Recovery method"));
  assert.ok(!html.includes("otpauth://"));
  assert.ok(!html.includes("MFA_ENCRYPTION_KEYS"));
});
