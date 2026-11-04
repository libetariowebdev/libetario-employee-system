import { z } from "zod";
import { attendanceReason } from "./attendance";

export const version = z.number().int().min(1).max(2147483647);
const operationKey = z.uuid();
export const timerInput = z.discriminatedUnion("command", [
  z.object({
    command: z.literal("START"),
    assignmentId: z.uuid(),
    assignmentVersion: version,
    operationKey,
  }),
  z.object({
    command: z.literal("SWITCH"),
    assignmentId: z.uuid(),
    assignmentVersion: version,
    timerId: z.uuid(),
    timerVersion: version,
    operationKey,
  }),
  z.object({
    command: z.enum(["PAUSE", "RESUME", "STOP"]),
    timerId: z.uuid(),
    timerVersion: version,
    operationKey,
  }),
]);
const instant = z.iso
  .datetime({ offset: true })
  .refine(
    (value) => !/\.\d{7,}/.test(value),
    "Use up to six fractional digits",
  );
const segmentChange = z.object({
  operationKey,
  expectedVersion: version,
  expectedTimerVersion: version,
  startedAt: instant,
  endedAt: instant,
  reason: attendanceReason,
});
export const combinedSegmentChange = segmentChange.extend({
  segmentId: z.uuid(),
});
export const segmentReview = segmentChange.extend({
  expectedShiftVersion: version,
});

export const timeRules = z.strictObject({
  timers: z.strictObject({
    switchMode: z.enum(["ATOMIC_STOP_AND_START", "EXPLICIT_STOP_REQUIRED"]),
  }),
  reports: z.strictObject({
    weekStartsOn: z.number().int().min(1).max(7),
    pollSeconds: z.number().int().min(10).max(60),
    maxDays: z.number().int().min(1).max(31),
    maxRows: z.number().int().min(1).max(50000),
    maxEntries: z.number().int().min(1).max(100),
  }),
});
export type TimeRules = z.infer<typeof timeRules>;
export const timeSettings = z.object({
  expectedPolicyId: z.uuid(),
  reason: attendanceReason,
  rules: timeRules,
});

export const timeFilters = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  employeeId: z.uuid().optional(),
  projectId: z.uuid().optional(),
  status: z
    .enum([
      "PENDING",
      "IN_PROGRESS",
      "REVISION_REQUIRED",
      "SUBMITTED",
      "APPROVED",
      "CANCELLED",
      "WITHDRAWN",
      "REJECTED",
    ])
    .optional(),
  grain: z.enum(["day", "week"]).default("day"),
  view: z
    .enum(["summary", "tasks", "segments", "attendance", "approvals"])
    .default("summary"),
});
export type TimeFilters = z.infer<typeof timeFilters>;

const narrative = z.string().trim().max(5000).default("");
export const dailyInput = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("SAVE"),
    operationKey,
    expectedVersion: z.number().int().min(0).max(2147483647),
    workInProgress: narrative,
    issues: narrative,
    notes: narrative,
    nextSteps: narrative,
  }),
  z.object({
    action: z.literal("ENTRY"),
    operationKey,
    expectedVersion: version,
    assignmentId: z.uuid(),
    description: z.string().trim().max(2000),
    reportedComplete: z.boolean(),
    included: z.boolean(),
  }),
  z.object({
    action: z.literal("SUBMIT"),
    operationKey,
    expectedVersion: version,
  }),
]);

export function csvCell(value: unknown) {
  let text = Array.isArray(value) ? value.join("; ") : String(value ?? "");
  if (/^[\s\uFEFF]*[=+\-@＝＋－＠]|^[\t\r\n]/u.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
