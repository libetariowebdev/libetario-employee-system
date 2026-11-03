import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { submissionFixture, draft, image, pdf } from "../submission-helpers";
import { runtime, blocked } from "../work-helpers";
import { db, authPool } from "../../src/server/db";
import { closeFilePool, locate } from "../../src/server/files/service";
import { storagePath } from "../../src/server/files/storage";
import { csrfForSession, digest } from "../../src/server/auth/security";
import { taskDetail } from "../../src/server/dal/tasks";
import {
  submission,
  uploadPolicy,
} from "../../src/server/services/submissions";
const origin = process.env.HTTP_TEST_ORIGIN ?? "http://127.0.0.1:3001";
if (!["127.0.0.1", "localhost"].includes(new URL(origin).hostname))
  throw new Error("Local server required");
after(async () => {
  await closeFilePool();
  await db.$disconnect();
  await authPool.end();
});
type F = Awaited<ReturnType<typeof submissionFixture>>;
type Actor = "admin" | "a" | "b" | "c";
const reason = "Owner approved HTTP deliverable verification";
function token(f: F, who: Actor) {
  return who === "admin" ? f.tokens.admin : f.duty[who].token;
}
function cookie(f: F, who: Actor) {
  return `${who === "admin" ? "libetario_session" : "libetario_duty"}=${token(f, who)}`;
}
async function get(
  f: F,
  path: string,
  who: Actor = "a",
  extra: Record<string, string> = {},
) {
  return fetch(origin + "/api/work/" + path, {
    headers: { cookie: cookie(f, who), ...extra },
  });
}
async function send(
  f: F,
  path: string,
  input: unknown,
  who: Actor = "a",
  method = "POST",
) {
  return fetch(origin + "/api/work/" + path, {
    method,
    headers: {
      origin,
      "content-type": "application/json",
      cookie: cookie(f, who),
    },
    body: JSON.stringify({
      ...(input as object),
      csrf: csrfForSession(token(f, who)),
    }),
  });
}
async function ok(r: Response, status = 200) {
  assert.equal(r.status, status, await r.clone().text());
  return r.json();
}
async function upload(
  f: F,
  parent: string,
  bytes: Buffer,
  name = "sample.png",
  media = "image/png",
  who: Actor = "a",
  extra: Record<string, string> = {},
) {
  return fetch(origin + "/api/work/" + parent + "/files", {
    method: "POST",
    headers: {
      origin,
      cookie: cookie(f, who),
      "x-csrf-token": csrfForSession(token(f, who)),
      "content-type": media,
      "x-file-name": encodeURIComponent(name),
      "x-upload-size": String(bytes.length),
      ...extra,
    },
    body: new Uint8Array(bytes),
  });
}
async function policy(f: F, patch: Record<string, unknown>) {
  const { policyId, ...configuration } = await ok(
    await get(f, "upload-policy", "admin"),
  );
  return ok(
    await send(
      f,
      "upload-policy",
      {
        expectedPolicyId: policyId,
        configuration: { ...configuration, ...patch },
        reason,
      },
      "admin",
    ),
  );
}
async function progress(f: F, who: Actor = "a") {
  const own = (await ok(await get(f, "tasks/" + f.taskId, who))).assignments[0];
  await ok(
    await send(
      f,
      "tasks/" + f.taskId + "/progress",
      { expectedVersion: own.version, status: "IN_PROGRESS" },
      who,
    ),
  );
  return own.id;
}
async function newDraft(f: F, who: Actor = "a") {
  const assignment = await progress(f, who);
  return (
    await ok(
      await send(
        f,
        "assignments/" + assignment + "/drafts",
        { creationKey: randomUUID(), notes: "Fake submitted work " + who },
        who,
      ),
      201,
    )
  ).id;
}
async function slowUpload(f: F, id: string, bytes: Buffer, who: Actor = "a") {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const body = new ReadableStream<Uint8Array>({
    async start(c) {
      c.enqueue(bytes.subarray(0, 10));
      await gate;
      c.enqueue(bytes.subarray(10));
      c.close();
    },
  });
  const response = fetch(origin + "/api/work/submissions/" + id + "/files", {
    method: "POST",
    headers: {
      origin,
      cookie: cookie(f, who),
      "x-csrf-token": csrfForSession(token(f, who)),
      "content-type": "image/png",
      "x-file-name": "sample.png",
      "x-upload-size": String(bytes.length),
    },
    body,
    duplex: "half",
  } as RequestInit).then(
    (r) => ({ r, error: null }),
    (error) => ({ r: null, error }),
  );
  return { release, response };
}
async function reserved(f: F, count = 1) {
  for (let i = 0; i < 200; i++) {
    if (
      (
        await f.owner.query(
          "SELECT id FROM file_objects WHERE uploaded_by=$1 AND state='QUARANTINED'",
          [f.ids.a],
        )
      ).rowCount! >= count
    )
      return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Upload reservation was not observed");
}
test("HTTP scenario 4 review portion: three private contributions approve once, own submissions only, project completion and terminal states", async () => {
  const f = await submissionFixture();
  try {
    const ids: Record<string, string> = {};
    for (const who of ["a", "b", "c"] as const) {
      const id = await newDraft(f, who);
      ids[who] = id;
      const s = await ok(await get(f, "submissions/" + id, who));
      await ok(
        await send(
          f,
          "submissions/" + id + "/submit",
          {
            expectedVersion: s.version,
            content: { notes: "Private work for " + who, urls: [] },
          },
          who,
        ),
      );
      const frozen = await ok(await get(f, "submissions/" + id, who));
      await ok(
        await send(
          f,
          "submissions/" + id + "/review",
          {
            expectedVersion: frozen.version,
            decision: "APPROVED",
            reason: "Reviewed exact revision",
          },
          "admin",
        ),
        201,
      );
    }
    assert.equal(
      (await ok(await get(f, "projects/" + f.projectId, "admin")))
        .approved_count,
      1,
    );
    assert.equal(
      (await ok(await get(f, "tasks/" + f.taskId, "admin"))).task.status,
      "APPROVED",
    );
    assert.equal((await get(f, "submissions/" + ids.a, "b")).status, 404);
    await runtime(f.duty.b.token, async (c) =>
      assert.equal(
        (
          await c.query("SELECT * FROM task_reviews WHERE submission_id=$1", [
            ids.a,
          ])
        ).rowCount,
        0,
      ),
    );
    const html = await fetch(origin + "/work/tasks/" + f.taskId, {
      headers: { cookie: cookie(f, "b") },
    });
    const text = await html.text();
    assert.equal(text.includes("Private work for a"), false);
    assert.equal(text.includes("Private work for b"), true);
    const p = await ok(await get(f, "projects/" + f.projectId, "admin"));
    await ok(
      await send(
        f,
        "projects/" + p.id,
        { expectedVersion: p.version, status: "COMPLETED", reason },
        "admin",
        "PATCH",
      ),
    );
    assert.equal(
      (
        await send(
          f,
          "submissions/" + ids.a,
          { expectedVersion: 3, notes: "Overwrite" },
          "a",
          "PATCH",
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await send(f, "assignments/" + f.assignments[f.ids.a] + "/drafts", {
          creationKey: randomUUID(),
        })
      ).status,
      400,
    );
  } finally {
    await f.cleanup();
  }
});
test("HTTP revision reason, resubmission snapshots, stale/current-only and concurrent review decisions; peer history redacted", async () => {
  const f = await submissionFixture();
  try {
    const id = await newDraft(f);
    let s = await ok(await get(f, "submissions/" + id));
    await ok(
      await send(f, "submissions/" + id + "/submit", {
        expectedVersion: s.version,
      }),
    );
    s = await ok(await get(f, "submissions/" + id));
    for (const r of ["", "short", "x".repeat(2001)])
      assert.equal(
        (
          await send(
            f,
            "submissions/" + id + "/review",
            {
              expectedVersion: s.version,
              decision: "REVISION_REQUIRED",
              reason: r,
            },
            "admin",
          )
        ).status,
        400,
      );
    const note = "Private reason visible only to the affected employee";
    await ok(
      await send(
        f,
        "submissions/" + id + "/review",
        {
          expectedVersion: s.version,
          decision: "REVISION_REQUIRED",
          reason: note,
        },
        "admin",
      ),
      201,
    );
    assert.equal(
      (await ok(await get(f, "tasks/" + f.taskId, "b"))).history.some(
        (x: any) => x.reason === note,
      ),
      false,
    );
    const next = await newDraft(f),
      ns = await ok(await get(f, "submissions/" + next));
    assert.equal(ns.revision_number, 2);
    const [resubmitted, staleReview] = await Promise.all([
      send(f, "submissions/" + next + "/submit", {
        expectedVersion: ns.version,
        content: { notes: "Second immutable revision", urls: [] },
      }),
      send(
        f,
        "submissions/" + id + "/review",
        { expectedVersion: s.version, decision: "APPROVED" },
        "admin",
      ),
    ]);
    await ok(resubmitted);
    assert.notEqual(staleReview.status, 201);
    const current = await ok(await get(f, "submissions/" + next));
    const responses = await Promise.all([
      send(
        f,
        "submissions/" + next + "/review",
        { expectedVersion: current.version, decision: "APPROVED" },
        "admin",
      ),
      send(
        f,
        "submissions/" + next + "/review",
        {
          expectedVersion: current.version,
          decision: "REVISION_REQUIRED",
          reason: "A different concurrent decision",
        },
        "admin",
      ),
    ]);
    assert.equal(responses.filter((r) => r.status === 201).length, 1);
    assert.equal((await ok(await get(f, "submissions/" + id))).reason, note);
    await assert.rejects(() =>
      f.owner.query("DELETE FROM task_reviews WHERE submission_id=$1", [id]),
    );
  } finally {
    await f.cleanup();
  }
});
test("HTTP all supported private file types validate and stream original bytes with safe attachment headers; no public URLs/keys", async () => {
  const f = await submissionFixture();
  try {
    const id = await newDraft(f);
    for (const [name, media, bytes] of [
      ["a.png", "image/png", await image()],
      ["a.jpg", "image/jpeg", await image("jpeg")],
      ["a.webp", "image/webp", await image("webp")],
      ["a.pdf", "application/pdf", await pdf()],
    ] as const) {
      const result = await ok(
        await upload(f, "submissions/" + id, bytes, name, media),
        201,
      );
      const r = await get(f, "files/" + result.id);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("content-type"), media);
      assert.equal(r.headers.get("x-content-type-options"), "nosniff");
      assert.match(r.headers.get("content-disposition")!, /^attachment;/);
      assert.match(r.headers.get("cache-control")!, /no-store/);
      assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes);
    }
    const files = await ok(await get(f, "submissions/" + id + "/files"));
    assert.equal(files.length, 4);
    assert.equal(JSON.stringify(files).includes("storage_key"), false);
    assert.equal(
      (await fetch(origin + "/.local/private-uploads-test/objects/guessed.bin"))
        .status,
      404,
    );
  } finally {
    await f.cleanup();
  }
});
test("HTTP upload tampering: wrong MIME/type, spoofed/double extension, malformed/truncated, oversized and false Content-Length", async () => {
  const f = await submissionFixture();
  try {
    const id = await newDraft(f),
      png = await image();
    for (const [name, media, bytes] of [
      ["bad.jpg", "image/jpeg", png],
      ["bad.exe.png", "image/png", png],
      ["bad.svg", "image/svg+xml", Buffer.from("<svg/>")],
      ["bad.png", "image/png", png.subarray(0, 20)],
      ["bad.pdf", "application/pdf", Buffer.from("%PDF-1.7\n%%EOF")],
      ["bad.pdf", "application/pdf", await pdf({ active: true })],
      ["bad.jpg", "image/jpeg", (await image("jpeg")).subarray(0, 70)],
      ["bad.webp", "image/webp", (await image("webp")).subarray(0, 20)],
      [
        "bad.pdf",
        "application/pdf",
        await pdf({ compressed: 21 * 1024 * 1024 }),
      ],
    ] as const)
      assert.ok(
        (await upload(f, "submissions/" + id, bytes, name, media)).status >=
          400,
      );
    assert.equal(
      (await upload(f, "submissions/" + id, Buffer.alloc(10485761))).status,
      413,
    );
    assert.equal(
      (
        await upload(
          f,
          "submissions/" + id,
          png,
          "small.png",
          "image/png",
          "a",
          {
            "x-upload-size": String(png.length + 1),
          },
        )
      ).status,
      400,
    );
    const rows = (
      await f.owner.query(
        "SELECT state FROM file_objects WHERE uploaded_by=$1",
        [f.ids.a],
      )
    ).rows;
    assert.ok(rows.every((x) => x.state === "REJECTED"));
  } finally {
    await f.cleanup();
  }
});
test("HTTP filename traversal/UNC/NTFS/reserved/control names, CSRF/origin tampering and ACCOUNT-only upload denial", async () => {
  const f = await submissionFixture();
  try {
    const id = await newDraft(f),
      bytes = await image();
    for (const name of [
      "../bad.png",
      "..\\bad.png",
      "\\\\server\\bad.png",
      "C:\\bad.png",
      "bad.png:stream",
      "NUL.png",
      "bad\r\n.png",
      "bad%2f.png",
    ])
      assert.equal(
        (await upload(f, "submissions/" + id, bytes, name)).status,
        400,
      );
    assert.equal(
      (
        await upload(
          f,
          "submissions/" + id,
          bytes,
          "bad.png",
          "image/png",
          "a",
          { "x-csrf-token": "forged" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await upload(
          f,
          "submissions/" + id,
          bytes,
          "bad.png",
          "image/png",
          "a",
          { origin: "https://evil.invalid" },
        )
      ).status,
      403,
    );
    const denied = await fetch(
      origin + "/api/work/submissions/" + id + "/files",
      {
        method: "POST",
        headers: {
          origin,
          cookie: "libetario_session=" + f.tokens.a,
          "content-type": "image/png",
          "x-file-name": "bad.png",
          "x-upload-size": String(bytes.length),
        },
        body: bytes,
      },
    );
    assert.equal(denied.status, 401);
  } finally {
    await f.cleanup();
  }
});
test("HTTP file/owner ID guesses, relinking, HEAD/range and conditional requests preserve exact ownership", async () => {
  const f = await submissionFixture();
  try {
    const id = await newDraft(f),
      file = await ok(await upload(f, "submissions/" + id, await image()), 201);
    const hidden = await get(f, "files/" + file.id, "b"),
      missing = await get(f, "files/" + randomUUID(), "b");
    assert.equal(hidden.status, 404);
    assert.deepEqual(await hidden.json(), await missing.json());
    for (const method of ["HEAD"]) {
      const r = await fetch(origin + "/api/work/files/" + file.id, {
        method,
        headers: { cookie: cookie(f, "b") },
      });
      assert.equal(r.status, 404);
      assert.equal(r.headers.has("content-disposition"), false);
      assert.equal(
        (
          await fetch(origin + "/api/work/files/" + file.id, {
            method,
            headers: { cookie: cookie(f, "a") },
          })
        ).status,
        405,
      );
    }
    assert.equal(
      (await get(f, "files/" + file.id, "a", { range: "bytes=0-5" })).status,
      416,
    );
    assert.equal(
      (await get(f, "files/" + file.id, "b", { "if-none-match": "*" })).status,
      404,
    );
    const conditional = await get(f, "files/" + file.id, "a", {
      "if-none-match": "*",
    });
    assert.equal(conditional.status, 200);
    await conditional.arrayBuffer();
    assert.equal(
      (await send(f, "draft-files/" + file.id + "/exclude", {}, "b")).status,
      404,
    );
    await runtime(f.duty.a.token, async (c) => {
      await assert.rejects(() =>
        c.query(
          "UPDATE submission_files SET submission_id=$1 WHERE file_id=$2",
          [randomUUID(), file.id],
        ),
      );
    });
  } finally {
    await f.cleanup();
  }
});
test("HTTP withdraw and restore during an upload never revives its stale draft; recorded data and failed metadata retained", async () => {
  const f = await submissionFixture();
  let slow: Awaited<ReturnType<typeof slowUpload>> | undefined;
  try {
    const id = await newDraft(f);
    slow = await slowUpload(f, id, await image());
    await reserved(f);
    let t = (await ok(await get(f, "tasks/" + f.taskId, "admin"))).task;
    await ok(
      await send(
        f,
        "tasks/" + f.taskId + "/members",
        { expectedVersion: t.version, add: [], remove: [f.ids.a], reason },
        "admin",
      ),
    );
    t = (await ok(await get(f, "tasks/" + f.taskId, "admin"))).task;
    await ok(
      await send(
        f,
        "tasks/" + f.taskId + "/members",
        { expectedVersion: t.version, add: [f.ids.a], remove: [], reason },
        "admin",
      ),
    );
    slow.release();
    const result = await slow.response;
    assert.ok(result.r && result.r.status >= 400);
    assert.equal(
      (
        await f.owner.query(
          "SELECT state FROM file_objects WHERE uploaded_by=$1",
          [f.ids.a],
        )
      ).rows[0].state,
      "REJECTED",
    );
    assert.equal(
      (
        await f.owner.query("SELECT state FROM task_submissions WHERE id=$1", [
          id,
        ])
      ).rows[0].state,
      "ABANDONED",
    );
  } finally {
    slow?.release();
    if (slow) await slow.response;
    await f.cleanup();
  }
});
test("HTTP revoke during upload prevents publication and the next request, retaining the exact duty-bound metadata", async () => {
  const f = await submissionFixture();
  let slow: Awaited<ReturnType<typeof slowUpload>> | undefined;
  try {
    const id = await newDraft(f);
    slow = await slowUpload(f, id, await image());
    await reserved(f);
    const r = await fetch(origin + "/api/admin/duty", {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        cookie: cookie(f, "admin"),
      },
      body: JSON.stringify({
        csrf: csrfForSession(f.tokens.admin),
        employeeIds: [f.ids.a],
        date: f.day,
        action: "REVOKE",
        reason,
      }),
    });
    await ok(r);
    slow.release();
    assert.ok((await slow.response).r!.status >= 400);
    assert.equal((await get(f, "submissions/" + id)).status, 401);
    assert.equal(
      (
        await f.owner.query(
          "SELECT state FROM file_objects WHERE uploaded_by=$1",
          [f.ids.a],
        )
      ).rows[0].state,
      "REJECTED",
    );
  } finally {
    slow?.release();
    if (slow) await slow.response;
    await f.cleanup();
  }
});
test("HTTP at most two synchronous uploads globally, no leases or queue, and quota reservations include in-flight bytes", async () => {
  const f = await submissionFixture();
  const slow: Awaited<ReturnType<typeof slowUpload>>[] = [];
  try {
    const id = await newDraft(f),
      bytes = await image();
    slow.push(await slowUpload(f, id, bytes));
    await reserved(f);
    slow.push(await slowUpload(f, id, bytes));
    await reserved(f, 2);
    assert.equal((await upload(f, "submissions/" + id, bytes)).status, 429);
    slow.forEach((x) => x.release());
    for (const item of slow) await ok((await item.response).r!, 201);
    await policy(f, { dailyBytes: bytes.length * 2 });
    assert.equal((await upload(f, "submissions/" + id, bytes)).status, 413);
  } finally {
    slow.forEach((x) => x.release());
    await Promise.all(slow.map((x) => x.response));
    await f.cleanup();
  }
});
test("HTTP submit while attachment quarantined rolls back content; atomic submit freezes notes/URLs/links and blocks concurrent edits", async () => {
  const f = await submissionFixture();
  let slow: Awaited<ReturnType<typeof slowUpload>> | undefined;
  try {
    const id = await newDraft(f);
    slow = await slowUpload(f, id, await image());
    await reserved(f);
    const before = await ok(await get(f, "submissions/" + id));
    assert.equal(
      (
        await send(f, "submissions/" + id + "/submit", {
          expectedVersion: before.version,
          content: { notes: "Must roll back", urls: [] },
        })
      ).status,
      400,
    );
    assert.equal(
      (await ok(await get(f, "submissions/" + id))).notes,
      before.notes,
    );
    slow.release();
    await ok((await slow.response).r!, 201);
    const s = await ok(await get(f, "submissions/" + id));
    const responses = await Promise.all([
      send(f, "submissions/" + id + "/submit", {
        expectedVersion: s.version,
        content: {
          notes: "Frozen content",
          urls: [{ url: "https://example.invalid/frozen" }],
        },
      }),
      send(
        f,
        "submissions/" + id,
        { expectedVersion: s.version, notes: "Concurrent edit" },
        "a",
        "PATCH",
      ),
    ]);
    assert.equal(responses.filter((r) => r.status === 200).length, 1);
    const final = await ok(await get(f, "submissions/" + id));
    if (final.state === "DRAFT")
      await ok(
        await send(f, "submissions/" + id + "/submit", {
          expectedVersion: final.version,
          content: { notes: "Frozen content", urls: [] },
        }),
      );
    assert.equal(
      (
        await send(
          f,
          "draft-files/" +
            (await ok(await get(f, "submissions/" + id + "/files")))[0].id +
            "/exclude",
          {},
        )
      ).status,
      400,
    );
  } finally {
    slow?.release();
    if (slow) await slow.response;
    await f.cleanup();
  }
});
test("HTTP policy changes during upload, persistent attempt limits and structural timeout/dimension limits fail closed", async () => {
  const f = await submissionFixture();
  let slow: Awaited<ReturnType<typeof slowUpload>> | undefined;
  try {
    const id = await newDraft(f);
    slow = await slowUpload(f, id, await image());
    await reserved(f);
    await policy(f, { allowedTypes: ["application/pdf"] });
    slow.release();
    assert.ok((await slow.response).r!.status >= 400);
    assert.equal(
      (await upload(f, "submissions/" + id, await image())).status,
      415,
    );
    await policy(f, { allowedTypes: ["image/png"], validationTimeoutMs: 1 });
    assert.equal(
      (await upload(f, "submissions/" + id, await image())).status,
      400,
    );
    await policy(f, { validationTimeoutMs: 30000, maxDimension: 16 });
    assert.equal(
      (await upload(f, "submissions/" + id, await image())).status,
      400,
    );
    await policy(f, { maxDimension: 8192, uploadAttempts: 1 });
    assert.equal(
      (await upload(f, "submissions/" + id, await image())).status,
      429,
    );
  } finally {
    slow?.release();
    if (slow) await slow.response;
    await f.cleanup();
  }
});
test("HTTP revoke during authorized streaming aborts remaining bytes; later requests and corrupt-file integrity checks fail", async () => {
  const f = await submissionFixture();
  try {
    const id = await newDraft(f),
      file = await ok(
        await upload(
          f,
          "submissions/" + id,
          await pdf({ large: 8 * 1024 * 1024 }),
          "large.pdf",
          "application/pdf",
        ),
        201,
      );
    const r = await get(f, "files/" + file.id);
    assert.equal(r.status, 200);
    const reader = r.body!.getReader();
    let size = (await reader.read()).value?.length ?? 0;
    const revoke = await fetch(origin + "/api/admin/duty", {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        cookie: cookie(f, "admin"),
      },
      body: JSON.stringify({
        csrf: csrfForSession(f.tokens.admin),
        employeeIds: [f.ids.a],
        date: f.day,
        action: "REVOKE",
        reason,
      }),
    });
    await ok(revoke);
    let failed = false;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
      }
    } catch {
      failed = true;
    }
    assert.ok(failed || size < Number(r.headers.get("content-length")));
    assert.equal((await get(f, "files/" + file.id)).status, 401);
    assert.equal(
      (
        await f.owner.query("SELECT state FROM file_objects WHERE id=$1", [
          file.id,
        ])
      ).rows[0].state,
      "AVAILABLE",
    );
    const b = await newDraft(f, "b"),
      other = await ok(
        await upload(
          f,
          "submissions/" + b,
          await image(),
          "sample.png",
          "image/png",
          "b",
        ),
        201,
      );
    const loc = await locate(f.b, other.id),
      target = await storagePath(loc.storage_key, "objects");
    await chmod(target, 0o600);
    await writeFile(target, Buffer.alloc(Number(loc.size_bytes)));
    assert.equal((await get(f, "files/" + other.id, "b")).status, 503);
  } finally {
    await f.cleanup();
  }
});
for (const change of ["withdrawal", "duty revocation"] as const) {
  test(`HTTP ${change} committed while submission waits rejects freeze and preserves draft content`, async () => {
    const f = await submissionFixture();
    try {
      const id = await newDraft(f);
      await f.owner.query("BEGIN");
      // Revoke blocks lock_work; withdrawal blocks lock_task. Observe real lock waits.
      await f.owner.query(
        change === "withdrawal"
          ? "SELECT id FROM projects WHERE id=$1 FOR UPDATE"
          : "SELECT id FROM users WHERE id=$1 FOR UPDATE",
        [change === "withdrawal" ? f.projectId : f.ids.a],
      );
      const response = send(f, "submissions/" + id + "/submit", {
        expectedVersion: 1,
        content: { notes: "Must roll back together", urls: [] },
      });
      await blocked(f.owner, "private.submit_submission_content");
      if (change === "withdrawal") {
        await f.owner.query(
          "UPDATE task_assignments SET access_revoked_at=private.security_now(),access_revoked_by=$2,revocation_reason=$3,status='CANCELLED',counts_for_completion=false WHERE id=$1",
          [f.assignments[f.ids.a], f.ids.admin, reason],
        );
        await f.owner.query(
          "UPDATE tasks SET status=private.aggregate_task(id) WHERE id=$1",
          [f.taskId],
        );
      } else {
        await f.owner.query("SELECT set_config('app.session_hash',$1,true)", [
          digest(f.tokens.admin),
        ]);
        await f.owner.query(
          "SELECT private.mutate_duty($1::uuid[],$2::date,'REVOKE',$3)",
          [[f.ids.a], f.day, reason],
        );
      }
      await f.owner.query("COMMIT");
      assert.ok([401, 403, 404].includes((await response).status));
      const row = (
        await f.owner.query(
          "SELECT state,notes FROM task_submissions WHERE id=$1",
          [id],
        )
      ).rows[0];
      assert.equal(row.state, "DRAFT");
      assert.notEqual(row.notes, "Must roll back together");
      await runtime(f.duty.a.token, async (c) =>
        assert.equal(
          (await c.query("SELECT id FROM task_submissions WHERE id=$1", [id]))
            .rowCount,
          0,
        ),
      );
    } finally {
      await f.owner.query("ROLLBACK");
      await f.cleanup();
    }
  });
}

