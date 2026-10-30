import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "../helpers";
import { otp } from "../../src/lib/mfa-crypto";
const origin = process.env.HTTP_TEST_ORIGIN ?? "http://127.0.0.1:3001";
if (!["127.0.0.1", "localhost"].includes(new URL(origin).hostname))
  throw new Error("HTTP tests must target local development");
let f: Awaited<ReturnType<typeof fixture>>, a: string, b: string, admin: string;
async function signIn(identifier: string, password: string) {
  const csrfResponse = await fetch(origin + "/api/auth/csrf");
  assert.equal(csrfResponse.status, 200);
  const { csrf } = await csrfResponse.json(),
    cookie = csrfResponse.headers.get("set-cookie")!.split(";")[0];
  const response = await fetch(origin + "/api/auth/login", {
    method: "POST",
    headers: { origin, "content-type": "application/json", cookie },
    body: JSON.stringify({ identifier, password, csrf }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie")!, /HttpOnly/);
  assert.match(response.headers.get("set-cookie")!, /SameSite=Lax/);
  return response.headers.get("set-cookie")!.split(";")[0];
}
before(async () => {
  f = await fixture();
  a = await signIn("a_" + f.suffix, f.password);
  b = await signIn("b_" + f.suffix, f.password);
  admin = await signIn("admin_" + f.suffix, f.password);
  assert.equal(
    (
      await fetch(origin + "/api/admin/employees", {
        headers: { cookie: admin },
      })
    ).status,
    403,
  );
  const context = await (
    await fetch(origin + "/api/session", { headers: { cookie: admin } })
  ).json();
  const response = await fetch(origin + "/api/auth/mfa/verify", {
    method: "POST",
    headers: { origin, "content-type": "application/json", cookie: admin },
    body: JSON.stringify({
      csrf: context.csrf,
      code: otp(f.adminSecret, Date.now()),
    }),
  });
  assert.equal(response.status, 200);
  admin = response.headers.get("set-cookie")!.split(";")[0];
});
after(async () => {
  await f.owner.end();
});
test("real HTTP server denies A→B and B→A guessed profile/rate URLs", async () => {
  for (const [cookie, other, own] of [
    [a, f.ids.b, f.ids.a],
    [b, f.ids.a, f.ids.b],
  ]) {
    const denied = await fetch(origin + "/api/employees/" + other, {
      headers: { cookie },
    });
    assert.equal(denied.status, 404);
    assert.match(denied.headers.get("cache-control")!, /no-store/);
    assert.equal(
      (await fetch(origin + "/api/employees/" + own, { headers: { cookie } }))
        .status,
      200,
    );
    assert.equal(
      (
        await fetch(origin + "/api/admin/employees/" + other, {
          headers: { cookie },
        })
      ).status,
      403,
    );
  }
});
test("real HTTP pages isolate employee SSR/client payloads and block administrative pages", async () => {
  const own = await fetch(origin + "/me/profile", { headers: { cookie: a } });
  assert.equal(own.status, 200);
  const text = await own.text();
  assert.ok(text.includes(`Test A ${f.suffix}`));
  assert.ok(!text.includes(`Test B ${f.suffix}`));
  assert.ok(!text.includes("250.5000"));
  const denied = await fetch(origin + "/admin/employees/" + f.ids.b, {
    headers: { cookie: a },
    redirect: "manual",
  });
  assert.equal(denied.status, 307);
  assert.equal(denied.headers.get("location"), "/me");
  const adminPage = await fetch(origin + "/admin/employees/" + f.ids.b, {
    headers: { cookie: admin },
  });
  assert.equal(adminPage.status, 200);
  assert.ok((await adminPage.text()).includes(`Test B ${f.suffix}`));
});
test("real HTTP rejects anonymous reads and CSRF mutation; session cookies stop working after logout", async () => {
  assert.equal((await fetch(origin + "/api/admin/employees")).status, 401);
  assert.equal(
    (
      await fetch(origin + "/api/auth/logout", {
        method: "POST",
        headers: { origin, "content-type": "application/json", cookie: a },
        body: "{}",
      })
    ).status,
    403,
  );
  const s = await (
    await fetch(origin + "/api/session", { headers: { cookie: a } })
  ).json();
  const response = await fetch(origin + "/api/auth/logout", {
    method: "POST",
    headers: { origin, "content-type": "application/json", cookie: a },
    body: JSON.stringify({ csrf: s.csrf }),
  });
  assert.equal(response.status, 200);
  assert.equal(
    (await fetch(origin + "/api/me", { headers: { cookie: a } })).status,
    401,
  );
});
test("login page has a per-request script nonce, security headers and working form markup", async () => {
  const page = await fetch(origin + "/login");
  assert.equal(page.status, 200);
  const csp = page.headers.get("content-security-policy")!;
  assert.match(csp, /nonce-/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  const html = await page.text();
  assert.ok(html.includes('name="identifier"'));
  assert.ok(html.includes('nonce="'));
  assert.ok(!html.includes("password_hash"));
});
