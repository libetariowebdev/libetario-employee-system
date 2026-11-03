import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  submissionFixture,
  draft,
  sent,
  approved,
} from "../submission-helpers";
import { runtime, blocked } from "../work-helpers";
import { db, authPool } from "../../src/server/db";
import { closeFilePool } from "../../src/server/files/service";
import {
  createDraft,
  editDraft,
  submitDraft,
  review,
  submissions,
  submission,
  reviewQueue,
} from "../../src/server/services/submissions";
import { taskDetail, projectDetail } from "../../src/server/dal/tasks";
import {
  progress,
  editProject,
  membership,
  editTask,
} from "../../src/server/services/work";
after(async () => {
  await closeFilePool();
  await db.$disconnect();
  await authPool.end();
});
const reason = "Owner approved lifecycle verification";
test("15.4: three own private submissions/reviews, one shared approved task and nonempty completed project", async () => {
  const f = await submissionFixture();
  try {
    const a = await approved(f, f.a);
    assert.equal(
      (await taskDetail(f.admin, f.taskId)).task.status,
      "IN_PROGRESS",
    );
    assert.equal((await submissions(f.b, f.taskId)).length, 0);
    await assert.rejects(
      () => submission(f.b, a.id),
      (e) => (e as any).status === 404,
    );
    await approved(f, f.b);
    assert.equal((await projectDetail(f.admin, f.projectId)).approved_count, 0);
    await approved(f, f.c);
    const p = await projectDetail(f.admin, f.projectId);
    assert.equal(p.task_count, 1);
    assert.equal(p.approved_count, 1);
    assert.equal((await taskDetail(f.admin, f.taskId)).task.status, "APPROVED");
    await editProject(f.admin, p.id, {
      expectedVersion: p.version,
      status: "COMPLETED",
      reason,
    });
    assert.equal((await projectDetail(f.admin, p.id)).status, "COMPLETED");
    await runtime(f.duty.b.token, async (c) => {
      assert.equal(
        (await c.query("SELECT * FROM task_submissions WHERE id=$1", [a.id]))
          .rowCount,
        0,
      );
      assert.equal(
        (
          await c.query("SELECT * FROM task_reviews WHERE submission_id=$1", [
            a.id,
          ])
        ).rowCount,
        0,
      );
    });
  } finally {
    await f.cleanup();
  }
});
test("revision reason, immutable snapshots, new revision, current-only review and peer reason privacy", async () => {
  const f = await submissionFixture();
  try {
    const first = await sent(f);
    for (const note of ["", "short", "x".repeat(2001)])
      await assert.rejects(() =>
        review(f.admin, first.id, {
          expectedVersion: first.version,
          decision: "REVISION_REQUIRED",
          reason: note,
        }),
      );
    const privateReason = "Private revision reason for employee A only";
    await review(f.admin, first.id, {
      expectedVersion: first.version,
      decision: "REVISION_REQUIRED",
      reason: privateReason,
    });
    assert.equal(
      (await taskDetail(f.b, f.taskId)).history.some(
        (x) => x.reason === privateReason,
      ),
      false,
    );
    await assert.rejects(() =>
      editDraft(f.a, first.id, {
        expectedVersion: first.version,
        notes: "Overwrite reviewed work",
      }),
    );
    // A requested revision may be resubmitted directly without a cosmetic
    // IN_PROGRESS step; the explicit Start revision route is covered via HTTP.
    const id = (
        await createDraft(f.a, first.assignment_id, {
          creationKey: randomUUID(),
          notes: "Revised content",
        })
      ).id,
      next = await submission(f.a, id);
    assert.equal(next.revision_number, 2);
    assert.equal(next.state, "DRAFT");
    await editDraft(f.a, id, {
      expectedVersion: next.version,
      notes: "Revised content",
      urls: [],
    });
    const current = await submission(f.a, id);
    await submitDraft(f.a, id, { expectedVersion: current.version });
    await assert.rejects(() =>
      review(f.admin, first.id, {
        expectedVersion: first.version,
        decision: "APPROVED",
      }),
    );
    const frozen = await submission(f.a, id);
    await review(f.admin, id, {
      expectedVersion: frozen.version,
      decision: "APPROVED",
    });
    assert.equal((await submission(f.a, first.id)).notes, first.notes);
    assert.equal((await submission(f.a, first.id)).reason, privateReason);
    await assert.rejects(() =>
      f.owner.query(
        "UPDATE task_reviews SET reason='tamper' WHERE submission_id=$1",
        [first.id],
      ),
    );
    await assert.rejects(() =>
      f.owner.query("UPDATE task_submissions SET notes='tamper' WHERE id=$1", [
        id,
      ]),
    );
  } finally {
    await f.cleanup();
  }
});
test("all forbidden skips and missing proofs rejected by service AND database; terminal approval survives access withdrawal", async () => {
  const f = await submissionFixture();
  try {
    await assert.rejects(() =>
      createDraft(f.a, f.assignments[f.ids.a], { creationKey: randomUUID() }),
    );
    await runtime(f.duty.a.token, async (c) => {
      await assert.rejects(() =>
        c.query("SELECT private.task_progress($1,1,'APPROVED',NULL)", [
          f.taskId,
        ]),
      );
    });
    const a = await approved(f);
    let detail = await taskDetail(f.admin, f.taskId);
    await assert.rejects(() =>
      createDraft(f.a, f.assignments[f.ids.a], { creationKey: randomUUID() }),
    );
    await membership(f.admin, f.taskId, {
      expectedVersion: detail.task.version,
      remove: [f.ids.a],
      add: [],
      reason,
    });
    await assert.rejects(() => submission(f.a, a.id));
    assert.equal(
      (
        await f.owner.query(
          "SELECT status,counts_for_completion FROM task_assignments WHERE id=$1",
          [a.assignment_id],
        )
      ).rows[0].status,
      "APPROVED",
    );
    await approved(f, f.b);
    await approved(f, f.c);
    detail = await taskDetail(f.admin, f.taskId);
    assert.equal(detail.task.status, "APPROVED");
    await assert.rejects(() =>
      progress(f.admin, f.taskId, {
        expectedVersion: detail.task.version,
        status: "CANCELLED",
        reason,
      }),
    );
    await assert.rejects(() =>
      editTask(f.admin, f.taskId, {
        expectedVersion: detail.task.version,
        title: "Rewritten after approval",
        reason,
      }),
    );
    await membership(f.admin, f.taskId, {
      expectedVersion: detail.task.version,
      remove: [],
      add: [f.ids.a],
      reason,
    });
    assert.equal((await submission(f.a, a.id)).decision, "APPROVED");
  } finally {
    await f.cleanup();
  }
});
test("draft single-flight, idempotent creation, empty submission denial, optimistic edit and submit races", async () => {
  const f = await submissionFixture();
  try {
    const own = (await taskDetail(f.a, f.taskId)).assignments[0];
    await progress(f.a, f.taskId, {
      expectedVersion: own.version,
      status: "IN_PROGRESS",
    });
    const input = { creationKey: randomUUID() },
      id = (await createDraft(f.a, own.id, input)).id;
    assert.equal((await createDraft(f.a, own.id, input)).id, id);
    await assert.rejects(() =>
      createDraft(f.a, own.id, { creationKey: randomUUID() }),
    );
    await assert.rejects(() => submitDraft(f.a, id, { expectedVersion: 1 }));
    const edits = await Promise.allSettled([
      editDraft(f.a, id, { expectedVersion: 1, notes: "one" }),
      editDraft(f.a, id, { expectedVersion: 1, notes: "two" }),
    ]);
    assert.equal(edits.filter((r) => r.status === "fulfilled").length, 1);
    const s = await submission(f.a, id);
    const attempts = await Promise.allSettled([
      submitDraft(f.a, id, { expectedVersion: s.version }),
      submitDraft(f.a, id, { expectedVersion: s.version }),
    ]);
    assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(
      (
        await f.owner.query(
          "SELECT id FROM task_submissions WHERE assignment_id=$1",
          [own.id],
        )
      ).rowCount,
      1,
    );
  } finally {
    await f.cleanup();
  }
});
test("concurrent different reviews record one decision, stale/non-current versions denied; latest queue contains no drafts", async () => {
  const f = await submissionFixture();
  try {
    await draft(f, f.b);
    const s = await sent(f);
    const queue = await reviewQueue(f.admin);
    assert.equal(
      queue.some((q) => q.id === s.id),
      true,
    );
    assert.equal(
      queue.some((q) => q.state === "DRAFT"),
      false,
    );
    await assert.rejects(() =>
      review(f.admin, s.id, {
        expectedVersion: s.version - 1,
        decision: "APPROVED",
      }),
    );
    const r = await Promise.allSettled([
      review(f.admin, s.id, {
        expectedVersion: s.version,
        decision: "APPROVED",
      }),
      review(f.admin, s.id, {
        expectedVersion: s.version,
        decision: "REVISION_REQUIRED",
        reason: "Different concurrent review",
      }),
    ]);
    assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(
      (
        await f.owner.query(
          "SELECT id FROM task_reviews WHERE submission_id=$1",
          [s.id],
        )
      ).rowCount,
      1,
    );
    await assert.rejects(() => reviewQueue(f.a));
  } finally {
    await f.cleanup();
  }
});
test("withdrawal/restore cancels unfinished work, abandons draft, retains submitted content and approved decisions", async () => {
  const f = await submissionFixture();
  try {
    const id = await draft(f);
    let t = (await taskDetail(f.admin, f.taskId)).task;
    await membership(f.admin, f.taskId, {
      expectedVersion: t.version,
      remove: [f.ids.a],
      add: [],
      reason,
    });
    assert.equal(
      (
        await f.owner.query("SELECT state FROM task_submissions WHERE id=$1", [
          id,
        ])
      ).rows[0].state,
      "ABANDONED",
    );
    t = (await taskDetail(f.admin, f.taskId)).task;
    await membership(f.admin, f.taskId, {
      expectedVersion: t.version,
      remove: [],
      add: [f.ids.a],
      reason,
    });
    const next = await sent(f);
    assert.equal(next.revision_number, 2);
    const b = await sent(f, f.b);
    await review(f.admin, b.id, {
      expectedVersion: b.version,
      decision: "REVISION_REQUIRED",
      reason: "Revision cancelled by the owner",
    });
    t = (await taskDetail(f.admin, f.taskId)).task;
    await progress(f.admin, f.taskId, {
      expectedVersion: t.version,
      status: "CANCELLED",
      reason,
    });
    assert.equal((await submission(f.a, next.id)).state, "SUBMITTED");
    await assert.rejects(() =>
      review(f.admin, next.id, {
        expectedVersion: next.version,
        decision: "APPROVED",
      }),
    );
  } finally {
    await f.cleanup();
  }
});
test("review waiting behind membership withdrawal cannot approve excluded work; submitted history retained", async () => {
  const f = await submissionFixture();
  try {
    const s = await sent(f);
    await f.owner.query("BEGIN");
    await f.owner.query("SELECT id FROM projects WHERE id=$1 FOR UPDATE", [
      f.projectId,
    ]);
    const pending = review(f.admin, s.id, {
      expectedVersion: s.version,
      decision: "APPROVED",
    }).then(
      () => null,
      (e) => e,
    );
    await blocked(f.owner, "private.review_submission");
    await f.owner.query(
      "UPDATE task_assignments SET access_revoked_at=private.security_now(),access_revoked_by=$2,revocation_reason=$3,status='CANCELLED',counts_for_completion=false WHERE id=$1",
      [s.assignment_id, f.ids.admin, reason],
    );
    await f.owner.query(
      "UPDATE tasks SET status=private.aggregate_task(id) WHERE id=$1",
      [f.taskId],
    );
    await f.owner.query("COMMIT");
    assert.ok(await pending);
    assert.equal(
      (
        await f.owner.query(
          "SELECT id FROM task_reviews WHERE submission_id=$1",
          [s.id],
        )
      ).rowCount,
      0,
    );
    assert.equal((await submission(f.admin, s.id)).state, "SUBMITTED");
  } finally {
    await f.owner.query("ROLLBACK");
    await f.cleanup();
  }
});