test("HTTP withdrawal and restoration cannot revive an open private stream; a fresh authorized download retains historical bytes", async () => {
  const f = await submissionFixture();
  try {
    const id = await newDraft(f),
      file = await ok(
        await upload(
          f,
          "submissions/" + id,
          await pdf({ large: 8 * 1024 * 1024 }),
          "history.pdf",
          "application/pdf",
        ),
        201,
      );
    const response = await get(f, "files/" + file.id),
      reader = response.body!.getReader();
    assert.equal(response.status, 200);
    let size = (await reader.read()).value?.length ?? 0;
    for (const restore of [false, true]) {
      const t = await ok(await get(f, "tasks/" + f.taskId, "admin"));
      await ok(
        await send(
          f,
          "tasks/" + f.taskId + "/members",
          {
            expectedVersion: t.task.version,
            add: restore ? [f.ids.a] : [],
            remove: restore ? [] : [f.ids.a],
            reason,
          },
          "admin",
        ),
      );
      if (!restore)
        assert.equal((await get(f, "files/" + file.id)).status, 404);
    }
    let interrupted = false;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
      }
    } catch {
      interrupted = true;
    }
    assert.ok(
      interrupted || size < Number(response.headers.get("content-length")),
    );
    const fresh = await get(f, "files/" + file.id);
    assert.equal(fresh.status, 200);
    assert.equal(
      (await fresh.arrayBuffer()).byteLength,
      Number(fresh.headers.get("content-length")),
    );
    assert.equal(
      (await ok(await get(f, "submissions/" + id))).state,
      "ABANDONED",
    );
  } finally {
    await f.cleanup();
  }
});

test("HTTP exact 10 MiB valid PDF allowed; an extra byte denied and supported types can be re-enabled by MFA policy", async () => {
  const f = await submissionFixture();
  try {
    const id = await newDraft(f);
    let n = 10485760 - (await pdf({ large: 1 })).length + 1,
      bytes = await pdf({ large: n });
    for (let i = 0; i < 4 && bytes.length !== 10485760; i++) {
      n += 10485760 - bytes.length;
      bytes = await pdf({ large: n });
    }
    assert.equal(bytes.length, 10485760);
    await ok(
      await upload(
        f,
        "submissions/" + id,
        bytes,
        "limit.pdf",
        "application/pdf",
      ),
      201,
    );
    assert.equal(
      (
        await upload(
          f,
          "submissions/" + id,
          Buffer.concat([bytes, Buffer.from("x")]),
          "limit.pdf",
          "application/pdf",
        )
      ).status,
      413,
    );
    await policy(f, { allowedTypes: ["application/pdf", "image/png"] });
    await ok(await upload(f, "submissions/" + id, await image()), 201);
  } finally {
    await f.cleanup();
  }
});
