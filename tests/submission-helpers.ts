import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import { workFixture, sharedTask } from "./work-helpers";
import { taskDetail } from "../src/server/dal/tasks";
import { progress } from "../src/server/services/work";
import {
  createDraft,
  submission,
  submitDraft,
  review,
} from "../src/server/services/submissions";
import type { WorkSession } from "../src/server/dal/work";
export async function submissionFixture() {
  const f = await workFixture();
  const taskId = await sharedTask(f);
  const a = (await taskDetail(f.admin, taskId)).assignments;
  const assignments = Object.fromEntries(a.map((x) => [x.employee_id, x.id]));
  return { ...f, taskId, assignments };
}
export type SF = Awaited<ReturnType<typeof submissionFixture>>;
export async function draft(f: SF, w: WorkSession = f.a) {
  const own = (await taskDetail(w, f.taskId)).assignments[0];
  if (["PENDING", "REVISION_REQUIRED"].includes(own.status))
    await progress(w, f.taskId, {
      expectedVersion: own.version,
      status: "IN_PROGRESS",
    });
  return (
    await createDraft(w, own.id, {
      creationKey: randomUUID(),
      notes: "Fake deliverable notes",
      urls: [{ url: "https://example.invalid/deliverable" }],
    })
  ).id;
}
export async function sent(f: SF, w: WorkSession = f.a) {
  const id = await draft(f, w),
    s = await submission(w, id);
  await submitDraft(w, id, { expectedVersion: s.version });
  return submission(w, id);
}
export async function approved(f: SF, w: WorkSession = f.a) {
  const s = await sent(f, w);
  await review(f.admin, s.id, {
    expectedVersion: s.version,
    decision: "APPROVED",
  });
  return s;
}
export async function image(type: "png" | "jpeg" | "webp" = "png") {
  return sharp({
    create: { width: 32, height: 24, channels: 3, background: "#315e46" },
  })
    [type]()
    .toBuffer();
}
export async function pdf(
  options: {
    active?: boolean;
    pages?: number;
    large?: number;
    embeddedImage?: boolean;
    compressed?: number;
  } = {},
) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < (options.pages ?? 1); i++) doc.addPage([200, 200]);
  if (options.embeddedImage) {
    doc.getPages()[0].drawText("Normal PDF text");
    const picture = await doc.embedJpg(await image("jpeg"));
    doc
      .getPages()[0]
      .drawImage(picture, { x: 10, y: 10, width: 32, height: 24 });
  }
  if (options.active)
    doc.catalog.set(
      PDFName.of("OpenAction"),
      doc.context.obj({ S: "JavaScript", JS: PDFString.of("app.alert(1)") }),
    );
  if (options.large) {
    const stream = doc.context.register(
      doc.context.stream("%" + "a".repeat(options.large) + "\n"),
    );
    doc.getPages()[0].node.set(PDFName.of("Contents"), stream);
  }
  if (options.compressed) {
    const stream = doc.context.register(
      doc.context.flateStream("%" + "a".repeat(options.compressed) + "\n"),
    );
    doc.getPages()[0].node.set(PDFName.of("Contents"), stream);
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
export function uploadRequest(
  bytes: Uint8Array,
  name = "sample.png",
  media = "image/png",
  extra: Record<string, string> = {},
) {
  return new Request("http://127.0.0.1/api/work/upload", {
    method: "POST",
    headers: {
      "content-type": media,
      "x-file-name": encodeURIComponent(name),
      "x-upload-size": String(bytes.length),
      ...extra,
    },
    body: Buffer.from(bytes),
  });
}