test("submit waiting behind a committed withdrawal cannot freeze a stale draft; history retained", async () => {
  const f = await submissionFixture();
  try {
    const id = await draft(f);
    await f.owner.query("BEGIN");
    await f.owner.query("SELECT id FROM projects WHERE id=$1 FOR UPDATE", [
      f.projectId,
    ]);
    const pending = submitDraft(f.a, id, { expectedVersion: 1 }).then(
      () => null,
      (e) => e,
    );
    await blocked(f.owner, "private.submit_submission");
    await f.owner.query(
      "UPDATE task_assignments SET access_revoked_at=private.security_now(),access_revoked_by=$2,revocation_reason=$3,status='CANCELLED',counts_for_completion=false WHERE id=$1",
      [f.assignments[f.ids.a], f.ids.admin, reason],
    );
    await f.owner.query(
      "UPDATE tasks SET status=private.aggregate_task(id) WHERE id=$1",
      [f.taskId],
    );
    await f.owner.query("COMMIT");
    assert.equal((await pending).status, 404);
    assert.equal(
      (
        await f.owner.query("SELECT state FROM task_submissions WHERE id=$1", [
          id,
        ])
      ).rows[0].state,
      "DRAFT",
    );
  } finally {
    await f.owner.query("ROLLBACK");
    await f.cleanup();
  }
});
