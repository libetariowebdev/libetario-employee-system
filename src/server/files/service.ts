import "server-only";
import pg from "pg";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { safeFileName } from "../../lib/uploads";
import { workScoped, type WorkSession } from "../dal/work";
import { scoped } from "../db";
import { HttpError } from "../auth/security";
import { uploadPolicy } from "../services/submissions";
import { createQuarantine, openPrivate, promote } from "./storage";
import { validateBytes } from "./validation";
const globalFiles = globalThis as unknown as { filePool?: pg.Pool };
const filePool = (globalFiles.filePool ??= new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
  options: "-c timezone=UTC",
}));
export const closeFilePool = () => filePool.end();
export function validationKey() {
  const key = process.env.UPLOAD_VALIDATION_KEY;
  if (!key || !/^[a-f0-9]{64}$/.test(key))
    throw new HttpError(503, "Upload validation is not configured");
  return key;
}
export type OwnerKind = "PROJECT" | "TASK" | "SUBMISSION";
export type FileMetadata = {
  id: string;
  display_name: string;
  declared_media_type: string;
  detected_media_type: string | null;
  size_bytes: bigint | null;
  state: string;
  created_at: Date;
  excluded_at?: Date | null;
};
export async function fileLimit(w: WorkSession, kind: "UPLOAD" | "DOWNLOAD") {
  const allowed = await workScoped(
    w,
    async (tx) =>
      (
        await tx.$queryRaw<
          { allowed: boolean }[]
        >`SELECT private.file_request_limit(${kind}) AS allowed`
      )[0].allowed,
  );
  if (!allowed)
    throw new HttpError(429, "File request limit reached; try later");
}
async function slot() {
  const c = await filePool.connect();
  let acquired: number | undefined;
  try {
    for (const index of [0, 1]) {
      if (
        (
          await c.query("SELECT pg_try_advisory_lock(72426823,$1) AS ok", [
            index,
          ])
        ).rows[0].ok
      ) {
        acquired = index;
        break;
      }
    }
    if (acquired === undefined)
      throw new HttpError(
        429,
        "Two uploads are already being validated; try later",
      );
    return async () => {
      try {
        await c.query("SELECT pg_advisory_unlock(72426823,$1)", [acquired]);
      } finally {
        c.release();
      }
    };
  } catch (e) {
    c.release();
    throw e;
  }
}
export async function listFiles(w: WorkSession, kind: OwnerKind, id: string) {
  z.uuid().parse(id);
  return workScoped(w, async (tx) => {
    const check =
      kind === "PROJECT"
        ? await tx.$queryRaw<
            { id: string }[]
          >`SELECT id FROM projects WHERE id=${id}::uuid`
        : kind === "TASK"
          ? await tx.$queryRaw<
              { id: string }[]
            >`SELECT id FROM tasks WHERE id=${id}::uuid`
          : await tx.$queryRaw<
              { id: string }[]
            >`SELECT id FROM task_submissions WHERE id=${id}::uuid`;
    if (!check[0]) throw new HttpError(404, "Not found");
    const rows =
      kind === "PROJECT"
        ? await tx.$queryRaw<
            FileMetadata[]
          >`SELECT f.id,f.display_name,f.declared_media_type,f.detected_media_type,f.size_bytes,f.state,f.created_at FROM file_objects f JOIN project_files x ON x.file_id=f.id WHERE x.project_id=${id}::uuid ORDER BY f.created_at,f.id`
        : kind === "TASK"
          ? await tx.$queryRaw<
              FileMetadata[]
            >`SELECT f.id,f.display_name,f.declared_media_type,f.detected_media_type,f.size_bytes,f.state,f.created_at FROM file_objects f JOIN task_files x ON x.file_id=f.id WHERE x.task_id=${id}::uuid ORDER BY f.created_at,f.id`
          : await tx.$queryRaw<
              FileMetadata[]
            >`SELECT f.id,f.display_name,f.declared_media_type,f.detected_media_type,f.size_bytes,f.state,f.created_at,x.excluded_at FROM file_objects f JOIN submission_files x ON x.file_id=f.id WHERE x.submission_id=${id}::uuid ORDER BY f.created_at,f.id`;
    return rows.map((row) => ({
      ...row,
      size_bytes: row.size_bytes === null ? null : Number(row.size_bytes),
    }));
  });
}
export async function excludeFile(w: WorkSession, id: string) {
  z.uuid().parse(id);
  return workScoped(w, async (tx) => {
    await tx.$queryRaw`SELECT private.exclude_draft_file(${id}::uuid)::text`;
    return { ok: true };
  });
}
export async function receiveFile(
  w: WorkSession,
  kind: OwnerKind,
  parent: string,
  request: Request,
) {
  z.uuid().parse(parent);
  const proof = validationKey();
  await fileLimit(w, "UPLOAD");
  const release = await slot();
  let id: string | undefined;
  try {
    const policy = await uploadPolicy(w),
      media = request.headers.get("content-type")?.toLowerCase() ?? "";
    let name;
    try {
      name = safeFileName(
        decodeURIComponent(request.headers.get("x-file-name") ?? ""),
        media,
      );
    } catch {
      throw new HttpError(400, "Unsafe filename or mismatched media type");
    }
    const size = Number(request.headers.get("x-upload-size"));
    if (!Number.isSafeInteger(size) || size < 1 || size > policy.maxFileBytes)
      throw new HttpError(413, "File exceeds the configured size limit");
    if (!policy.allowedTypes.includes(media as any))
      throw new HttpError(415, "File type is not allowed");
    const declared = request.headers.get("content-length");
    if (declared !== null && Number(declared) !== size)
      throw new HttpError(400, "Declared upload length does not match");
    const key = randomBytes(32).toString("hex");
    const row = await workScoped(
      w,
      async (tx) =>
        (
          await tx.$queryRaw<
            { id: string }[]
          >`SELECT private.reserve_file(${kind},${parent}::uuid,${JSON.stringify({ storageKey: key, name, media, size })}::jsonb) AS id`
        )[0],
    );
    id = row.id;
    const h = await createQuarantine(key),
      reader = request.body?.getReader();
    let bytes = 0;
    const hash = createHash("sha256");
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void reader?.cancel("Upload timeout").catch(() => {});
    }, 30000);
    try {
      if (!reader) throw new HttpError(400, "Empty upload");
      while (true) {
        if (request.signal.aborted)
          throw new HttpError(400, "Upload interrupted");
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > size || bytes > policy.maxFileBytes) {
          await reader.cancel();
          throw new HttpError(413, "File exceeds the reserved size");
        }
        let written = 0;
        while (written < part.value.byteLength) {
          const result = await h.write(
            part.value,
            written,
            part.value.byteLength - written,
          );
          if (!result.bytesWritten) throw new Error("Incomplete disk write");
          written += result.bytesWritten;
        }
        hash.update(part.value);
      }
      if (timedOut || bytes !== size)
        throw new HttpError(400, "Incomplete upload");
      await h.sync();
    } finally {
      clearTimeout(timer);
      reader?.releaseLock();
      await h.close();
    }
    const input = await openPrivate(key, "quarantine");
    let body: Buffer;
    try {
      body = await input.readFile();
    } finally {
      await input.close();
    }
    await validateBytes(body, media, policy, request.signal).catch(() => {
      throw new HttpError(400, "File content validation failed");
    });
    await promote(key);
    await workScoped(w, async (tx) => {
      await tx.$queryRaw`SELECT private.publish_file(${id}::uuid,${bytes}::bigint,${hash.digest("hex")},${media},${proof})::text`;
    });
    return { id, state: "AVAILABLE" };
  } catch (e) {
    if (id) {
      try {
        await scoped(w.hash, async (tx) => {
          await tx.$queryRaw`SELECT private.reject_file(${id}::uuid,${proof})::text`;
        });
      } catch {
        /* fail closed: a quarantined row remains non-downloadable for operator cleanup */
      }
    }
    throw e;
  } finally {
    await release();
  }
}
type Locator = {
  storage_key: string;
  display_name: string;
  media_type: string;
  size_bytes: bigint;
  sha256: string;
  authorization_stamp: string;
};
export async function locate(w: WorkSession, id: string) {
  z.uuid().parse(id);
  return workScoped(
    w,
    async (tx) =>
      (
        await tx.$queryRaw<
          Locator[]
        >`SELECT * FROM private.file_locator(${id}::uuid)`
      )[0],
  );
}
export async function download(w: WorkSession, id: string, request: Request) {
  await fileLimit(w, "DOWNLOAD");
  const f = await locate(w, id);
  if (request.method === "HEAD")
    throw new HttpError(405, "HEAD downloads are not supported");
  if (request.headers.has("range"))
    throw new HttpError(416, "Range downloads are not supported");
  const h = await openPrivate(f.storage_key);
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await h.close();
    }
  };
  try {
    const stat = await h.stat();
    if (stat.size !== Number(f.size_bytes))
      throw new HttpError(503, "Stored file integrity check failed");
    const verify = createHash("sha256");
    let offset = 0;
    while (offset < stat.size) {
      const buf = Buffer.alloc(Math.min(65536, stat.size - offset)),
        part = await h.read(buf, 0, buf.length, offset);
      if (!part.bytesRead) throw new Error("Incomplete file");
      verify.update(buf.subarray(0, part.bytesRead));
      offset += part.bytesRead;
    }
    if (verify.digest("hex") !== f.sha256)
      throw new HttpError(503, "Stored file integrity check failed");
    const checkAccess = async () => {
      if ((await locate(w, id)).authorization_stamp !== f.authorization_stamp)
        throw new HttpError(403, "Download authorization changed");
    };
    await checkAccess();
    let position = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (request.signal.aborted) {
            await close();
            controller.error(new Error("Download interrupted"));
            return;
          }
          await checkAccess();
          const buf = Buffer.alloc(
            Math.min(65536, Number(f.size_bytes) - position),
          );
          if (!buf.length) {
            await close();
            controller.close();
            return;
          }
          const { bytesRead } = await h.read(buf, 0, buf.length, position);
          if (!bytesRead) throw new Error("Incomplete file");
          position += bytesRead;
          controller.enqueue(buf.subarray(0, bytesRead));
        } catch {
          await close();
          controller.error(
            new Error("Download authorization or integrity changed"),
          );
        }
      },
      async cancel() {
        await close();
      },
    });
    const fallback = f.display_name.replace(/[^A-Za-z0-9._ -]/g, "_");
    return new Response(stream, {
      headers: {
        "Content-Type": f.media_type,
        "Content-Length": String(f.size_bytes),
        "Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(f.display_name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Accept-Ranges": "none",
      },
    });
  } catch (e) {
    await close();
    throw e;
  }
}
