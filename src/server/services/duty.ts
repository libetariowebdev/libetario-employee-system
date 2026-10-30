import "server-only";
import { z } from "zod";
import { scoped } from "../db";
import { HttpError } from "../auth/security";
import type { Session } from "../auth/service";
export const dutyMutation = z.strictObject({
  employeeIds: z
    .array(z.uuid())
    .min(1)
    .max(100)
    .refine((a) => new Set(a).size === a.length, "Duplicate employee"),
  date: z.iso.date(),
  action: z.enum(["ACTIVATE", "REVOKE", "REGRANT"]),
  reason: z.string().trim().min(10).max(500),
  overnight: z.boolean().default(false),
  validUntil: z.iso.datetime({ offset: true }).optional(),
});
export async function mutateDuty(s: Session, input: unknown) {
  if (s.role !== "ADMINISTRATOR" || s.scope !== "ACCOUNT" || !s.mfa_verified_at)
    throw new HttpError(403, "Administrator access required");
  const b = dutyMutation.parse(input);
  return scoped(s.hash, async (tx) => {
    const result = await tx.$queryRaw<
      { changed: number }[]
    >`SELECT private.mutate_duty(${b.employeeIds}::uuid[],${b.date}::date,${b.action},${b.reason},${b.overnight},${b.validUntil ?? null}::timestamptz) AS changed`;
    return result[0];
  });
}
export async function dutyStatus(s: Session, date?: string) {
  if (s.scope !== "ACCOUNT")
    throw new HttpError(403, "Account access required");
  if (date) z.iso.date().parse(date);
  return scoped(s.hash, async (tx) => {
    const [clock] = await tx.$queryRaw<
      { now: Date; date: string }[]
    >`SELECT private.security_now() AS now,to_char(private.security_now() AT TIME ZONE 'Asia/Manila','YYYY-MM-DD') AS date`;
    const selected = date ?? clock.date;
    const grants = await tx.$queryRaw<
      Record<string, any>[]
    >`SELECT id,employee_id,duty_date,status,valid_from,valid_until,overnight_allowed,authorization_version,first_authenticated_at,first_auth_version,reason FROM duty_authorizations WHERE duty_date=${selected}::date OR (overnight_allowed AND valid_until>${clock.now} AND valid_from<=${clock.now}) ORDER BY duty_date DESC,employee_id`;
    return { date: selected, fetchedAt: clock.now, grants };
  });
}
export async function dutyDashboard(
  s: Session,
  date?: string,
  eventType?: string,
  employeeId?: string,
) {
  if (s.role !== "ADMINISTRATOR" || s.scope !== "ACCOUNT")
    throw new HttpError(403, "Administrator access required");
  const status = await dutyStatus(s, date);
  if (eventType)
    z.string()
      .regex(/^[A-Z_]{1,50}$/)
      .parse(eventType);
  if (employeeId) z.uuid().parse(employeeId);
  return scoped(s.hash, async (tx) => {
    const employees = await tx.$queryRaw<
      { id: string; display_name: string; employee_number: string }[]
    >`SELECT u.id,p.display_name,p.employee_number FROM users u JOIN employee_profiles p ON p.user_id=u.id WHERE u.role='EMPLOYEE' AND u.disabled_at IS NULL AND p.employment_status='ACTIVE' ORDER BY p.display_name`;
    const events = await tx.$queryRaw<
      Record<string, any>[]
    >`SELECT id,user_id,event_type,outcome,occurred_at FROM auth_events WHERE (occurred_at AT TIME ZONE 'Asia/Manila')::date=${status.date}::date AND (${eventType ?? null}::text IS NULL OR event_type=${eventType ?? null}) AND (${employeeId ?? null}::uuid IS NULL OR user_id=${employeeId ?? null}::uuid) ORDER BY occurred_at DESC LIMIT 50`;
    return { ...status, employees, events };
  });
}
