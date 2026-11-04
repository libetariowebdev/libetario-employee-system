import { workSession } from "../dal/work";
import { assertCsrf, cookie, HttpError } from "../auth/security";
import * as time from "../services/work-time";

export async function timeApi(
  request: Request,
  path: string[],
  body: Record<string, unknown>,
) {
  const method = request.method;
  const key = path.slice(1).join("/");
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const w = await workSession(
    cookie(request, "libetario_session"),
    cookie(request, "libetario_duty"),
    false,
    method !== "GET",
  );
  const json = (data: unknown) =>
    Response.json(data, {
      headers: {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  if (method === "GET") {
    if (key === "ledger")
      return json(
        await time.ledger(w, params.employeeId, params.skip, params.segmentId),
      );
    if (key === "live") return json(await time.live(w, params.skip));
    if (key === "report") return json(await time.report(w, params));
    if (key === "export.csv") return time.reportCsv(w, params);
    if (key === "daily")
      return json(await time.readDaily(w, params.date, params.employeeId));
    if (key === "daily-catalog")
      return json(await time.dailyCatalog(w, params.date, params.skip));
  } else if (method === "POST") {
    assertCsrf(request, body.csrf, w.token);
    if (key === "timer") return json({ id: await time.timer(w, body) });
    if (key === "settings") return json(await time.changeTimeSettings(w, body));
    if (path.length === 3 && path[1] === "segments")
      return json({ id: await time.correctSegment(w, path[2], body) });
    if (path.length === 3 && path[1] === "daily")
      return json({ id: await time.changeDaily(w, path[2], body) });
  }
  throw new HttpError(404, "Not found");
}
