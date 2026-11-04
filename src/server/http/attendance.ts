import { ZodError } from "zod";
import { cookie, assertCsrf, HttpError } from "../auth/security";
import { workSession } from "../dal/work";
import * as a from "../services/attendance";
export async function attendanceApi(request: Request, path: string[]) {
  const json = (data: unknown, status = 200) =>
    Response.json(data, {
      status,
      headers: {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  try {
    const w = await workSession(
      cookie(request, "libetario_session"),
      cookie(request, "libetario_duty"),
    );
    const method = request.method,
      key = path.slice(1).join("/"),
      url = new URL(request.url),
      filters = Object.fromEntries(url.searchParams);
    let b: Record<string, unknown> = {};
    if (method !== "GET") {
      if (method !== "POST") throw new HttpError(405, "Method not supported");
      if (
        request.headers
          .get("content-type")
          ?.split(";")[0]
          .trim()
          .toLowerCase() !== "application/json"
      )
        throw new HttpError(415, "Use application/json");
      const reader = request.body?.getReader();
      if (!reader) throw new HttpError(400, "Invalid request");
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 131072) {
            await reader.cancel();
            throw new HttpError(413, "Request too large");
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      try {
        b = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new HttpError(400, "Invalid JSON");
      }
      if (!b || typeof b !== "object" || Array.isArray(b))
        throw new HttpError(400, "Invalid request");
      assertCsrf(request, b.csrf, w.token);
      delete b.csrf;
    }
    if (method === "GET") {
      if (!key) return json(await a.listAttendance(w, filters));
      if (key === "current") return json(await a.currentAttendance(w));
      if (key === "corrections")
        return json(await a.attendanceCorrections(w, filters));
      if (key === "policy") return json(await a.attendancePolicy(w));
      if (key === "duties")
        return json(
          await a.attendanceDuties(w, filters.date, filters.employeeId),
        );
      if (path.length === 3 && path[1] === "shifts")
        return json(await a.attendanceDetail(w, path[2]));
    } else {
      if (key === "clock-in")
        return json(
          { id: await a.attendanceCommand(w, "CLOCK_IN", null, b) },
          201,
        );
      if (key === "reconcile")
        return json({ updated: await a.reconcileAttendance(w) });
      if (key === "policy") return json(await a.updateAttendancePolicy(w, b));
      if (key === "bulk-preview")
        return json(await a.bulkAttendancePreview(w, b.filters));
      if (key === "bulk-approve")
        return json(await a.bulkApproveAttendance(w, b));
      if (key === "corrections")
        return json({ id: await a.requestAttendanceCorrection(w, b) }, 201);
      if (path.length === 4 && path[1] === "shifts") {
        if (path[3] === "clock-out")
          return json({
            id: await a.attendanceCommand(w, "CLOCK_OUT", path[2], b),
          });
        if (path[3] === "breaks")
          return json(
            { id: await a.attendanceCommand(w, "BREAK_START", path[2], b) },
            201,
          );
        if (path[3] === "review")
          return json({ id: await a.reviewAttendance(w, path[2], b) });
      }
      if (path.length === 4 && path[1] === "breaks" && path[3] === "end")
        return json({
          id: await a.attendanceCommand(w, "BREAK_END", path[2], b),
        });
      if (
        path.length === 4 &&
        path[1] === "corrections" &&
        path[3] === "review"
      )
        return json({ id: await a.decideAttendanceCorrection(w, path[2], b) });
    }
    throw new HttpError(404, "Not found");
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    if (e instanceof ZodError)
      return json({ error: e.issues.map((v) => v.message).join("; ") }, 400);
    console.error(
      "Attendance request failed",
      (e as { code?: string }).code ?? "INTERNAL",
    );
    return json({ error: "Attendance request could not be completed" }, 500);
  }
}
