import "server-only";
import { ZodError, z } from "zod";
import { workSession, workError } from "../dal/work";
import { assertCsrf, cookie, HttpError } from "../auth/security";
import {
  download,
  listFiles,
  receiveFile,
  type OwnerKind,
} from "../files/service";
export async function fileApi(request: Request, path: string[]) {
  try {
    const w = await workSession(
      cookie(request, "libetario_session"),
      cookie(request, "libetario_duty"),
    );
    if (path[1] === "files" && path.length === 3) {
      const id = z.uuid().parse(path[2]);
      if (!["GET", "HEAD"].includes(request.method))
        throw new HttpError(405, "Method not allowed");
      return await download(w, id, request);
    }
    const kinds: Record<string, OwnerKind> = {
      projects: "PROJECT",
      tasks: "TASK",
      submissions: "SUBMISSION",
    };
    const kind = kinds[path[1]],
      id = z.uuid().parse(path[2]);
    if (!kind || path.length !== 4 || path[3] !== "files")
      throw new HttpError(404, "Not found");
    if (request.method === "GET")
      return Response.json(await listFiles(w, kind, id), {
        headers: { "Cache-Control": "private, no-store" },
      });
    if (request.method !== "POST")
      throw new HttpError(405, "Method not allowed");
    assertCsrf(request, request.headers.get("x-csrf-token"), w.token);
    return Response.json(await receiveFile(w, kind, id, request), {
      status: 201,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (e) {
    let error = e;
    try {
      workError(e);
    } catch (mapped) {
      error = mapped;
    }
    const status =
      error instanceof HttpError
        ? error.status
        : error instanceof ZodError
          ? 400
          : 503;
    return Response.json(
      {
        error:
          error instanceof HttpError
            ? error.message
            : error instanceof ZodError
              ? "Invalid file request"
              : "Private file service unavailable",
      },
      {
        status,
        headers: {
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  }
}
