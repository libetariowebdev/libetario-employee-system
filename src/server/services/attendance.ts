import "server-only";
import { combinedSegmentChange } from "../../lib/work-time";
import { z } from "zod";
import {
  attendanceFilters,
  attendancePolicySchema,
  attendanceReason,
  correctionSchema,
  shiftReviewSchema,
} from "../../lib/attendance";
import { workScoped, type WorkSession } from "../dal/work";
import { HttpError } from "../auth/security";
export type BreakRow = {
  id: string;
  shift_id: string;
  started_at: string;
  ended_at: string | null;
  recorded_start: string | null;
  recorded_end: string | null;
  system_end_at: string | null;
  code: string;
  paid: boolean;
  is_voided: boolean;
  version: number;
  allowance_seconds: number | null;
};
export type ShiftRow = {
  id: string;
  employee_id: string;
  duty_id: string;
  duty_date: string;
  duty_authorization_version: number;
  clocked_in_at: string;
  clocked_out_at: string | null;
  recorded_in_at: string | null;
  recorded_out_at: string | null;
  system_closed_at: string | null;
  source: string;
  close_reason: string | null;
  approval_status: string;
  approved_payable_seconds: string | null;
  suggested_at_review: string | null;
  review_mode: string | null;
  review_reason: string | null;
  reviewed_at: string | null;
  policy_snapshot: z.infer<typeof attendancePolicySchema> & {
    policyId: string;
  };
  version: number;
};
export type AttendanceRow = {
  shift: ShiftRow;
  breaks: BreakRow[];
  employee: { id: string; name: string; number: string };
  flags: string[];
  grossSeconds: string;
  paidBreakSeconds: string;
  unpaidBreakSeconds: string;
  suggestedSeconds: string | null;
  asOf: string;
};
export type Correction = {
  id: string;
  employee_id: string;
  employee_name: string;
  duty_id: string;
  duty_date: string;
  kind: string;
  target_shift_id: string | null;
  requested_by: string;
  reason: string;
  status: string;
  version: number;
  original_values: { shift?: ShiftRow; breaks?: BreakRow[] };
  proposed_values: Record<string, unknown>;
  applied_before: unknown;
  applied_after: unknown;
  review_reason: string | null;
  created_at: string;
  reviewed_at: string | null;
};
export type CurrentAttendance = {
  active: AttendanceRow | null;
  duty: {
    duty_id: string;
    duty_date: string;
    authorization_version: number;
    valid_until: string;
  };
  policy: z.infer<typeof attendancePolicySchema> & { policyId: string };
  asOf: string;
};
function admin(w: WorkSession) {
  if (!w.admin) throw new HttpError(403, "Administrator access required");
}
async function query<T>(
  w: WorkSession,
  sql: (
    tx: Parameters<Parameters<typeof workScoped>[1]>[0],
  ) => Promise<{ data: T }[]>,
) {
  return workScoped(w, async (tx) => (await sql(tx))[0].data);
}
export async function listAttendance(w: WorkSession, input: unknown) {
  const b = attendanceFilters.parse(input);
  return query<{
    items: AttendanceRow[];
    total: number;
    page: number;
    asOf: string;
  }>(
    w,
    (tx) =>
      tx.$queryRaw`SELECT private.attendance_list(${JSON.stringify(b)}::jsonb) data`,
  );
}
export async function attendanceDetail(w: WorkSession, id: string) {
  z.uuid().parse(id);
  return query<AttendanceRow>(
    w,
    (tx) =>
      tx.$queryRaw`SELECT private.attendance_row(${id}::uuid,private.security_now()) data`,
  );
}
export async function currentAttendance(w: WorkSession) {
  return query<CurrentAttendance>(
    w,
    (tx) => tx.$queryRaw`SELECT private.attendance_current() data`,
  );
}
export async function attendancePolicy(w: WorkSession) {
  return query<z.infer<typeof attendancePolicySchema> & { policyId: string }>(
    w,
    (tx) => tx.$queryRaw`SELECT private.attendance_settings() data`,
  );
}
export async function attendanceCommand(
  w: WorkSession,
  action: "CLOCK_IN" | "CLOCK_OUT" | "BREAK_START" | "BREAK_END",
  target: string | null,
  input: unknown,
) {
  if (w.admin) throw new HttpError(403, "Employee duty required");
  if (target) z.uuid().parse(target);
  // Strip untrusted client clocks/counters/actor claims; accounting only accepts these fields.
  const b = z
    .object({
      operationKey: z.uuid(),
      expectedVersion: z.number().int().positive().optional(),
      code: z.string().max(16).optional(),
    })
    .parse(input);
  if (action !== "CLOCK_IN" && !b.expectedVersion)
    throw new HttpError(400, "Expected version required");
  return query<string>(
    w,
    (tx) =>
      tx.$queryRaw`SELECT private.attendance_command(${action},${target}::uuid,${b.operationKey}::uuid,${action === "CLOCK_IN" ? null : (b.expectedVersion ?? null)}::int,${action === "BREAK_START" ? (b.code ?? null) : null}) data`,
  );
}
export async function reconcileAttendance(w: WorkSession) {
  return query<number>(
    w,
    (tx) => tx.$queryRaw`SELECT private.attendance_reconcile_self() data`,
  );
}
export async function requestAttendanceCorrection(
  w: WorkSession,
  input: unknown,
) {
  const b = correctionSchema.parse(input);
  return query<string>(
    w,
    (tx) =>
      tx.$queryRaw`SELECT private.attendance_request(${JSON.stringify(b)}::jsonb) data`,
  );
}
export async function decideAttendanceCorrection(
  w: WorkSession,
  id: string,
  input: unknown,
) {
  admin(w);
  z.uuid().parse(id);
  const b = z
    .object({
      operationKey: z.uuid(),
      expectedVersion: z.number().int().positive(),
      decision: z.enum(["APPROVED", "REJECTED"]),
      reason: attendanceReason,
      segments: z.array(combinedSegmentChange).max(100).optional(),
    })
    .parse(input);
  return query<string>(
    w,
    (tx) =>
      tx.$queryRaw`SELECT private.attendance_decide(${id}::uuid,${JSON.stringify(b)}::jsonb) data`,
  );
}
export async function attendanceCorrections(w: WorkSession, input: unknown) {
  const b = attendanceFilters.parse(input);
  return query<{
    items: Correction[];
    total: number;
    page: number;
    asOf: string;
  }>(
    w,
    (tx) =>
      tx.$queryRaw`SELECT private.attendance_corrections(${JSON.stringify(b)}::jsonb) data`,
  );
}
export async function reviewAttendance(
  w: WorkSession,
  id: string,
  input: unknown,
) {
  admin(w);
  z.uuid().parse(id);
  const b = shiftReviewSchema.parse(input);
  return query<string>(
    w,
    (tx) =>
      tx.$queryRaw`SELECT private.attendance_review(${id}::uuid,${JSON.stringify(b)}::jsonb) data`,
  );
}
export async function updateAttendancePolicy(w: WorkSession, input: unknown) {
  admin(w);
  const b = z
    .object({
      expectedPolicyId: z.uuid(),
      configuration: attendancePolicySchema,
      reason: attendanceReason,
    })
    .parse(input);
  await workScoped(
    w,
    (tx) =>
      tx.$queryRaw`SELECT private.set_attendance_policy(${b.expectedPolicyId}::uuid,${JSON.stringify(b.configuration)}::jsonb,${b.reason})::text`,
  );
  return { ok: true };
}
export type BulkPreview = {
  eligible: {
    id: string;
    version: number;
    employeeName: string;
    employeeNumber: string;
    dutyDate: string;
    clockedInAt: string;
    clockedOutAt: string;
    suggestedSeconds: string;
  }[];
  excluded: number;
  asOf: string;
};
export async function bulkAttendancePreview(w: WorkSession, input: unknown) {
  admin(w);
  const b = attendanceFilters.parse(input);
  return query<BulkPreview>(
    w,
    (tx) =>
      tx.$queryRaw`SELECT private.attendance_bulk_preview(${JSON.stringify(b)}::jsonb) data`,
  );
}
export async function bulkApproveAttendance(w: WorkSession, input: unknown) {
  admin(w);
  const b = z
    .object({
      filters: attendanceFilters,
      operationKey: z.uuid(),
      expected: z
        .array(z.object({ id: z.uuid(), version: z.number().int().positive() }))
        .min(1)
        .max(500),
    })
    .parse(input);
  b.expected.sort((a, b) => a.id.localeCompare(b.id));
  return query<{ ids: string[]; replayed: boolean }>(
    w,
    (tx) =>
      tx.$queryRaw`SELECT private.attendance_bulk_approve(${JSON.stringify(b.filters)}::jsonb,${JSON.stringify(b.expected)}::jsonb,${b.operationKey}::uuid) data`,
  );
}
export async function attendanceDuties(
  w: WorkSession,
  date: string,
  employeeId?: string,
) {
  z.iso.date().parse(date);
  if (employeeId) z.uuid().parse(employeeId);
  return query<
    {
      id: string;
      duty_date: string;
      status: string;
      valid_from: string;
      valid_until: string;
    }[]
  >(
    w,
    (tx) =>
      tx.$queryRaw`SELECT private.attendance_duties(${date}::date,${employeeId ?? null}::uuid) data`,
  );
}
export async function attendancePeople(w: WorkSession) {
  admin(w);
  return workScoped(
    w,
    (tx) =>
      tx.$queryRaw<
        { id: string; name: string; number: string }[]
      >`SELECT user_id id,display_name name,employee_number number FROM employee_profiles ORDER BY display_name,user_id`,
  );
}
