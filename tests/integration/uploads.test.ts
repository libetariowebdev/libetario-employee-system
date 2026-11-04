import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  readFile,
  writeFile,
  chmod,
  link,
  stat,
  lstat,
  mkdir,
  symlink,
  unlink,
  rmdir,
} from "node:fs/promises";
import path from "node:path";
import {
  submissionFixture,
  draft,
  image,
  pdf,
  uploadRequest,
} from "../submission-helpers";
import { runtime } from "../work-helpers";
import { db, authPool, scoped } from "../../src/server/db";
import {
  receiveFile,
  listFiles,
  locate,
  download,
  excludeFile,
  closeFilePool,
} from "../../src/server/files/service";
import {
  submission,
  submitDraft,
  uploadPolicy,
  updateUploadPolicy,
} from "../../src/server/services/submissions";
import { setPolicy } from "../duty-helpers";
import { freeze } from "../duty-helpers";
import { spawn } from "node:child_process";
import { taskDetail } from "../../src/server/dal/tasks";
import { membership } from "../../src/server/services/work";
import { safeFileName } from "../../src/lib/uploads";
import { validateBytes } from "../../src/server/files/validation";
import {
  storagePath,
  storageRoot,
  createQuarantine,
  promote,
  openPrivate,
} from "../../src/server/files/storage";
after(async () => {
  await closeFilePool();
  await db.$disconnect();
  await authPool.end();
});
const reason = "Owner approved upload verification";
async function config(
  f: Awaited<ReturnType<typeof submissionFixture>>,
  patch: Record<string, unknown>,
) {
  const { policyId, ...c } = await uploadPolicy(f.admin);
  await updateUploadPolicy(f.admin, {
    expectedPolicyId: policyId,
    configuration: { ...c, ...patch },
    reason,
  });
}
test("valid PDF/PNG/JPEG/WebP are fully validated, private, immutable, authorized attachments; submission freezes active links", async () => {
  const f = await submissionFixture();
  try {
    const id = await draft(f);
    for (const [name, media, bytes] of [
      ["sample.png", "image/png", await image()],
      ["sample.jpg", "image/jpeg", await image("jpeg")],
      ["sample.webp", "image/webp", await image("webp")],
      ["sample.pdf", "application/pdf", await pdf()],
      ["picture.pdf", "application/pdf", await pdf({ embeddedImage: true })],
    ] as const) {
      const r = await receiveFile(
        f.a,
        "SUBMISSION",
        id,
        uploadRequest(bytes, name, media),
      );
      assert.equal(r.state, "AVAILABLE");
      const response = await download(f.a, r.id, new Request("http://local/"));
      assert.equal(response.headers.get("content-type"), media);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.match(
        response.headers.get("content-disposition")!,
        /^attachment;/,
      );
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      await assert.rejects(
        () => locate(f.b, r.id),
        (e) => (e as any).status === 404,
      );
    }
    const s = await submission(f.a, id);
    await submitDraft(f.a, id, { expectedVersion: s.version });
    const files = await listFiles(f.a, "SUBMISSION", id);
    assert.equal(files.length, 5);
    assert.equal(JSON.stringify(files).includes("storage_key"), false);
    await assert.rejects(() => excludeFile(f.a, files[0].id));
    await assert.rejects(async () =>
      receiveFile(f.a, "SUBMISSION", id, uploadRequest(await image())),
    );
  } finally {
    await f.cleanup();
  }
});
test("common project/task files follow exact assignment scope; peers cannot read submission links or guessed file metadata", async () => {
  const f = await submissionFixture();
  try {
    const p = await receiveFile(
      f.admin,
      "PROJECT",
      f.projectId,
      uploadRequest(await image()),
    );
    const t = await receiveFile(
      f.admin,
      "TASK",
      f.taskId,
      uploadRequest(await image()),
    );
    assert.equal((await listFiles(f.a, "PROJECT", f.projectId)).length, 1);
    assert.ok(await locate(f.b, p.id));
    assert.ok(await locate(f.c, t.id));
    const id = await draft(f),
      s = await receiveFile(
        f.a,
        "SUBMISSION",
        id,
        uploadRequest(await image()),
      );
    await runtime(f.duty.b.token, async (c) => {
      for (const table of ["file_objects", "submission_files"])
        assert.equal(
          (await c.query("SELECT id FROM file_objects WHERE id=$1", [s.id]))
            .rowCount,
          0,
        );
      assert.equal(
        (
          await c.query("SELECT * FROM submission_files WHERE file_id=$1", [
            s.id,
          ])
        ).rowCount,
        0,
      );
    });
    const task = (await taskDetail(f.admin, f.taskId)).task;
    await membership(f.admin, f.taskId, {
      expectedVersion: task.version,
      remove: [f.ids.a],
      add: [],
      reason,
    });
    await assert.rejects(() => locate(f.a, s.id));
    await assert.rejects(() => locate(f.a, t.id));
    await assert.rejects(() => locate(f.a, p.id));
  } finally {
    await f.cleanup();
  }
});
test("wrong MIME/extension, malformed/truncated images and PDFs, active PDFs and appended polyglots never become available", async () => {
  const f = await submissionFixture();
  try {
    const id = await draft(f),
      png = await image();
    const cases: [string, string, Buffer][] = [
      ["sample.jpg", "image/jpeg", png],
      ["sample.png", "image/png", png.subarray(0, png.length - 8)],
      [
        "sample.png",
        "image/png",
        Buffer.concat([png, Buffer.from("<script>")]),
      ],
      ["sample.pdf", "application/pdf", Buffer.from("%PDF-1.7\n%%EOF")],
      ["sample.pdf", "application/pdf", (await pdf()).subarray(0, 70)],
      ["sample.pdf", "application/pdf", await pdf({ active: true })],
      ["sample.jpg", "image/jpeg", (await image("jpeg")).subarray(0, 70)],
      ["sample.webp", "image/webp", (await image("webp")).subarray(0, 20)],
      [
        "sample.pdf",
        "application/pdf",
        await pdf({ compressed: 21 * 1024 * 1024 }),
      ],
    ];
    for (const [name, media, bytes] of cases)
      await assert.rejects(async () =>
        receiveFile(f.a, "SUBMISSION", id, uploadRequest(bytes, name, media)),
      );
    const rows = (
      await f.owner.query(
        "SELECT state FROM file_objects WHERE uploaded_by=$1",
        [f.ids.a],
      )
    ).rows;
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.state === "REJECTED"));
    const bad = await listFiles(f.a, "SUBMISSION", id);
    for (const item of bad) {
      await assert.rejects(() => locate(f.a, item.id));
      await excludeFile(f.a, item.id);
    }
    const good = await receiveFile(f.a, "SUBMISSION", id, uploadRequest(png));
    assert.equal(good.state, "AVAILABLE");
    const s = await submission(f.a, id);
    await submitDraft(f.a, id, { expectedVersion: s.version });
  } finally {
    await f.cleanup();
  }
});
test("path traversal, UNC, NTFS streams, reserved/double-extension/control names rejected before filesystem writes", async () => {
  const f = await submissionFixture();
  try {
    const id = await draft(f),
      bytes = await image();
    for (const name of [
      "../file.png",
      "..\\file.png",
      "\\\\server\\share.png",
      "C:\\file.png",
      "file.png:secret",
      "file.exe.png",
      "file.pdf.png",
      "CON.png",
      "COM1.png",
      "file\r\n.png",
      "file\0.png",
      "file%2f.png",
      "trailing .png",
      "bad?.png",
    ]) {
      assert.throws(() => safeFileName(name, "image/png"));
      await assert.rejects(async () =>
        receiveFile(f.a, "SUBMISSION", id, uploadRequest(bytes, name)),
      );
    }
    assert.equal(
      (
        await f.owner.query(
          "SELECT id FROM file_objects WHERE uploaded_by=$1",
          [f.ids.a],
        )
      ).rowCount,
      0,
    );
  } finally {
    await f.cleanup();
  }
});
test("actual stream sizes, false/missing Content-Length, exact limit and parser dimensions/pages/timeouts fail closed", async () => {
  const f = await submissionFixture();
  try {
    const id = await draft(f),
      bytes = await image();
    const valid = await receiveFile(
      f.a,
      "SUBMISSION",
      id,
      uploadRequest(bytes),
    );
    assert.ok(valid.id);
    await assert.rejects(async () =>
      receiveFile(
        f.a,
        "SUBMISSION",
        id,
        uploadRequest(bytes, "sample.png", "image/png", {
          "content-length": "1",
        }),
      ),
    );
    const request = uploadRequest(Buffer.alloc(10485761));
    await assert.rejects(
      async () => receiveFile(f.a, "SUBMISSION", id, request),
      (e) => (e as any).status === 413,
    );
    const small = uploadRequest(bytes, "sample.png", "image/png", {
      "x-upload-size": String(bytes.length - 1),
    });
    await assert.rejects(
      async () => receiveFile(f.a, "SUBMISSION", id, small),
      (e) => (e as any).status === 413,
    );
    const { policyId, ...policy } = await uploadPolicy(f.a);
    await assert.rejects(async () =>
      validateBytes(bytes, "image/png", { ...policy, maxDimension: 16 }),
    );
    await assert.rejects(() =>
      validateBytes(bytes, "image/png", { ...policy, maxPixels: 100 }),
    );
    await assert.rejects(async () =>
      validateBytes(await pdf({ pages: 2 }), "application/pdf", {
        ...policy,
        maxPdfPages: 1,
      }),
    );
    await assert.rejects(async () =>
      validateBytes(bytes, "image/png", { ...policy, validationTimeoutMs: 1 }),
    );
    await assert.rejects(async () =>
      receiveFile(f.a, "SUBMISSION", id, uploadRequest(Buffer.alloc(0))),
    );
  } finally {
    await f.cleanup();
  }
});
test("runtime cannot forge availability, replace verifier, relink file ownership or access storage keys; auth role denied", async () => {
  const f = await submissionFixture();
  try {
    const id = await draft(f),
      file = await receiveFile(
        f.a,
        "SUBMISSION",
        id,
        uploadRequest(await image()),
      );
    for (const sql of [
      "SELECT storage_key FROM file_objects",
      "UPDATE file_objects SET state='AVAILABLE'",
      "UPDATE company_settings SET upload_validation_key_hash=repeat('0',64)",
      "UPDATE submission_files SET submission_id=gen_random_uuid()",
      "DELETE FROM task_reviews",
    ])
      await runtime(f.admin.token, async (c) => {
        await assert.rejects(() => c.query(sql));
      });
    await runtime(f.duty.a.token, async (c) => {
      await assert.rejects(() =>
        c.query(
          "SELECT private.publish_file($1,10,repeat('0',64),'image/png',repeat('0',64))",
          [file.id],
        ),
      );
    });
    await assert.rejects(() =>
      f.owner.query(
        "INSERT INTO project_files(project_id,file_id,linked_by) VALUES($1,$2,$3)",
        [f.projectId, file.id, f.ids.admin],
      ),
    );
    const row = (
      await f.owner.query("SELECT storage_key FROM file_objects WHERE id=$1", [
        file.id,
      ])
    ).rows[0];
    await assert.rejects(() =>
      f.owner.query(
        "UPDATE file_objects SET storage_key=repeat('0',64) WHERE id=$1",
        [file.id],
      ),
    );
    assert.equal(
      (
        await f.owner.query(
          "SELECT storage_key FROM file_objects WHERE id=$1",
          [file.id],
        )
      ).rows[0].storage_key,
      row.storage_key,
    );
  } finally {
    await f.cleanup();
  }
});
test("per-draft count and daily/project/app byte quotas are versioned, atomic and count rejected/quarantined reservations", async () => {
  const f = await submissionFixture();
  try {
    const id = await draft(f),
      bytes = await image();
    await config(f, {
      maxFilesPerDraft: 1,
      projectBytes: bytes.length * 2,
      dailyBytes: bytes.length * 2,
    });
    await receiveFile(f.a, "SUBMISSION", id, uploadRequest(bytes));
    await assert.rejects(
      async () => receiveFile(f.a, "SUBMISSION", id, uploadRequest(bytes)),
      (e) => (e as any).status === 413,
    );
    const first = (await listFiles(f.a, "SUBMISSION", id))[0];
    await excludeFile(f.a, first.id);
    await receiveFile(f.a, "SUBMISSION", id, uploadRequest(bytes));
    await excludeFile(f.a, (await listFiles(f.a, "SUBMISSION", id))[1].id);
    await assert.rejects(
      async () => receiveFile(f.a, "SUBMISSION", id, uploadRequest(bytes)),
      (e) => (e as any).status === 413,
    );
    await config(f, {
      maxFilesPerDraft: 10,
      projectBytes: 1073741824,
      dailyBytes: 104857600,
      appBytes: 1,
    });
    await assert.rejects(
      async () => receiveFile(f.a, "SUBMISSION", id, uploadRequest(bytes)),
      (e) => (e as any).status === 413,
    );
    assert.equal(
      (
        await f.owner.query(
          "SELECT id FROM file_objects WHERE uploaded_by=$1",
          [f.ids.a],
        )
      ).rowCount,
      2,
    );
  } finally {
    await f.cleanup();
  }
});
test("policy allow-list rejects unsupported types, admin recent MFA required, successful attempts do not clear persistent limits", async () => {
  const f = await submissionFixture();
  try {
    const id = await draft(f);
    await config(f, { allowedTypes: ["application/pdf"], uploadAttempts: 2 });
    await assert.rejects(
      async () =>
        receiveFile(f.a, "SUBMISSION", id, uploadRequest(await image())),
      (e) => (e as any).status === 415,
    );
    await receiveFile(
      f.a,
      "SUBMISSION",
      id,
      uploadRequest(await pdf(), "sample.pdf", "application/pdf"),
    );
    await assert.rejects(
      async () =>
        receiveFile(
          f.a,
          "SUBMISSION",
          id,
          uploadRequest(await pdf(), "sample.pdf", "application/pdf"),
        ),
      (e) => (e as any).status === 429,
    );
    const { policyId, ...policy } = await uploadPolicy(f.admin);
    await assert.rejects(() =>
      updateUploadPolicy(f.a, {
        expectedPolicyId: policyId,
        configuration: policy,
        reason,
      }),
    );
    await assert.rejects(() =>
      updateUploadPolicy(f.admin, {
        expectedPolicyId: policyId,
        configuration: { ...policy, allowedTypes: ["text/html"] },
        reason,
      }),
    );
  } finally {
    await f.cleanup();
  }
});
test("policy/membership change during slow upload cannot publish even if membership is restored; metadata/history retained", async () => {
  const f = await submissionFixture();
  try {
    const id = await draft(f),
      bytes = await image();
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(bytes.subarray(0, 10));
        await gate;
        c.enqueue(bytes.subarray(10));
        c.close();
      },
    });
    const request = new Request("http://local/upload", {
      method: "POST",
      headers: {
        "content-type": "image/png",
        "x-file-name": "sample.png",
        "x-upload-size": String(bytes.length),
      },
      body,
      duplex: "half",
    } as RequestInit);
    const pending = receiveFile(f.a, "SUBMISSION", id, request).then(
      () => null,
      (e) => e,
    );
    for (let i = 0; i < 100; i++) {
      if (
        (
          await f.owner.query(
            "SELECT id FROM file_objects WHERE uploaded_by=$1",
            [f.ids.a],
          )
        ).rowCount
      )
        break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const t = (await taskDetail(f.admin, f.taskId)).task;
    await membership(f.admin, f.taskId, {
      expectedVersion: t.version,
      remove: [f.ids.a],
      add: [],
      reason,
    });
    finish();
    assert.ok(await pending);
    assert.ok(
      (
        await f.owner.query(
          "SELECT state FROM file_objects WHERE uploaded_by=$1",
          [f.ids.a],
        )
      ).rows.every((r) => r.state === "REJECTED"),
    );
  } finally {
    await f.cleanup();
  }
});
test("filesystem collisions, symlink/junction escape, corrupt/missing bytes and HEAD/range requests never bypass authorization", async () => {
  const f = await submissionFixture();
  try {
    const id = await draft(f),
      file = await receiveFile(
        f.a,
        "SUBMISSION",
        id,
        uploadRequest(await image()),
      );
    for (const w of [f.b]) {
      await assert.rejects(
        () =>
          download(
            w,
            file.id,
            new Request("http://local/", { method: "HEAD" }),
          ),
        (e) => (e as any).status === 404,
      );
    }
    await assert.rejects(
      () =>
        download(
          f.a,
          file.id,
          new Request("http://local/", { method: "HEAD" }),
        ),
      (e) => (e as any).status === 405,
    );
    await assert.rejects(
      () =>
        download(
          f.a,
          file.id,
          new Request("http://local/", { headers: { range: "bytes=0-5" } }),
        ),
      (e) => (e as any).status === 416,
    );
    const loc = await locate(f.a, file.id),
      target = await storagePath(loc.storage_key, "objects");
    if (process.platform !== "win32") {
      assert.equal((await stat(target)).mode & 0o777, 0o400);
      const duplicate = target + ".link";
      await link(target, duplicate);
      try {
        await assert.rejects(() =>
          download(f.a, file.id, new Request("http://local/")),
        );
      } finally {
        await unlink(duplicate);
      }
    }
    await chmod(target, 0o600);
    await writeFile(target, Buffer.alloc(Number(loc.size_bytes)));
    await assert.rejects(() =>
      download(f.a, file.id, new Request("http://local/")),
    );
    const key = randomBytes(32).toString("hex"),
      h = await createQuarantine(key);
    await h.close();
    await assert.rejects(() => createQuarantine(key));
    const dest = await storagePath(key, "objects");
    await writeFile(dest, "existing", { flag: "wx" });
    await assert.rejects(() => promote(key));
    assert.equal(await readFile(dest, "utf8"), "existing");
    const original = process.env.PRIVATE_UPLOAD_ROOT,
      base = path.resolve(".local", "safety-" + randomUUID()),
      outside = path.resolve(".local", "outside-" + randomUUID());
    assert.ok(base.startsWith(path.resolve(".local") + path.sep));
    assert.ok(outside.startsWith(path.resolve(".local") + path.sep));
    await mkdir(base);
    await mkdir(outside);
    await symlink(
      outside,
      path.join(base, "quarantine"),
      process.platform === "win32" ? "junction" : "dir",
    );
    try {
      for (const unsafe of [
        "//server/share",
        "\\\\server\\share",
        "C:relative",
      ]) {
        process.env.PRIVATE_UPLOAD_ROOT = unsafe;
        await assert.rejects(() => storageRoot());
      }
      process.env.PRIVATE_UPLOAD_ROOT = base;
      await assert.rejects(() => storageRoot());
    } finally {
      process.env.PRIVATE_UPLOAD_ROOT = original;
      await unlink(path.join(base, "quarantine")).catch(() =>
        rmdir(path.join(base, "quarantine")),
      );
      await rmdir(base);
      await rmdir(outside);
    }
  } finally {
    await f.cleanup();
  }
});
test("operator cleanup removes only old rejected bytes, reconciles interrupted link promotion and retains audit/metadata/available content", async () => {
  const f = await submissionFixture();
  try {
    const id = await draft(f),
      bytes = await image(),
      live = await receiveFile(f.a, "SUBMISSION", id, uploadRequest(bytes));
    await assert.rejects(() =>
      receiveFile(f.a, "SUBMISSION", id, uploadRequest(bytes.subarray(0, 20))),
    );
    const bad = (
      await f.owner.query(
        "SELECT id,storage_key FROM file_objects WHERE uploaded_by=$1 AND state='REJECTED' ORDER BY created_at DESC LIMIT 1",
        [f.ids.a],
      )
    ).rows[0];
    const { link } = await import("node:fs/promises");
    await link(
      await storagePath(bad.storage_key, "quarantine"),
      await storagePath(bad.storage_key, "objects"),
    );
    await freeze(f.owner, new Date(f.now.getTime() + 25 * 3600000));
    const result = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--conditions=react-server",
          "--import",
          "tsx",
          "scripts/cleanup-uploads.ts",
          "--test",
          "--file-id",
          bad.id,
        ],
        { windowsHide: true, stdio: "pipe" },
      );
      child.on("error", reject);
      child.on("close", resolve);
    });
    assert.equal(result, 0);
    const row = (
      await f.owner.query(
        "SELECT state,bytes_deleted_at FROM file_objects WHERE id=$1",
        [bad.id],
      )
    ).rows[0];
    assert.equal(row.state, "REJECTED");
    assert.ok(row.bytes_deleted_at);
    await assert.rejects(async () =>
      lstat(await storagePath(bad.storage_key, "objects")),
    );
    const key = (
      await f.owner.query("SELECT storage_key FROM file_objects WHERE id=$1", [
        live.id,
      ])
    ).rows[0].storage_key;
    assert.ok((await lstat(await storagePath(key, "objects"))).isFile());
    assert.equal(
      (
        await f.owner.query(
          "SELECT id FROM audit_log WHERE action='file.operator_cleanup' AND payload->>'file_id'=$1",
          [bad.id],
        )
      ).rowCount,
      1,
    );
  } finally {
    await f.cleanup();
  }
});
