import { z } from "zod";
import { session } from "../auth/service";
import { HttpError } from "../auth/security";
import { profileForSession } from "../dal/profiles";
export async function profileResponse(
  request: Request,
  employeeId: string,
): Promise<Response> {
  const token = request.headers
    .get("cookie")
    ?.match(/(?:^|;\s*)libetario_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  const headers = { "Cache-Control": "private, no-store" };
  if (!token)
    return Response.json(
      { error: "Sign in required" },
      { status: 401, headers },
    );
  try {
    const s = await session(token);
    if (!z.uuid().safeParse(employeeId).success)
      return Response.json({ error: "Not found" }, { status: 404, headers });
    const profile = await profileForSession(s.hash, employeeId);
    return profile
      ? Response.json(profile, { headers })
      : Response.json({ error: "Not found" }, { status: 404, headers });
  } catch (e) {
    return Response.json(
      {
        error:
          e instanceof HttpError ? e.message : "Request could not be completed",
      },
      { status: e instanceof HttpError ? e.status : 500, headers },
    );
  }
}
