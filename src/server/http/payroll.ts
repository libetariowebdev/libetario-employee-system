import { assertCsrf, cookie, HttpError } from "../auth/security";
import {
  changePayroll,
  payrollIdentity,
  readPayroll,
} from "../services/payroll";

export async function payrollApi(
  request: Request,
  path: string[],
  body: Record<string, unknown>,
) {
  const identity = await payrollIdentity(
    cookie(request, "libetario_session"),
    cookie(request, "libetario_duty"),
  );
  const [, view, id, action, extra] = path;
  const headers = {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
  const result = (value: unknown) => Response.json(value, { headers });
  if (extra) throw new HttpError(404, "Not found");
  if (request.method === "GET" && !action) {
    const offset = Number(
      new URL(request.url).searchParams.get("offset") ?? "0",
    );
    if (
      !id &&
      (view === "settings" ||
        view === "periods" ||
        view === "directory" ||
        view === "own")
    )
      return result(await readPayroll(identity, view, undefined, offset));
    if (id && (view === "periods" || view === "lines" || view === "own"))
      return result(
        await readPayroll(
          identity,
          view === "periods"
            ? "period"
            : view === "lines"
              ? "line"
              : "own-line",
          id,
        ),
      );
  }
  if (request.method === "POST") {
    const { csrf, ...input } = body;
    assertCsrf(request, csrf, identity.token);
    if (
      !id &&
      (view === "settings" || view === "catalog" || view === "periods")
    )
      return result(await changePayroll(identity, view, input));
    if (view === "periods" && id && action === "approve")
      return result(await changePayroll(identity, "approve", input, id));
    if (view === "lines" && id && !action)
      return result(await changePayroll(identity, "line", input, id));
  }
  throw new HttpError(404, "Not found");
}
