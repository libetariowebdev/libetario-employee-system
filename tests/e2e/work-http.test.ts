import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  workFixture,
  taskInput,
  sharedTask,
  runtime,
  blocked,
} from "../work-helpers";
import { freeze, setPolicy } from "../duty-helpers";
import { db, authPool } from "../../src/server/db";
import { digest, csrfForSession } from "../../src/server/auth/security";
import { taskDetail, projectDetail } from "../../src/server/dal/tasks";
import { otp } from "../../src/lib/mfa-crypto";
const origin = process.env.HTTP_TEST_ORIGIN ?? "http://127.0.0.1:3001";
if (!["127.0.0.1", "localhost"].includes(new URL(origin).hostname))
  throw new Error("Local HTTP test server required");
after(async () => {
  await db.$disconnect();
  await authPool.end();
});
const reason = "Owner approved HTTP project-work change";
type F = Awaited<ReturnType<typeof workFixture>>;
type Jar = Record<string, string>;
const admin = (f: F): Jar => ({ libetario_session: f.tokens.admin });
const duty = (f: F, who = "a"): Jar => ({ libetario_duty: f.duty[who].token });
function cookie(jar: Jar) {
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
async function get(
  path: string,
  jar: Jar = {},
  headers: Record<string, string> = {},
) {
  return fetch(origin + "/api/" + path, {
    headers: { cookie: cookie(jar), ...headers },
  });
}
async function send(
  path: string,
  jar: Jar,
  input: unknown,
  method = "POST",
  extra: Record<string, string> = {},
) {
  const token = path.startsWith("work/")
    ? jar.libetario_session && !jar.libetario_duty
      ? jar.libetario_session
      : jar.libetario_duty
    : jar.libetario_session;
  return fetch(origin + "/api/" + path, {
    method,
    headers: {
      origin,
      "content-type": "application/json",
      cookie: cookie(jar),
      ...extra,
    },
    body: JSON.stringify({
      ...(input as object),
      csrf: csrfForSession(token ?? ""),
    }),
  });
}
async function ok(r: Response, status = 200) {
  assert.equal(r.status, status, await r.clone().text());
  return r.json();
}
async function page(
  path: string,
  jar: Jar,
  headers: Record<string, string> = {},
) {
  return fetch(origin + path, {
    headers: { cookie: cookie(jar), ...headers },
    redirect: "manual",
  });
}
test("HTTP 15.4: three DUTY assignees see one shared task, three own contribution records; ACCOUNT and unassigned denied", async () => {
  const f = await workFixture();
  try {
    const r = await ok(await send("work/tasks", admin(f), taskInput(f)), 201),
      ids = [];
    for (const who of ["a", "b", "c"]) {
      const d = await ok(await get("work/tasks/" + r.id, duty(f, who)));
      assert.equal(d.task.id, r.id);
      assert.equal(d.assignments.length, 1);
      ids.push(d.assignments[0].id);
    }
    assert.equal(new Set(ids).size, 3);
    assert.equal(
      (await ok(await get("work/projects/" + f.projectId, admin(f))))
        .task_count,
      1,
    );
    assert.equal(
      (await get("work/tasks", { libetario_session: f.tokens.a })).status,
      401,
    );
    const own = await sharedTask(f, {
      assignmentMode: "INDIVIDUAL",
      employeeIds: [f.ids.a],
    });
    assert.equal((await get("work/tasks/" + own, duty(f, "b"))).status, 404);
  } finally {
    await f.cleanup();
  }
});
test("HTTP INDIVIDUAL/SELECTED/ALL_ACTIVE cardinality, snapshots, late hire exclusion and explicit addition", async () => {
  const f = await workFixture(),
    old = (
      await f.owner.query(
        "SELECT user_id,start_date FROM employee_profiles WHERE user_id<>ALL($1::uuid[])",
        [Object.values(f.ids)],
      )
    ).rows;
  try {
    await f.owner.query(
      "UPDATE employee_profiles SET start_date='2099-01-01' WHERE user_id<>ALL($1::uuid[]) OR user_id=$2",
      [Object.values(f.ids), f.ids.c],
    );
    for (const [mode, ids] of [
      ["INDIVIDUAL", [f.ids.a]],
      ["SELECTED", [f.ids.a, f.ids.b]],
      ["ALL_ACTIVE", []],
    ] as const) {
      const input = taskInput(f, { assignmentMode: mode, employeeIds: ids }),
        r = await ok(await send("work/tasks", admin(f), input), 201),
        d = await ok(await get("work/tasks/" + r.id, admin(f)));
      assert.equal(d.assignments.length, mode === "INDIVIDUAL" ? 1 : 2);
      if (mode === "ALL_ACTIVE") {
        await f.owner.query(
          "UPDATE employee_profiles SET start_date='2026-01-01' WHERE user_id=$1",
          [f.ids.c],
        );
        assert.equal(
          (await get("work/tasks/" + r.id, duty(f, "c"))).status,
          404,
        );
        assert.equal(
          (await ok(await send("work/tasks", admin(f), input), 201)).id,
          r.id,
        );
        await ok(
          await send("work/tasks/" + r.id + "/members", admin(f), {
            expectedVersion: d.task.version,
            add: [f.ids.c],
            remove: [],
            reason,
          }),
        );
        await ok(await get("work/tasks/" + r.id, duty(f, "c")));
      }
    }
  } finally {
    for (const row of old)
      await f.owner.query(
        "UPDATE employee_profiles SET start_date=$2 WHERE user_id=$1",
        [row.user_id, row.start_date],
      );
    await f.cleanup();
  }
});
test("HTTP same-project task/comment guessing, search/counts and SSR/RSC disclose no unrelated work", async () => {
  const f = await workFixture();
  try {
    const a = await sharedTask(f, {
        title: "Visible A " + f.suffix,
        assignmentMode: "INDIVIDUAL",
        employeeIds: [f.ids.a],
      }),
      b = await sharedTask(f, {
        title: "Secret B " + f.suffix,
        assignmentMode: "INDIVIDUAL",
        employeeIds: [f.ids.b],
      });
    await ok(
      await send("work/tasks/" + b + "/comments", duty(f, "b"), {
        creationKey: randomUUID(),
        body: "Confidential B comment",
      }),
      201,
    );
    const hidden = await get("work/tasks/" + b, duty(f)),
      missing = await get("work/tasks/" + randomUUID(), duty(f));
    assert.equal(hidden.status, 404);
    assert.equal(missing.status, 404);
    assert.deepEqual(await hidden.json(), await missing.json());
    for (const h of ["content-type", "cache-control"])
      assert.equal(hidden.headers.get(h), missing.headers.get(h));
    assert.equal(
      (
        await ok(
          await get(
            "work/tasks?q=" + encodeURIComponent("Secret B " + f.suffix),
            duty(f),
          ),
        )
      ).total,
      0,
    );
    assert.equal(
      (await ok(await get("work/projects/" + f.projectId, duty(f)))).task_count,
      1,
    );
    const html = await page("/work/tasks", duty(f));
    assert.equal(html.status, 200);
    const text = await html.text();
    assert.match(text, new RegExp("Visible A " + f.suffix));
    assert.equal(text.includes("Secret B " + f.suffix), false);
    assert.equal(text.includes("Confidential B comment"), false);
    const foreign = await page("/work/tasks/" + b, duty(f));
    assert.equal(foreign.status, 404);
    assert.equal(
      (await foreign.text()).includes("Confidential B comment"),
      false,
    );
    const rsc = await page("/work/tasks/" + b, duty(f), { RSC: "1" });
    assert.equal((await rsc.text()).includes("Secret B " + f.suffix), false);
    assert.equal((await get("work/tasks/" + a, duty(f))).status, 200);
  } finally {
    await f.cleanup();
  }
});
test("HTTP progress actor/time/version, reserved transitions and direct SQL gate; comments shared/immutable with no spoofed author", async () => {
  const f = await workFixture();
  try {
    const id = await sharedTask(f);
    await ok(
      await send("work/tasks/" + id + "/progress", duty(f), {
        expectedVersion: 1,
        status: "IN_PROGRESS",
      }),
    );
    assert.equal(
      (
        await send("work/tasks/" + id + "/progress", duty(f), {
          expectedVersion: 1,
          status: "IN_PROGRESS",
        })
      ).status,
      409,
    );
    for (const status of ["SUBMITTED", "REVISION_REQUIRED", "APPROVED"])
      assert.equal(
        (
          await send("work/tasks/" + id + "/progress", duty(f), {
            expectedVersion: 2,
            status,
          })
        ).status,
        400,
      );
    assert.equal(
      (
        await send("work/tasks/" + id + "/comments", duty(f), {
          creationKey: randomUUID(),
          body: "Forged identity",
          authorId: f.ids.b,
        })
      ).status,
      400,
    );
    const input = { creationKey: randomUUID(), body: "Actual shared comment" },
      c = await ok(
        await send("work/tasks/" + id + "/comments", duty(f), input),
        201,
      );
    assert.equal(
      (
        await ok(
          await send("work/tasks/" + id + "/comments", duty(f), input),
          201,
        )
      ).id,
      c.id,
    );
    const b = await ok(await get("work/tasks/" + id, duty(f, "b")));
    assert.equal(b.task.own_status, "PENDING");
    assert.equal(b.comments[0].body, input.body);
    assert.equal(b.comments[0].author_label, "Test A " + f.suffix);
    await runtime(f.duty.a.token, async (c) => {
      await assert.rejects(() =>
        c.query("SELECT private.task_progress($1,2,'SUBMITTED',NULL)", [id]),
      );
    });
  } finally {
    await f.cleanup();
  }
});
test("HTTP new/updated visit indicator is per employee, CSRF-protected and preserves updates arriving after the list snapshot", async () => {
  const f = await workFixture();
  try {
    const id = await sharedTask(f),
      first = (await ok(await get("work/tasks", duty(f)))).tasks[0];
    assert.equal(first.indicator, "NEW");
    const input = {
      observations: [
        {
          assignmentId: first.assignment_id,
          taskVersion: first.version,
          projectVersion: first.project_version,
          assignmentVersion: first.assignment_version,
        },
      ],
    };
    await ok(
      await send("work/tasks/" + id + "/comments", duty(f, "b"), {
        creationKey: randomUUID(),
        body: "New after read",
      }),
      201,
    );
    await ok(await send("work/seen", duty(f), input));
    const next = (await ok(await get("work/tasks", duty(f)))).tasks[0];
    assert.equal(next.indicator, "UPDATED");
    await ok(
      await send("work/seen", duty(f), {
        observations: [
          {
            assignmentId: next.assignment_id,
            taskVersion: next.version,
            projectVersion: next.project_version,
            assignmentVersion: next.assignment_version,
          },
        ],
      }),
    );
    assert.equal(
      (await ok(await get("work/tasks", duty(f)))).tasks[0].indicator,
      null,
    );
    assert.equal(
      (await ok(await get("work/tasks", duty(f, "b")))).tasks[0].indicator,
      "NEW",
    );
    assert.equal((await send("work/seen", duty(f, "b"), input)).status, 404);
  } finally {
    await f.cleanup();
  }
});
test("HTTP project default ACTIVE, read-only explanation for every non-ACTIVE state, progress/comments disabled", async () => {
  const f = await workFixture();
  try {
    const id = await sharedTask(f);
    assert.equal(
      (await ok(await get("work/projects/" + f.projectId, admin(f)))).status,
      "ACTIVE",
    );
    for (const status of ["PLANNING", "ON_HOLD", "CANCELLED"]) {
      const p = await ok(await get("work/projects/" + f.projectId, admin(f)));
      await ok(
        await send(
          "work/projects/" + p.id,
          admin(f),
          { expectedVersion: p.version, status, reason },
          "PATCH",
        ),
      );
      const r = await page("/work/tasks/" + id, duty(f));
      assert.equal(r.status, 200);
      assert.match(await r.text(), /Progress and comments are disabled/);
      assert.equal(
        (
          await send("work/tasks/" + id + "/progress", duty(f), {
            expectedVersion: 1,
            status: "IN_PROGRESS",
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await send("work/tasks/" + id + "/comments", duty(f), {
            creationKey: randomUUID(),
            body: "Read-only write",
          })
        ).status,
        400,
      );
    }
    assert.equal(
      (
        await send(
          "work/projects/" + f.projectId,
          admin(f),
          { expectedVersion: 4, status: "COMPLETED", reason },
          "PATCH",
        )
      ).status,
      400,
    );
  } finally {
    await f.cleanup();
  }
});
test("HTTP membership withdrawal removes next request access; explicit restoration retains contribution identity, old history and project count", async () => {
  const f = await workFixture();
  try {
    const id = await sharedTask(f),
      d = await ok(await get("work/tasks/" + id, duty(f)));
    await ok(
      await send("work/tasks/" + id + "/comments", duty(f), {
        creationKey: randomUUID(),
        body: "Retained original comment",
      }),
      201,
    );
    let t = await ok(await get("work/tasks/" + id, admin(f)));
    await ok(
      await send("work/tasks/" + id + "/members", admin(f), {
        expectedVersion: t.task.version,
        add: [],
        remove: [f.ids.a],
        reason,
      }),
    );
    assert.equal((await get("work/tasks/" + id, duty(f))).status, 404);
    assert.equal(
      (
        await send("work/tasks/" + id + "/comments", duty(f), {
          creationKey: randomUUID(),
          body: "After withdrawal",
        })
      ).status,
      404,
    );
    t = await ok(await get("work/tasks/" + id, admin(f)));
    await ok(
      await send("work/tasks/" + id + "/members", admin(f), {
        expectedVersion: t.task.version,
        add: [f.ids.a],
        remove: [],
        reason,
      }),
    );
    const restored = await ok(await get("work/tasks/" + id, duty(f)));
    assert.equal(restored.assignments[0].id, d.assignments[0].id);
    assert.equal(restored.comments.length, 1);
    t = await ok(await get("work/tasks/" + id, admin(f)));
    await ok(
      await send("work/tasks/" + id + "/members", admin(f), {
        expectedVersion: t.task.version,
        add: [],
        remove: [f.ids.a, f.ids.b, f.ids.c],
        reason,
      }),
    );
    t = await ok(await get("work/tasks/" + id, admin(f)));
    assert.equal(t.task.status, "CANCELLED");
    await ok(
      await send("work/tasks/" + id + "/members", admin(f), {
        expectedVersion: t.task.version,
        add: [f.ids.a],
        remove: [],
        reason,
      }),
    );
    const reopened = await ok(await get("work/tasks/" + id, duty(f)));
    assert.equal(reopened.task.status, "PENDING");
    assert.equal(reopened.assignments[0].id, d.assignments[0].id);
    assert.equal(
      (await ok(await get("work/projects/" + f.projectId, admin(f))))
        .task_count,
      1,
    );
  } finally {
    await f.cleanup();
  }
});
test("HTTP revoke/disable invalidates actual task access and direct duty SQL, legitimate comments/contributions retained", async () => {
  const f = await workFixture();
  try {
    const id = await sharedTask(f);
    await ok(
      await send("work/tasks/" + id + "/comments", duty(f), {
        creationKey: randomUUID(),
        body: "Legitimate comment before revoke",
      }),
      201,
    );
    await ok(
      await send("admin/duty", admin(f), {
        employeeIds: [f.ids.a],
        date: f.day,
        action: "REVOKE",
        reason,
      }),
    );
    assert.equal((await get("work/tasks/" + id, duty(f))).status, 401);
    await runtime(f.duty.a.token, async (c) =>
      assert.equal((await c.query("SELECT * FROM tasks")).rowCount, 0),
    );
    await f.owner.query(
      "UPDATE users SET disabled_at=private.security_now(),authorization_version=authorization_version+1 WHERE id=$1",
      [f.ids.b],
    );
    assert.equal((await get("work/tasks/" + id, duty(f, "b"))).status, 401);
    assert.equal(
      (await ok(await get("work/tasks/" + id, admin(f)))).comments.length,
      1,
    );
    assert.equal((await taskDetail(f.admin, id)).assignments.length, 3);
  } finally {
    await f.cleanup();
  }
});
test("HTTP work mutations enforce origin/CSRF, roles, body bounds and SHARED-only collaboration", async () => {
  const f = await workFixture();
  try {
    const id = await sharedTask(f);
    assert.equal(
      (
        await send(
          "work/tasks/" + id + "/comments",
          duty(f),
          { creationKey: randomUUID(), body: "Cross-site" },
          "POST",
          { origin: "https://attacker.invalid" },
        )
      ).status,
      403,
    );
    const bad = await fetch(origin + "/api/work/tasks/" + id + "/comments", {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        cookie: cookie(duty(f)),
      },
      body: JSON.stringify({
        csrf: "forged",
        creationKey: randomUUID(),
        body: "Bad CSRF",
      }),
    });
    assert.equal(bad.status, 403);
    assert.equal((await send("work/tasks", duty(f), taskInput(f))).status, 403);
    assert.equal(
      (
        await send(
          "work/tasks",
          admin(f),
          taskInput(f, { collaborationMode: "COPIES" }),
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await send("work/tasks/" + id + "/comments", duty(f), {
          creationKey: randomUUID(),
          body: "x".repeat(131073),
        })
      ).status,
      413,
    );
    assert.equal(
      (
        await send("work/tasks/" + id + "/comments", duty(f), {
          body: "No key",
        })
      ).status,
      400,
    );
  } finally {
    await f.cleanup();
  }
});
test("HTTP DUTY survives ACCOUNT expiry independently; mixed identities and administrator SETUP never acquire work privilege", async () => {
  const f = await workFixture();
  try {
    const id = await sharedTask(f);
    await f.owner.query(
      "UPDATE sessions SET idle_expires_at=private.security_now()-interval '1 second' WHERE token_hash=$1",
      [digest(f.tokens.a)],
    );
    assert.equal(
      (
        await get("work/tasks/" + id, {
          ...duty(f),
          libetario_session: f.tokens.a,
        })
      ).status,
      200,
    );
    assert.equal(
      (await get("work/tasks/" + id, { ...duty(f), ...admin(f) })).status,
      403,
    );
    const token = digest(randomUUID());
    await f.owner.query(
      "INSERT INTO sessions(user_id,token_hash,csrf_token_hash,scope,setup_purpose,authorization_version,idle_expires_at,absolute_expires_at) VALUES($1,$2,$2,'SETUP','MFA_LOGIN',1,private.security_now()+interval '5 minutes',private.security_now()+interval '5 minutes')",
      [f.ids.admin, digest(token)],
    );
    assert.equal(
      (await get("work/tasks", { libetario_session: token })).status,
      401,
    );
    assert.equal((await get("work/tasks", admin(f))).status, 200);
    const redirected = await page("/work/tasks", {
      libetario_session: f.tokens.b,
    });
    assert.equal(redirected.status, 307);
    assert.match(redirected.headers.get("location")!, /duty\/reauth/);
  } finally {
    await f.cleanup();
  }
});
test("HTTP race: committed withdrawal while comment waits rechecks task ownership before insertion", async () => {
  const f = await workFixture();
  try {
    const id = await sharedTask(f);
    await f.owner.query("BEGIN");
    await f.owner.query("SELECT id FROM projects WHERE id=$1 FOR UPDATE", [
      f.projectId,
    ]);
    const response = send("work/tasks/" + id + "/comments", duty(f), {
      creationKey: randomUUID(),
      body: "Never publish withdrawn work",
    });
    await blocked(f.owner, "private.add_task_comment");
    await f.owner.query(
      "UPDATE task_assignments SET access_revoked_at=private.security_now(),access_revoked_by=$3,revocation_reason=$4,status='CANCELLED',counts_for_completion=false WHERE task_id=$1 AND employee_id=$2",
      [id, f.ids.a, f.ids.admin, reason],
    );
    await f.owner.query("COMMIT");
    assert.equal((await response).status, 404);
    assert.equal(
      (
        await f.owner.query("SELECT id FROM task_comments WHERE task_id=$1", [
          id,
        ])
      ).rowCount,
      0,
    );
  } finally {
    await f.owner.query("ROLLBACK");
    await f.cleanup();
  }
});
test("HTTP task access follows the original overnight duty date after Manila midnight without an implicit next-date grant", async () => {
  const f = await workFixture();
  try {
    const id = await sharedTask(f),
      cfg = (
        await f.owner.query(
          "SELECT p.configuration FROM company_settings s JOIN policy_versions p ON p.id=s.work_policy_id",
        )
      ).rows[0].configuration;
    await setPolicy(f, "WORK", {
      ...cfg,
      overnightEnabled: true,
      overnightCarryHours: 8,
    });
    await ok(
      await send("admin/duty", admin(f), {
        employeeIds: [f.ids.a],
        date: f.day,
        action: "REVOKE",
        reason,
      }),
    );
    const next = new Date(new Date(f.day + "T00:00:00Z").getTime() + 86400000)
        .toISOString()
        .slice(0, 10),
      end = next + "T03:00:00+08:00";
    await ok(
      await send("admin/duty", admin(f), {
        employeeIds: [f.ids.a],
        date: f.day,
        action: "REGRANT",
        reason,
        overnight: true,
        validUntil: end,
      }),
    );
    const jar: Jar = { libetario_session: f.tokens.a };
    const ch = await ok(
      await send("auth/duty/start", jar, { date: f.day, password: f.password }),
    );
    f.now = new Date(f.now.getTime() + 30000);
    await freeze(f.owner, f.now);
    let r = await fetch(origin + "/api/auth/duty/totp", {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        cookie: cookie(jar),
      },
      body: JSON.stringify({
        csrf: ch.csrf,
        challenge: ch.challenge,
        binding: "ACCOUNT",
        code: otp(f.duty.a.secret, f.now.getTime()),
      }),
    });
    await ok(r);
    absorb(jar, r);
    f.now = new Date(f.day + "T23:59:00+08:00");
    await freeze(f.owner, f.now);
    delete jar.libetario_session;
    const re = await ok(
      await fetch(origin + "/api/auth/duty/reauth", {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          cookie: cookie(jar),
        },
        body: JSON.stringify({ csrf: csrfForSession(jar.libetario_duty) }),
      }),
    );
    r = await fetch(origin + "/api/auth/duty/totp", {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        cookie: cookie(jar),
      },
      body: JSON.stringify({
        csrf: re.csrf,
        challenge: re.challenge,
        binding: "DUTY",
        code: otp(f.duty.a.secret, f.now.getTime()),
      }),
    });
    await ok(r);
    absorb(jar, r);
    f.now = new Date(next + "T00:05:00+08:00");
    await freeze(f.owner, f.now);
    assert.equal((await get("work/tasks/" + id, jar)).status, 200);
    assert.equal((await page("/work/tasks/" + id, jar)).status, 200);
    const d = await ok(await get("duty/context", jar));
    assert.equal(d.duty_date.slice(0, 10), f.day);
    assert.equal(
      (
        await f.owner.query(
          "SELECT id FROM duty_authorizations WHERE employee_id=$1 AND duty_date=$2",
          [f.ids.a, next],
        )
      ).rowCount,
      0,
    );
    f.now = new Date(end);
    await freeze(f.owner, f.now);
    assert.equal((await get("work/tasks/" + id, jar)).status, 401);
  } finally {
    await f.cleanup();
  }
});
