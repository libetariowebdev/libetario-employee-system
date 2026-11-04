import { assertCsrf, cookie, HttpError } from "../auth/security";
import { z } from "zod";
import {
  changePayroll,
  payrollIdentity,
  readPayroll,
} from "../services/payroll";
import { exportPayroll } from "../payslips/export";
import {
  downloadPayslip,
  issueAfterCommit,
  issuePayslip,
  readDelivery,
  recordPayment,
} from "../payslips/service";

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
  if (request.method === "GET" || request.method === "HEAD") {
    if (view === "payslips" && id && !action)
      return downloadPayslip(identity, id, request);
    if (view === "export" && !action && (id === "csv" || id === "zip"))
      return exportPayroll(identity, id === "csv" ? "CSV" : "ZIP", request);
  }
  if (request.method === "GET" && !action) {
    const offset = Number(
      new URL(request.url).searchParams.get("offset") ?? "0",
    );
    if (view === "payslips" && !id)
      return result(await readDelivery(identity, undefined, offset));
    if (view === "delivery" && id)
      return result(await readDelivery(identity, id));
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
    if (view === "periods" && id && action === "approve") {
      const saved = await changePayroll(identity, "approve", input, id);
      const period = await readPayroll<{
        lines: { id: string; state: string }[];
      }>(identity, "period", id);
      const lines = period.lines
        .filter((line) => line.state !== "DRAFT")
        .map((line) => line.id);
      return result({
        ...saved,
        issuance: await issueAfterCommit(identity, lines, "APPROVAL"),
      });
    }
    if (view === "lines" && id && !action) {
      const saved = await changePayroll(identity, "line", input, id);
      if (input.action === "APPROVE_REPLACEMENT")
        return result({
          ...saved,
          issuance: await issueAfterCommit(identity, [id], "APPROVAL"),
        });
      return result(saved);
    }
    if (view === "lines" && id && action === "payment") {
      const saved = await recordPayment(identity, id, input);
      return result({
        ...saved,
        issuance: await issueAfterCommit(identity, [id], "PAYMENT"),
      });
    }
    if (view === "lines" && id && action === "payslip") {
      const { event } = z
        .strictObject({ event: z.enum(["APPROVAL", "PAYMENT"]) })
        .parse(input);
      return result(await issuePayslip(identity, id, event));
    }
  }
  throw new HttpError(404, "Not found");
}
