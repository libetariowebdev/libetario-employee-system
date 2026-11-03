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
import { workSession } from "../../src/server/dal/work";
import {
  listTasks,
  listProjects,
  projectDetail,
  taskDetail,
} from "../../src/server/dal/tasks";
import {
  createProject,
  editProject,
  createTask,
  editTask,
  progress,
  membership,
  comment,
  seen,
  updateTaskPolicy,
} from "../../src/server/services/work";
import { session } from "../../src/server/auth/service";
import { mutateDuty } from "../../src/server/services/duty";
after(async () => {
  await db.$disconnect();
  await authPool.end();
});
const reason = "Owner approved project-work test change";
test("15.4 shared three-person task: distinct own contribution identities and progress, shared comments, one project item", async () => {
  const f = await workFixture();
  try {
    const id = await sharedTask(f),
      details = await Promise.all(
        [f.a, f.b, f.c].map((w) => taskDetail(w, id)),
      );
    assert.equal(new Set(details.map((d) => d.assignments[0].id)).size, 3);
    for (const d of details) {
      assert.equal(d.task.id, id);
      assert.equal(d.assignments.length, 1);
      assert.equal(d.task.collaboration_mode, "SHARED");
    }
    await progress(f.a, id, { expectedVersion: 1, status: "IN_PROGRESS" });
    assert.equal((await taskDetail(f.a, id)).task.own_status, "IN_PROGRESS");
    assert.equal((await taskDetail(f.b, id)).task.own_status, "PENDING");
    const text = "<script>alert(1)</script> shared text";
    await comment(f.a, id, { creationKey: randomUUID(), body: text });
    for (const w of [f.a, f.b, f.c])
      assert.equal((await taskDetail(w, id)).comments[0].body, text);
    const p = await projectDetail(f.admin, f.projectId);
    assert.equal(p.task_count, 1);
    assert.equal(p.approved_count, 0);
    assert.equal((await taskDetail(f.admin, id)).assignments.length, 3);
    const h = (await taskDetail(f.b, id)).history;
    assert.equal(
      h.some((e) => e.to_status === "IN_PROGRESS" && e.assignment_id !== null),
      false,
    );
  } finally {
    await f.cleanup();
  }
});
test("INDIVIDUAL and SELECTED enforce cardinality, unique recipients and atomic invalid-recipient rollback", async () => {
  const f = await workFixture();
  try {
    const one = await sharedTask(f, {
      assignmentMode: "INDIVIDUAL",
      employeeIds: [f.ids.a],
    });
    assert.equal((await taskDetail(f.admin, one)).assignments.length, 1);
    const two = await sharedTask(f, { employeeIds: [f.ids.a, f.ids.b] });
    assert.equal((await taskDetail(f.admin, two)).assignments.length, 2);
    for (const input of [
      { assignmentMode: "INDIVIDUAL", employeeIds: [f.ids.a, f.ids.b] },
      { employeeIds: [] },
      { employeeIds: [f.ids.a, f.ids.a] },
      { employeeIds: [f.ids.a, randomUUID()] },
    ])
      await assert.rejects(() => createTask(f.admin, taskInput(f, input)));
    assert.equal((await projectDetail(f.admin, f.projectId)).task_count, 2);
    await runtime(f.admin.token, async (c) => {
      await assert.rejects(() =>
        c.query("SELECT private.create_task($1)", [
          JSON.stringify(
            taskInput(f, {
              assignmentMode: "INDIVIDUAL",
              employeeIds: [f.ids.a, f.ids.b],
            }),
          ),
        ]),
      );
    });
  } finally {
    await f.cleanup();
  }
});
test("ALL_ACTIVE is a materialized eligibility snapshot, late hire/activation excluded, retry stable, explicit addition required", async () => {
  const f = await workFixture();
  const old = (
    await f.owner.query(
      "SELECT user_id,start_date FROM employee_profiles WHERE user_id<>ALL($1::uuid[])",
      [Object.values(f.ids)],
    )
  ).rows;
  try {
    await f.owner.query(
      "UPDATE employee_profiles SET start_date='2099-01-01' WHERE user_id<>ALL($1::uuid[])",
      [Object.values(f.ids)],
    );
    await f.owner.query(
      "UPDATE employee_profiles SET start_date='2099-01-01' WHERE user_id=$1",
      [f.ids.c],
    );
    const input = taskInput(f, {
        assignmentMode: "ALL_ACTIVE",
        employeeIds: [],
      }),
      r = await createTask(f.admin, input),
      before = await taskDetail(f.admin, r.id);
    assert.deepEqual(
      new Set(before.assignments.map((a) => a.employee_id)),
      new Set([f.ids.a, f.ids.b]),
    );
    await f.owner.query(
      "UPDATE employee_profiles SET start_date='2026-01-01' WHERE user_id=$1",
      [f.ids.c],
    );
    assert.equal((await createTask(f.admin, input)).id, r.id);
    assert.equal((await taskDetail(f.admin, r.id)).assignments.length, 2);
    await assert.rejects(
      () => taskDetail(f.c, r.id),
      (e) => (e as any).status === 404,
    );
    await membership(f.admin, r.id, {
      expectedVersion: before.task.version,
      add: [f.ids.c],
      remove: [],
      reason,
    });
    assert.equal((await taskDetail(f.c, r.id)).assignments.length, 1);
    await assert.rejects(
      () => createTask(f.admin, { ...input, title: "different payload" }),
      (e) => (e as any).status === 409,
    );
  } finally {
    for (const row of old)
      await f.owner.query(
        "UPDATE employee_profiles SET start_date=$2 WHERE user_id=$1",
        [row.user_id, row.start_date],
      );
    await f.cleanup();
  }
});
test("ALL_ACTIVE snapshot is not expanded by a concurrent hire while creation waits on its captured recipients", async () => {
  const f = await workFixture();
  const old = (
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
    await f.owner.query("BEGIN");
    await f.owner.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
      f.ids.a,
    ]);
    const pending = createTask(
      f.admin,
      taskInput(f, { assignmentMode: "ALL_ACTIVE", employeeIds: [] }),
    ).then(
      (result) => ({ result, error: null }),
      (error) => ({ result: null, error }),
    );
    await blocked(f.owner, "private.create_task");
    // The fixture's profile audit must not request an FK lock on the blocked
    // administrator row. This is test-owner concurrency, not an application bypass.
    await f.owner.query("SELECT set_config('app.session_hash','',true)");
    await f.owner.query(
      "UPDATE employee_profiles SET start_date='2026-01-01' WHERE user_id=$1",
      [f.ids.c],
    );
    await f.owner.query("COMMIT");
    const outcome = await pending;
    if (outcome.error) throw outcome.error;
    const r = outcome.result!;
    assert.equal(
      (await taskDetail(f.admin, r.id)).assignments.some(
        (a) => a.employee_id === f.ids.c,
      ),
      false,
    );
  } finally {
    await f.owner.query("ROLLBACK");
    for (const row of old)
      await f.owner.query(
        "UPDATE employee_profiles SET start_date=$2 WHERE user_id=$1",
        [row.user_id, row.start_date],
      );
    await f.cleanup();
  }
});
test("versioned recipient capacity defaults 500, enforces all-or-nothing and preserves unrelated WORK settings", async () => {
  const f = await workFixture();
  try {
    const before = (
      await f.owner.query(
        "SELECT p.* FROM company_settings s JOIN policy_versions p ON p.id=s.work_policy_id",
      )
    ).rows[0];
    assert.equal(before.configuration.tasks?.maxRecipients ?? 500, 500);
    await updateTaskPolicy(f.admin, {
      expectedPolicyId: before.id,
      maxRecipients: 2,
      reason,
    });
    await assert.rejects(() => sharedTask(f));
    assert.equal((await projectDetail(f.admin, f.projectId)).task_count, 0);
    const now = (
      await f.owner.query(
        "SELECT p.* FROM company_settings s JOIN policy_versions p ON p.id=s.work_policy_id",
      )
    ).rows[0];
    assert.equal(
      now.configuration.overnightEnabled,
      before.configuration.overnightEnabled,
    );
    assert.equal(now.configuration.tasks.maxRecipients, 2);
    await assert.rejects(
      () =>
        updateTaskPolicy(f.admin, {
          expectedPolicyId: before.id,
          maxRecipients: 3,
          reason,
        }),
      (e) => (e as any).status === 409,
    );
  } finally {
    await f.cleanup();
  }
});
test("DUTY employee and MFA admin only: expired ACCOUNT independent, conflicts rejected, SETUP and ACCOUNT cannot query work", async () => {
  const f = await workFixture();
  try {
    const id = await sharedTask(f);
    await assert.rejects(() => workSession(f.tokens.a));
    await runtime(f.tokens.a, async (c) => {
      for (const table of [
        "projects",
        "tasks",
        "task_assignments",
        "task_comments",
      ])
        assert.equal((await c.query("SELECT * FROM " + table)).rowCount, 0);
    });
    await assert.rejects(
      () => workSession(f.tokens.admin, f.duty.a.token),
      (e) => (e as any).status === 403,
    );
    await f.owner.query(
      "UPDATE sessions SET idle_expires_at=private.security_now()-interval '1 second' WHERE token_hash=$1",
      [(await import("../helpers")).digest(f.tokens.a)],
    );
    assert.equal(
      (await taskDetail(await workSession(f.tokens.a, f.duty.a.token), id)).task
        .id,
      id,
    );
    const setup = (
      await f.owner.query(
        "SELECT token_hash FROM sessions WHERE user_id=$1 AND scope='SETUP' LIMIT 1",
        [f.ids.admin],
      )
    ).rows[0];
    await runtime("0".repeat(64), async (c) =>
      assert.equal((await c.query("SELECT * FROM tasks")).rowCount, 0),
    );
    assert.ok(setup);
  } finally {
    await f.cleanup();
  }
});
test("same-project RLS isolates all four tables, task/comment guesses return missing, no directory/rates via DUTY", async () => {
  const f = await workFixture();
  try {
    const a = await sharedTask(f, {
        assignmentMode: "INDIVIDUAL",
        employeeIds: [f.ids.a],
      }),
      b = await sharedTask(f, {
        assignmentMode: "INDIVIDUAL",
        employeeIds: [f.ids.b],
      });
    await comment(f.b, b, {
      creationKey: randomUUID(),
      body: "Private B comment",
    });
    for (const [w, token, own, other] of [
      [f.a, f.duty.a.token, a, b],
      [f.b, f.duty.b.token, b, a],
    ] as const) {
      assert.equal((await listTasks(w)).tasks.length, 1);
      const beyondPage = await listTasks(w, { page: 2 });
      assert.equal(beyondPage.total, 1);
      assert.equal(beyondPage.tasks.length, 0);
      const beyondProjects = await listProjects(w, { page: 2 });
      assert.equal(beyondProjects.total, 1);
      assert.equal(beyondProjects.projects.length, 0);
      assert.equal((await projectDetail(w, f.projectId)).task_count, 1);
      await assert.rejects(
        () => taskDetail(w, other),
        (e) => (e as any).status === 404,
      );
      await runtime(token, async (c) => {
        assert.equal(
          (await c.query("SELECT * FROM tasks WHERE id=$1", [other])).rowCount,
          0,
        );
        assert.equal(
          (
            await c.query("SELECT * FROM task_comments WHERE task_id=$1", [
              other,
            ])
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await c.query("SELECT * FROM task_assignments WHERE task_id=$1", [
              other,
            ])
          ).rowCount,
          0,
        );
        assert.equal(
          (await c.query("SELECT * FROM tasks WHERE id=$1", [own])).rowCount,
          1,
        );
        assert.equal(
          (await c.query("SELECT * FROM employee_rate_history")).rowCount,
          0,
        );
        assert.equal(
          (await c.query("SELECT * FROM employee_profiles")).rowCount,
          0,
        );
        assert.equal((await c.query("SELECT * FROM audit_log")).rowCount, 0);
      });
    }
    assert.equal((await listProjects(f.c)).projects.length, 0);
    await assert.rejects(
      () => projectDetail(f.c, f.projectId),
      (e) => (e as any).status === 404,
    );
  } finally {
    await f.cleanup();
  }
});
test("runtime/auth cannot write business tables, forge actors or assume owners; comments immutable", async () => {
  const f = await workFixture();
  try {
    const id = await sharedTask(f);
    for (const sql of [
      "UPDATE tasks SET status='APPROVED'",
      "DELETE FROM task_comments",
      "TRUNCATE task_assignments",
      "SET ROLE libetario_migrator",
      "SELECT private.lock_work(true)",
    ]) {
      await runtime(f.duty.a.token, async (c) => {
        await assert.rejects(() => c.query(sql));
      });
    }
    const event = await comment(f.a, id, {
      creationKey: randomUUID(),
      body: "Retained statement",
    });
    await assert.rejects(
      () =>
        f.owner.query("UPDATE task_comments SET body=$1 WHERE id=$2", [
          "Changed",
          event.id,
        ]),
      (e) => (e as any).code === "42501",
    );
    const auth = new (await import("pg")).default.Client({
      connectionString: process.env.AUTH_DATABASE_URL,
    });
    await auth.connect();
    try {
      await assert.rejects(() => auth.query("SELECT * FROM tasks"));
      await assert.rejects(() =>
        auth.query("SELECT private.create_task($1)", [
          JSON.stringify(taskInput(f)),
        ]),
      );
    } finally {
      await auth.end();
    }
  } finally {
    await f.cleanup();
  }
});
test("3a status graph rejects skips/review states in service and database; status actor/time/audit and stale versions enforced", async () => {
  const f = await workFixture();
  try {
    const id = await sharedTask(f);
    for (const status of [
      "SUBMITTED",
      "REVISION_REQUIRED",
      "APPROVED",
      "CANCELLED",
      "PENDING",
    ])
      await assert.rejects(() =>
        progress(f.a, id, { expectedVersion: 1, status }),
      );
    await runtime(f.duty.a.token, async (c) => {
      await assert.rejects(
        () =>
          c.query("SELECT private.task_progress($1,1,'APPROVED',NULL)", [id]),
        (e) => (e as any).code === "22023",
      );
    });
    await assert.rejects(() =>
      f.owner.query(
        "UPDATE task_assignments SET status='SUBMITTED' WHERE task_id=$1",
        [id],
      ),
    );
    await progress(f.a, id, { expectedVersion: 1, status: "IN_PROGRESS" });
    await assert.rejects(
      () => progress(f.a, id, { expectedVersion: 1, status: "IN_PROGRESS" }),
      (e) => (e as any).status === 409,
    );
    const a = (
      await f.owner.query(
        "SELECT * FROM task_assignments WHERE task_id=$1 AND employee_id=$2",
        [id, f.ids.a],
      )
    ).rows[0];
    assert.equal(a.status_changed_by, f.ids.a);
    assert.equal(a.status_changed_at.getTime(), f.now.getTime());
    assert.equal(
      (
        await f.owner.query(
          "SELECT actor_user_id FROM audit_log WHERE action='assignment.status' AND payload->>'assignment_id'=$1",
          [a.id],
        )
      ).rows[0].actor_user_id,
      f.ids.a,
    );
  } finally {
    await f.cleanup();
  }
});
test("administrator cancel/restore retains identities and history; zero contributors never completes and reassigning INDIVIDUAL is atomic", async () => {
  const f = await workFixture();
  try {
    const id = await sharedTask(f, {
      assignmentMode: "INDIVIDUAL",
      employeeIds: [f.ids.a],
    });
    let t = (await taskDetail(f.admin, id)).task;
    await membership(f.admin, id, {
      expectedVersion: t.version,
      remove: [f.ids.a],
      add: [f.ids.b],
      reason,
    });
    await assert.rejects(() => taskDetail(f.a, id));
    assert.equal((await taskDetail(f.b, id)).task.id, id);
    t = (await taskDetail(f.admin, id)).task;
    await progress(f.admin, id, {
      expectedVersion: t.version,
      status: "CANCELLED",
      reason,
    });
    t = (await taskDetail(f.admin, id)).task;
    assert.equal(
      (await projectDetail(f.admin, f.projectId)).cancelled_count,
      1,
    );
    await progress(f.admin, id, {
      expectedVersion: t.version,
      status: "PENDING",
      reason,
    });
    t = (await taskDetail(f.admin, id)).task;
    await membership(f.admin, id, {
      expectedVersion: t.version,
      remove: [f.ids.b],
      add: [],
      reason,
    });
    assert.equal((await taskDetail(f.admin, id)).task.status, "CANCELLED");
    assert.equal((await projectDetail(f.admin, f.projectId)).approved_count, 0);
    assert.equal((await taskDetail(f.admin, id)).assignments.length, 2);
    t = (await taskDetail(f.admin, id)).task;
    await membership(f.admin, id, {
      expectedVersion: t.version,
      add: [f.ids.a],
      remove: [],
      reason,
    });
    assert.equal((await taskDetail(f.a, id)).task.status, "PENDING");
    assert.equal((await taskDetail(f.admin, id)).assignments.length, 2);
  } finally {
    await f.cleanup();
  }
});
test("non-ACTIVE projects are employee read-only for progress/comments; project defaults ACTIVE and cannot falsely complete", async () => {
  const f = await workFixture();
  try {
    const id = await sharedTask(f);
    assert.equal((await projectDetail(f.admin, f.projectId)).status, "ACTIVE");
    for (const status of ["PLANNING", "ON_HOLD", "CANCELLED"]) {
      const p = await projectDetail(f.admin, f.projectId);
      await editProject(f.admin, p.id, {
        expectedVersion: p.version,
        status,
        reason,
      });
      assert.equal((await taskDetail(f.a, id)).task.project_status, status);
      await assert.rejects(() =>
        progress(f.a, id, { expectedVersion: 1, status: "IN_PROGRESS" }),
      );
      await assert.rejects(() =>
        comment(f.a, id, {
          creationKey: randomUUID(),
          body: "No mutation off active project",
        }),
      );
    }
    const p = await projectDetail(f.admin, f.projectId);
    await assert.rejects(() =>
      editProject(f.admin, p.id, {
        expectedVersion: p.version,
        status: "COMPLETED",
        reason,
      }),
    );
    await assert.rejects(() =>
      f.owner.query("UPDATE projects SET status='COMPLETED' WHERE id=$1", [
        p.id,
      ]),
    );
  } finally {
    await f.cleanup();
  }
});
test("comment/project/task retries idempotent, immutable text retained, canonical URL and bounded fields checked by DB and service", async () => {
  const f = await workFixture();
  try {
    const input = taskInput(f),
      r = await createTask(f.admin, input);
    assert.equal((await createTask(f.admin, input)).id, r.id);
    const ci = { creationKey: randomUUID(), body: "Hello collaborators" },
      c = await comment(f.a, r.id, ci);
    assert.equal((await comment(f.a, r.id, ci)).id, c.id);
    await assert.rejects(() => comment(f.a, r.id, { ...ci, body: "Changed" }));
    for (const url of [
      "javascript:alert(1)",
      "https://user:pass@example.invalid",
      "https://example.invalid\\@evil.invalid",
    ])
      await assert.rejects(() =>
        createTask(f.admin, taskInput(f, { references: [{ url }] })),
      );
    await runtime(f.admin.token, async (c) => {
      await assert.rejects(() =>
        c.query("SELECT private.create_project($1)", [
          JSON.stringify({
            creationKey: randomUUID(),
            code: "INVALID-" + f.suffix,
            name: "Bad link",
            websiteUrl: "javascript:alert(1)",
          }),
        ]),
      );
    });
    await editTask(f.admin, r.id, {
      expectedVersion: (await taskDetail(f.admin, r.id)).task.version,
      title: "Updated brief",
      reason,
    });
    assert.equal((await taskDetail(f.a, r.id)).task.instructions, "");
  } finally {
    await f.cleanup();
  }
});
test("new/updated list badges use private observed versions and cannot swallow a concurrent task/project/comment update", async () => {
  const f = await workFixture();
  try {
    const id = await sharedTask(f),
      first = (await listTasks(f.a)).tasks[0];
    assert.equal(first.indicator, "NEW");
    const obs = {
      assignmentId: first.assignment_id!,
      taskVersion: first.version,
      projectVersion: first.project_version,
      assignmentVersion: first.assignment_version!,
    };
    await comment(f.b, id, {
      creationKey: randomUUID(),
      body: "Arrived after list snapshot",
    });
    await seen(f.a, { observations: [obs] });
    assert.equal((await listTasks(f.a)).tasks[0].indicator, "UPDATED");
    const next = (await listTasks(f.a)).tasks[0];
    await seen(f.a, {
      observations: [
        {
          assignmentId: next.assignment_id!,
          taskVersion: next.version,
          projectVersion: next.project_version,
          assignmentVersion: next.assignment_version!,
        },
      ],
    });
    assert.equal((await listTasks(f.a)).tasks[0].indicator, null);
    assert.equal((await listTasks(f.b)).tasks[0].indicator, "NEW");
    await assert.rejects(
      () => seen(f.b, { observations: [obs] }),
      (e) => (e as any).status === 404,
    );
    const p = await projectDetail(f.admin, f.projectId);
    await editProject(f.admin, p.id, {
      expectedVersion: p.version,
      status: "ON_HOLD",
      reason,
    });
    assert.equal((await listTasks(f.a)).tasks[0].indicator, "UPDATED");
  } finally {
    await f.cleanup();
  }
});
test("committed membership withdrawal and duty revoke deny next DAL/direct SQL requests and retain all history", async () => {
  const f = await workFixture();
  try {
    const id = await sharedTask(f),
      prior = (await taskDetail(f.admin, id)).task;
    await comment(f.a, id, {
      creationKey: randomUUID(),
      body: "Legitimate recorded comment",
    });
    const t = (await taskDetail(f.admin, id)).task;
    await membership(f.admin, id, {
      expectedVersion: t.version,
      remove: [f.ids.a],
      add: [],
      reason,
    });
    await assert.rejects(
      () => taskDetail(f.a, id),
      (e) => (e as any).status === 404,
    );
    await runtime(f.duty.a.token, async (c) =>
      assert.equal(
        (await c.query("SELECT * FROM tasks WHERE id=$1", [id])).rowCount,
        0,
      ),
    );
    await mutateDuty(await session(f.tokens.admin), {
      employeeIds: [f.ids.b],
      date: f.day,
      action: "REVOKE",
      reason,
    });
    await assert.rejects(() => taskDetail(f.b, id));
    await runtime(f.duty.b.token, async (c) =>
      assert.equal((await c.query("SELECT * FROM tasks")).rowCount, 0),
    );
    assert.equal(
      (
        await f.owner.query("SELECT * FROM task_comments WHERE task_id=$1", [
          id,
        ])
      ).rowCount,
      1,
    );
    assert.equal((await taskDetail(f.admin, id)).assignments.length, 3);
    assert.equal(prior.status, "PENDING");
  } finally {
    await f.cleanup();
  }
});
test("duty revocation racing progress: revoke-first prevents mutation after lock wait; history unchanged", async () => {
  const f = await workFixture();
  try {
    const id = await sharedTask(f);
    await f.owner.query("BEGIN");
    await f.owner.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
      f.ids.a,
    ]);
    const pending = progress(f.a, id, {
      expectedVersion: 1,
      status: "IN_PROGRESS",
    }).then(
      () => null,
      (e) => e,
    );
    await blocked(f.owner, "private.task_progress");
    await f.owner.query(
      "UPDATE sessions SET revoked_at=private.security_now(),revocation_reason='DUTY_REVOKE' WHERE user_id=$1 AND scope='DUTY'",
      [f.ids.a],
    );
    await f.owner.query("COMMIT");
    assert.ok(await pending);
    assert.equal(
      (
        await f.owner.query(
          "SELECT status FROM task_assignments WHERE task_id=$1 AND employee_id=$2",
          [id, f.ids.a],
        )
      ).rows[0].status,
      "PENDING",
    );
  } finally {
    await f.owner.query("ROLLBACK");
    await f.cleanup();
  }
});
test("assignment withdrawal racing comment rechecks membership after project lock; no hidden comment committed", async () => {
  const f = await workFixture();
  try {
    const id = await sharedTask(f);
    await f.owner.query("BEGIN");
    await f.owner.query("SELECT id FROM projects WHERE id=$1 FOR UPDATE", [
      f.projectId,
    ]);
    const pending = comment(f.a, id, {
      creationKey: randomUUID(),
      body: "Must not commit after withdrawal",
    }).then(
      () => null,
      (e) => e,
    );
    await blocked(f.owner, "private.add_task_comment");
    await f.owner.query(
      "UPDATE task_assignments SET access_revoked_at=private.security_now(),access_revoked_by=$3,revocation_reason=$4,status='CANCELLED',counts_for_completion=false WHERE task_id=$1 AND employee_id=$2",
      [id, f.ids.a, f.ids.admin, reason],
    );
    await f.owner.query("COMMIT");
    assert.equal((await pending).status, 404);
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
test("concurrent own progress is versioned once, shared count not multiplied, pooled forged/missing contexts default deny", async () => {
  const f = await workFixture();
  try {
    const id = await sharedTask(f);
    const result = await Promise.allSettled([
      progress(f.a, id, { expectedVersion: 1, status: "IN_PROGRESS" }),
      progress(f.a, id, { expectedVersion: 1, status: "IN_PROGRESS" }),
    ]);
    assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await projectDetail(f.admin, f.projectId)).task_count, 1);
    await runtime("", async (c) => {
      await c.query("SELECT set_config('app.user_id',$1,true)", [f.ids.admin]);
      assert.equal((await c.query("SELECT * FROM tasks")).rowCount, 0);
    });
    const other = await sharedTask(f, {
      assignmentMode: "INDIVIDUAL",
      employeeIds: [f.ids.b],
    });
    for (let i = 0; i < 4; i++) {
      assert.equal(
        (await listTasks(f.a)).tasks.some((t) => t.id === other),
        false,
      );
      assert.equal((await listTasks(f.b)).tasks.length, 2);
    }
  } finally {
    await f.cleanup();
  }
});
test("administrator session expiry during a project lock wait prevents final task insertion", async () => {
  const f = await workFixture();
  try {
    await f.owner.query("BEGIN");
    await f.owner.query("SELECT id FROM projects WHERE id=$1 FOR UPDATE", [
      f.projectId,
    ]);
    const pending = createTask(f.admin, taskInput(f)).then(
      (result) => ({ result, error: null }),
      (error) => ({ result: null, error }),
    );
    await blocked(f.owner, "private.create_task");
    await freeze(f.owner, new Date(f.now.getTime() + 16 * 60000));
    await f.owner.query("COMMIT");
    assert.equal((await pending).error?.status, 403);
    assert.equal(
      (
        await f.owner.query("SELECT id FROM tasks WHERE project_id=$1", [
          f.projectId,
        ])
      ).rowCount,
      0,
    );
  } finally {
    await f.owner.query("ROLLBACK");
    await f.cleanup();
  }
});
test("eligibility excludes disabled/inactive staff and new hires receive no earlier ALL_ACTIVE rows", async () => {
  const f = await workFixture();
  const old = (
    await f.owner.query(
      "SELECT user_id,start_date FROM employee_profiles WHERE user_id<>ALL($1::uuid[])",
      [Object.values(f.ids)],
    )
  ).rows;
  try {
    await f.owner.query(
      "UPDATE employee_profiles SET start_date='2099-01-01' WHERE user_id<>ALL($1::uuid[])",
      [Object.values(f.ids)],
    );
    await f.owner.query(
      "UPDATE users SET disabled_at=private.security_now() WHERE id=$1",
      [f.ids.b],
    );
    await f.owner.query(
      "UPDATE employee_profiles SET employment_status='INACTIVE' WHERE user_id=$1",
      [f.ids.c],
    );
    const input = taskInput(f, {
        assignmentMode: "ALL_ACTIVE",
        employeeIds: [],
      }),
      r = await createTask(f.admin, input);
    assert.deepEqual(
      (await taskDetail(f.admin, r.id)).assignments.map((a) => a.employee_id),
      [f.ids.a],
    );
    const hire = randomUUID();
    await f.owner.query(
      "INSERT INTO users(id,email,username,password_hash,role,must_change_password) SELECT $1,$2,$3,password_hash,'EMPLOYEE',false FROM users WHERE id=$4",
      [
        hire,
        "hire_" + f.suffix + "@example.invalid",
        "hire_" + f.suffix,
        f.ids.a,
      ],
    );
    await f.owner.query(
      "INSERT INTO employee_profiles(user_id,employee_number,legal_name,display_name,designation,start_date) VALUES($1,$2,'Fake late hire','Fake late hire','Developer',$3)",
      [hire, "HIRE-" + f.suffix, f.day],
    );
    await f.owner.query("UPDATE users SET disabled_at=NULL WHERE id=$1", [
      f.ids.b,
    ]);
    await f.owner.query(
      "UPDATE employee_profiles SET employment_status='ACTIVE' WHERE user_id=$1",
      [f.ids.c],
    );
    assert.equal((await createTask(f.admin, input)).id, r.id);
    assert.equal(
      (
        await f.owner.query(
          "SELECT id FROM task_assignments WHERE task_id=$1 AND employee_id=ANY($2::uuid[])",
          [r.id, [hire, f.ids.b, f.ids.c]],
        )
      ).rowCount,
      0,
    );
    await membership(f.admin, r.id, {
      expectedVersion: 1,
      add: [hire],
      remove: [],
      reason,
    });
    assert.equal(
      (
        await f.owner.query(
          "SELECT id FROM task_assignments WHERE task_id=$1 AND employee_id=$2",
          [r.id, hire],
        )
      ).rowCount,
      1,
    );
  } finally {
    for (const row of old)
      await f.owner.query(
        "UPDATE employee_profiles SET start_date=$2 WHERE user_id=$1",
        [row.user_id, row.start_date],
      );
    await f.cleanup();
  }
});
