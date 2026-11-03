import { z, ZodError } from "zod";
import {
  assertCsrf,
  cookie,
  cookieString,
  csrfAnonymous,
  HttpError,
  networkKey,
} from "../auth/security";
import {
  login,
  session,
  logout,
  changePassword,
  completeReset,
  requestReset,
} from "../auth/service";
import * as employees from "../services/employees";
import { scoped } from "../db";
import * as mfa from "../auth/mfa";
import * as dutyAuth from "../auth/duty";
import * as duty from "../services/duty";
import { requireDuty } from "../dal/duty";
import { workSession } from "../dal/work";
import * as work from "../services/work";
import * as tasks from "../dal/tasks";
import * as submissions from "../services/submissions";
import { excludeFile } from "../files/service";
import { fileApi } from "./files";
const idSchema = z.uuid();
const noStore = { "Cache-Control": "private, no-store" };
function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { ...noStore, ...extra } });
}
async function boundedBody(request: Request, limit = 32768) {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new HttpError(413, "Request too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}
export async function api(request: Request, path: string[]): Promise<Response> {
  try {
    const key = path.join("/"),
      method = request.method;
    if (
      path[0] === "work" &&
      (path[1] === "files" || (path.length === 4 && path[3] === "files"))
    )
      return fileApi(request, path);
    const bodyLimit = path[0] === "work" ? 131072 : 32768;
    if (method === "GET" && key === "auth/csrf") {
      const csrf = csrfAnonymous();
      return json({ csrf }, 200, {
        "Set-Cookie": cookieString("libetario_csrf", csrf, 900),
      });
    }
    let body: Record<string, unknown> = {};
    if (method !== "GET") {
      if (
        request.headers
          .get("content-type")
          ?.split(";")[0]
          .trim()
          .toLowerCase() !== "application/json"
      )
        throw new HttpError(415, "Use application/json");
      if (Number(request.headers.get("content-length") ?? 0) > bodyLimit)
        throw new HttpError(413, "Request too large");
      const text = await boundedBody(request, bodyLimit);
      try {
        body = JSON.parse(text);
      } catch {
        throw new HttpError(400, "Invalid JSON");
      }
      if (!body || Array.isArray(body) || typeof body !== "object")
        throw new HttpError(400, "Invalid request");
    }
    if (method === "POST" && (key === "auth/login" || key === "auth/reset")) {
      assertCsrf(request, body.csrf);
      const network = networkKey(request);
      if (key === "auth/login") {
        const b = z
          .object({
            identifier: z.string().trim().min(1).max(254),
            password: z.string().min(1).max(512),
          })
          .parse(body);
        const result = await login(b.identifier, b.password, network);
        return json({ ok: true }, 200, {
          "Set-Cookie": cookieString(
            "libetario_session",
            result.token,
            result.maxAge,
          ),
        });
      }
      const b = z
        .object({
          token: z.string().regex(/^[a-f0-9]{64}$/),
          password: z.string().max(512),
        })
        .parse(body);
      await completeReset(b.token, b.password, networkKey(request));
      return json({ ok: true }, 200, {
        "Set-Cookie": cookieString("libetario_session", "", 0),
      });
    }
    if (
      method === "POST" &&
      ["auth/mfa/recover", "auth/mfa/reset/redeem"].includes(key)
    ) {
      assertCsrf(request, body.csrf);
      const b = z
        .object({
          identifier: z.string().trim().min(1).max(254),
          password: z.string().min(1).max(512),
          code: z.string().min(1).max(150),
        })
        .parse(body);
      const issued =
        key === "auth/mfa/recover"
          ? await mfa.recoverAuthenticator(
              b.identifier,
              b.password,
              b.code,
              networkKey(request),
            )
          : await mfa.redeemAuthenticatorReset(
              b.identifier,
              b.password,
              b.code,
              networkKey(request),
            );
      return json({ ok: true }, 200, {
        "Set-Cookie": cookieString(
          "libetario_session",
          issued.token,
          issued.maxAge,
        ),
      });
    }
    if (method === "GET" && key === "duty/context")
      return json(await requireDuty(cookie(request, "libetario_duty")));
    if (method === "GET" && key === "duty/access")
      return json(
        await dutyAuth.dutyBinding(cookie(request, "libetario_duty")),
      );
    if (
      method === "POST" &&
      [
        "auth/duty/reauth",
        "auth/duty/pin",
        "auth/duty/totp",
        "auth/duty/logout",
      ].includes(key)
    ) {
      const { csrf: _challengeCsrf, ...factorInput } = body;
      const b = z
        .strictObject({
          challenge: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          binding: z.enum(["ACCOUNT", "DUTY"]).optional(),
          code: z.string().max(32).optional(),
        })
        .parse(factorInput);
      const bound = cookie(
        request,
        b.binding === "ACCOUNT" ? "libetario_session" : "libetario_duty",
      );
      if (!bound) throw new HttpError(401, mfa.AUTH_FAILURE);
      if (key === "auth/duty/reauth" || key === "auth/duty/logout") {
        assertCsrf(request, body.csrf, bound);
        if (key === "auth/duty/logout") {
          await dutyAuth.logoutDuty(bound);
          return json({ ok: true }, 200, {
            "Set-Cookie": cookieString("libetario_duty", "", 0),
          });
        }
        return json(
          await dutyAuth.startDuty(
            bound,
            undefined,
            undefined,
            true,
            networkKey(request),
          ),
        );
      }
      if (!b.challenge || !b.code) throw new HttpError(401, mfa.AUTH_FAILURE);
      assertCsrf(request, body.csrf, bound + ":" + b.challenge);
      const result = await dutyAuth.completeDutyStage(
        bound,
        b.challenge,
        key === "auth/duty/pin" ? "PIN" : "TOTP",
        b.code,
        networkKey(request),
      );
      if (result.kind === "CHALLENGE") return json(result);
      const response = json({ ok: true });
      response.headers.append(
        "Set-Cookie",
        cookieString("libetario_duty", result.token, result.maxAge),
      );
      if (result.account)
        response.headers.append(
          "Set-Cookie",
          cookieString(
            "libetario_session",
            result.account.token,
            result.account.maxAge,
          ),
        );
      return response;
    }
    if (path[0] === "work") {
      const w = await workSession(
        cookie(request, "libetario_session"),
        cookie(request, "libetario_duty"),
      );
      if (method !== "GET") assertCsrf(request, body.csrf, w.token);
      const { csrf: _workCsrf, ...input } = body;
      const query = new URL(request.url).searchParams;
      if (key === "work/context" && method === "GET")
        return json({ administrator: w.admin, name: w.name, csrf: w.csrf });
      if (key === "work/admin-options" && method === "GET")
        return json(await tasks.workAdminOptions(w));
      if (key === "work/task-policy" && method === "POST")
        return json(await work.updateTaskPolicy(w, input));
      if (key === "work/seen" && method === "POST")
        return json(await work.seen(w, input));
      const filters = Object.fromEntries(
        [...query].filter(([, value]) => value !== ""),
      );
      if (key === "work/upload-policy" && method === "GET")
        return json(await submissions.uploadPolicy(w));
      if (key === "work/upload-policy" && method === "POST")
        return json(await submissions.updateUploadPolicy(w, input));
      if (key === "work/reviews" && method === "GET")
        return json(
          await submissions.reviewQueue(
            w,
            z.coerce
              .number()
              .int()
              .min(1)
              .max(2000)
              .parse(query.get("page") ?? 1),
          ),
        );
      if (
        path[1] === "assignments" &&
        path.length === 4 &&
        path[3] === "drafts" &&
        method === "POST"
      )
        return json(
          await submissions.createDraft(w, idSchema.parse(path[2]), input),
          201,
        );
      if (
        path[1] === "draft-files" &&
        path.length === 4 &&
        path[3] === "exclude" &&
        method === "POST"
      )
        return json(await excludeFile(w, idSchema.parse(path[2])));
      if (path[1] === "submissions" && path[2]) {
        const id = idSchema.parse(path[2]);
        if (path.length === 3 && method === "GET")
          return json(await submissions.submission(w, id));
        if (path.length === 3 && method === "PATCH")
          return json(await submissions.editDraft(w, id, input));
        if (path.length === 4 && path[3] === "submit" && method === "POST")
          return json(await submissions.submitDraft(w, id, input));
        if (path.length === 4 && path[3] === "review" && method === "POST")
          return json(await submissions.review(w, id, input), 201);
      }
      if (key === "work/projects" && method === "GET")
        return json(await tasks.listProjects(w, filters));
      if (key === "work/projects" && method === "POST")
        return json(await work.createProject(w, input), 201);
      if (key === "work/tasks" && method === "GET")
        return json(await tasks.listTasks(w, filters));
      if (key === "work/tasks" && method === "POST")
        return json(await work.createTask(w, input), 201);
      if (path[1] === "projects" && path.length === 3) {
        const id = idSchema.parse(path[2]);
        if (method === "GET") return json(await tasks.projectDetail(w, id));
        if (method === "PATCH")
          return json(await work.editProject(w, id, input));
      }
      if (path[1] === "tasks" && path[2]) {
        const id = idSchema.parse(path[2]);
        if (path.length === 4 && path[3] === "submissions" && method === "GET")
          return json(await submissions.submissions(w, id));
        if (path.length === 3 && method === "GET")
          return json(
            await tasks.taskDetail(
              w,
              id,
              z.coerce
                .number()
                .int()
                .min(1)
                .max(2000)
                .parse(query.get("commentsPage") ?? 1),
            ),
          );
        if (path.length === 3 && method === "PATCH")
          return json(await work.editTask(w, id, input));
        if (path.length === 4 && method === "POST") {
          if (path[3] === "progress")
            return json(await work.progress(w, id, input));
          if (path[3] === "members")
            return json(await work.membership(w, id, input));
          if (path[3] === "comments")
            return json(await work.comment(w, id, input), 201);
        }
      }
      throw new HttpError(404, "Not found");
    }
    const s = await session(
      cookie(request, "libetario_session"),
      key === "auth/change-password" ||
        key === "auth/logout" ||
        key === "session" ||
        key.startsWith("auth/mfa/"),
      true,
    );
    if (method !== "GET") assertCsrf(request, body.csrf, s.token);
    const { csrf: _csrf, ...input } = body;
    if (method === "GET" && key === "session")
      return json({
        user_id: s.user_id,
        role: s.role,
        must_change_password: s.must_change_password,
        csrf: s.csrf,
        scope: s.scope,
        setup_purpose: s.setup_purpose,
      });
    if (method === "POST" && key === "auth/logout") {
      await logout(s);
      await dutyAuth.logoutDuty(cookie(request, "libetario_duty"));
      const response = json({ ok: true }, 200, {
        "Set-Cookie": cookieString("libetario_session", "", 0),
      });
      response.headers.append(
        "Set-Cookie",
        cookieString("libetario_duty", "", 0),
      );
      return response;
    }
    if (method === "POST" && key === "auth/change-password") {
      const b = z
        .object({ current: z.string().max(512), password: z.string().max(512) })
        .parse(body);
      await changePassword(s, b.current, b.password, networkKey(request));
      return json({ ok: true }, 200, {
        "Set-Cookie": cookieString("libetario_session", "", 0),
      });
    }
    if (key.startsWith("auth/mfa/")) {
      const network = networkKey(request);
      if (method === "GET" && key === "auth/mfa/status")
        return json(await mfa.mfaStatus(s));
      if (method === "POST" && key === "auth/mfa/enroll") {
        const b = z
          .object({
            password: z.string().min(1).max(512),
            replace: z.boolean().default(false),
          })
          .parse(body);
        return json(
          await mfa.beginEnrollment(s, b.password, b.replace, network),
        );
      }
      if (
        method === "POST" &&
        ["auth/mfa/confirm", "auth/mfa/verify", "auth/mfa/reauth"].includes(key)
      ) {
        const b = z
          .object({
            code: z.string().max(32),
            enrollmentId: z.uuid().optional(),
          })
          .parse(body);
        if (key === "auth/mfa/reauth")
          return json(await mfa.reauthenticateMfa(s, b.code, network));
        if (key === "auth/mfa/confirm" && !b.enrollmentId)
          throw new HttpError(400, "Enrollment is required");
        const result =
          key === "auth/mfa/confirm"
            ? await mfa.confirmEnrollment(s, b.enrollmentId!, b.code, network)
            : await mfa.verifyAdminMfa(s, b.code, network);
        return json(
          { ok: true, ...("codes" in result ? { codes: result.codes } : {}) },
          200,
          {
            "Set-Cookie": cookieString(
              "libetario_session",
              result.token,
              result.maxAge,
            ),
          },
        );
      }
      if (
        method === "POST" &&
        ["auth/mfa/pin", "auth/mfa/codes"].includes(key)
      ) {
        const b = z
          .object({
            password: z.string().min(1).max(512),
            code: z.string().max(32),
            pin: z.string().max(32).optional(),
          })
          .parse(body);
        return json(
          key === "auth/mfa/pin"
            ? await mfa.setPin(s, b.password, b.code, b.pin ?? "", network)
            : await mfa.regenerateCodes(s, b.password, b.code, network),
        );
      }
      throw new HttpError(404, "Not found");
    }
    if (s.scope !== "ACCOUNT")
      throw new HttpError(
        403,
        "Complete authenticator verification or setup first",
      );
    const query = new URL(request.url).searchParams;
    if (method === "POST" && key === "auth/duty/start") {
      const b = z
        .strictObject({
          date: z.iso.date(),
          password: z.string().min(1).max(512),
        })
        .parse(input);
      return json(
        await dutyAuth.startDuty(
          s.token,
          b.date,
          b.password,
          false,
          networkKey(request),
        ),
      );
    }
    if (method === "GET" && key === "duty/status")
      return json(await duty.dutyStatus(s, query.get("date") ?? undefined));
    if (method === "GET" && key === "me")
      return json(await employees.employeeDetails(s, s.user_id));
    if (path[0] !== "admin") throw new HttpError(404, "Not found");
    if (s.role !== "ADMINISTRATOR")
      throw new HttpError(403, "Administrator access required");
    if (method === "GET" && key === "admin/duty")
      return json(
        await duty.dutyDashboard(
          s,
          query.get("date") ?? undefined,
          query.get("event") ?? undefined,
          query.get("employee") ?? undefined,
        ),
      );
    if (method === "POST" && key === "admin/duty")
      return json(await duty.mutateDuty(s, input));
    if (method === "POST" && key === "admin/settings/overnight")
      return json(await employees.updateOvernight(s, input));
    if (key === "admin/employees" && method === "GET")
      return json(await employees.listEmployees(s));
    if (key === "admin/employees" && method === "POST")
      return json(await employees.createEmployee(s, input), 201);
    if (key === "admin/settings" && method === "GET")
      return json(await employees.settings(s));
    if (key === "admin/settings/security" && method === "POST")
      return json(await employees.updateSecurity(s, input));
    if (key === "admin/audit" && method === "GET")
      return json(
        await scoped(s.hash, (tx) =>
          tx.audit_log.findMany({ orderBy: { occurred_at: "desc" }, take: 50 }),
        ),
      );
    if (path[1] === "employees" && path[2]) {
      const id = idSchema.parse(path[2]);
      if (path.length === 3 && method === "GET")
        return json(await employees.employeeDetails(s, id));
      if (path.length === 3 && method === "PATCH")
        return json(await employees.editEmployee(s, id, input));
      if (path[3] === "rates" && method === "POST")
        return json(await employees.addRate(s, id, input), 201);
      if (path[3] === "schedule" && method === "POST")
        return json(await employees.addSchedule(s, id, input), 201);
      if (path[3] === "reset" && method === "POST") {
        const b = z
          .strictObject({ note: z.string().trim().min(10).max(500) })
          .parse(input);
        return json({ token: await requestReset(s, id, b.note) });
      }
      if (path[3] === "mfa-reset" && method === "POST") {
        const b = z
          .strictObject({
            note: z.string().trim().min(10).max(500),
            reason: z.string().trim().min(10).max(500),
          })
          .parse(input);
        return json({
          token: await mfa.requestMfaReset(s, id, b.note, b.reason),
        });
      }
    }
    throw new HttpError(404, "Not found");
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    if (e instanceof ZodError)
      return json(
        {
          error: e.issues
            .map((i) => `${i.path.join(".") || "Input"}: ${i.message}`)
            .join("; "),
        },
        400,
      );
    const code = (e as { code?: string }).code;
    if (code === "P2002" || code === "23505")
      return json(
        { error: "That identifier or effective date already exists" },
        409,
      );
    if (
      code === "P2004" ||
      code === "P2010" ||
      code === "P2003" ||
      code === "23P01"
    )
      return json(
        { error: "Change conflicts with database rules or existing history" },
        409,
      );
    if (code === "P2025") return json({ error: "Not found" }, 404);
    // Never echo database errors, SQL parameters, tokens, passwords or connection URLs.
    console.error("Request failed", code ?? "INTERNAL");
    return json({ error: "Request could not be completed" }, 500);
  }
}
