import "server-only";
import { scoped } from "../db";
import { digest, HttpError } from "../auth/security";
export type DutyContext = {
  user_id: string;
  session_id: string;
  duty_id: string;
  duty_date: Date;
  authorization_version: number;
  valid_until: Date;
  idle_expires_at: Date;
  absolute_expires_at: Date;
};
// Shared by the real page, HTTP endpoint and later duty tools. Never infer from ACCOUNT.
export async function requireDuty(
  token: string | undefined,
  touch = true,
): Promise<DutyContext> {
  if (!token || !/^[a-f0-9]{64}$/.test(token))
    throw new HttpError(401, "Valid duty access required");
  return scoped(digest(token), async (tx) => {
    if (touch) await tx.$queryRaw`SELECT private.touch_duty()::text`;
    const rows = await tx.$queryRaw<
      DutyContext[]
    >`SELECT * FROM private.duty_context()`;
    if (!rows[0]) throw new HttpError(401, "Valid duty access required");
    return rows[0];
  });
}
