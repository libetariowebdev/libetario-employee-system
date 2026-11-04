import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { payrollFixture } from "../payroll-helpers";
import { authPool, db } from "../../src/server/db";

const origin = process.env.HTTP_TEST_ORIGIN ?? "http://127.0.0.1:3001";
if (!["127.0.0.1", "localhost"].includes(new URL(origin).hostname))
  throw new Error("Local HTTP tests only");
after(async () => {
  await db.$disconnect();
  await authPool.end();
});
const headers = (token: string) => ({ cookie: "libetario_session=" + token });
const get = (path: string, token: string, rsc = false) =>
  fetch(origin + path, {
    headers: { ...headers(token), ...(rsc ? { RSC: "1" } : {}) },
    redirect: rsc ? "follow" : "manual",
  });

test("real HTTP, SSR and RSC isolate employee finalized lines and hide drafts off duty", async () => {
  const f = await payrollFixture();
  try {
    await f.shift(
      "a",
      f.start,
      f.start + "T00:00:00Z",
      f.start + "T03:00:00Z",
      "10800",
    );
    await f.shift(
      "b",
      f.start,
      f.start + "T00:00:00Z",
      f.start + "T01:00:00Z",
      "3600",
    );
    const { id } = await f.prepare(["a", "b"]);
    const period = await f.period(id);
    const a = period.lines.find((l) => l.employeeId === f.ids.a)!;
    const b = period.lines.find((l) => l.employeeId === f.ids.b)!;
    assert.deepEqual(
      await (await get("/api/payroll/own", f.tokens.a)).json(),
      [],
    );
    assert.equal(
      (await get("/api/payroll/own/" + a.id, f.tokens.a)).status,
      404,
    );
    await f.approve(id);
    const own = await get("/api/payroll/own/" + a.id, f.tokens.a);
    assert.equal(own.status, 200);
    assert.match(own.headers.get("cache-control") ?? "", /no-store/);
    const dto = await own.json();
    assert.equal(dto.net, "300.38");
    assert.equal(dto.state, "APPROVED");
    assert.equal(dto.snapshot, undefined);
    const guessed = await get("/api/payroll/own/" + b.id, f.tokens.a);
    const missing = await get("/api/payroll/own/" + randomUUID(), f.tokens.a);
    assert.equal(guessed.status, 404);
    assert.equal(missing.status, 404);
    assert.equal(await guessed.text(), await missing.text());
    assert.equal(
      (await get("/api/payroll/own/" + a.id, f.tokens.b)).status,
      404,
    );
    for (const rsc of [false, true]) {
      const page = await get("/me/payroll/" + a.id, f.tokens.a, rsc);
      assert.equal(page.status, 200);
      if (rsc)
        assert.match(
          page.headers.get("content-type") ?? "",
          /text\/x-component/,
        );
      const rendered = await page.text();
      assert.match(rendered, /300\.38/);
      assert.doesNotMatch(rendered, new RegExp(b.id));
      const foreign = await get("/me/payroll/" + b.id, f.tokens.a, rsc);
      const absent = await get("/me/payroll/" + randomUUID(), f.tokens.a, rsc);
      assert.equal(foreign.status, absent.status);
      const foreignPayload = await foreign.text();
      const absentPayload = await absent.text();
      if (rsc) {
        // React Flight can already be streaming when the route throws notFound().
        for (const payload of [foreignPayload, absentPayload])
          assert.match(payload, /NEXT_HTTP_ERROR_FALLBACK;404/);
      } else {
        assert.equal(foreign.status, 404);
      }
      assert.doesNotMatch(foreignPayload, /250\.50/);
    }
    assert.equal((await get("/api/payroll/settings", f.tokens.a)).status, 403);
    assert.equal((await get("/api/payroll/own", "invalid")).status, 401);
  } finally {
    await f.cleanup();
  }
});

test("real HTTP payroll mutations require CSRF and recent MFA; settings and review are backed by data", async () => {
  const f = await payrollFixture({ weekday: 6, paydayOffset: 0 });
  try {
    const { id } = await f.prepare();
    const p = await f.period(id);
    const csrf = (await (await get("/api/session", f.tokens.admin)).json())
      .csrf;
    const data = {
      expectedVersion: p.version,
      manifest: p.reviewManifest,
      operationKey: randomUUID(),
    };
    const submit = (token: string, csrfInput: string) =>
      fetch(origin + "/api/payroll/periods/" + id + "/approve", {
        method: "POST",
        headers: {
          ...headers(token),
          "Content-Type": "application/json",
          Origin: origin,
        },
        body: JSON.stringify({ ...data, csrf: csrfInput }),
      });
    assert.equal((await submit(f.tokens.admin, "invalid")).status, 403);
    assert.equal((await submit(f.tokens.admin, csrf)).status, 422);
    const employeeCsrf = (await (await get("/api/session", f.tokens.a)).json())
      .csrf;
    assert.equal((await submit(f.tokens.a, employeeCsrf)).status, 403);
    const settings = await get("/admin/payroll/settings", f.tokens.admin);
    assert.equal(settings.status, 200);
    assert.match(await settings.text(), /Money rounding/);
    const review = await get("/admin/payroll/periods/" + id, f.tokens.admin);
    assert.equal(review.status, 200);
    assert.match(await review.text(), /employee lines need review/);
  } finally {
    await f.cleanup();
  }
});
