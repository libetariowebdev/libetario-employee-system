import { z } from "zod";
import Decimal from "decimal.js";
export const attendancePolicySchema = z.strictObject({
  longShiftReviewSeconds: z.number().int().min(3600).max(86400).default(57600),
  maxShiftsPerDutyDate: z
    .number()
    .int()
    .min(1)
    .max(20)
    .nullable()
    .default(null),
  latenessGraceSeconds: z.number().int().min(0).max(3600).default(0),
  breakCodes: z
    .array(
      z.strictObject({
        code: z.string().regex(/^[A-Z][A-Z0-9_]{0,15}$/),
        label: z.string().trim().min(1).max(80),
        paid: z.boolean(),
        allowanceSeconds: z.number().int().min(0).max(86400).nullable(),
      }),
    )
    .min(1)
    .max(20)
    .refine(
      (x) => new Set(x.map((v) => v.code)).size === x.length,
      "Unique break codes required",
    )
    .default([
      {
        code: "MEAL",
        label: "Meal break",
        paid: false,
        allowanceSeconds: null,
      },
      {
        code: "SHORT",
        label: "Short break",
        paid: true,
        allowanceSeconds: null,
      },
    ]),
  reconcileBatchSize: z.number().int().min(1).max(100).default(100),
  bulkMaxShifts: z.number().int().min(1).max(500).default(500),
  bulkMaxDays: z.number().int().min(1).max(31).default(31),
});
export type AttendancePolicy = z.infer<typeof attendancePolicySchema>;
export const attendanceDefaults = attendancePolicySchema.parse({});
export const exactSeconds = z
  .string()
  .regex(
    /^[0-9]{1,14}(\.[0-9]{1,6})?$/,
    "Use nonnegative seconds, up to six decimal places",
  )
  .transform((v) => new Decimal(v).toFixed(6));
export const attendanceReason = z.string().trim().min(10).max(2000);
export const attendanceFilters = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  employeeId: z.uuid().optional(),
  status: z.enum(["ALL", "PENDING", "APPROVED", "REJECTED"]).default("ALL"),
  flagged: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .or(z.boolean())
    .default(false),
  page: z.coerce.number().int().min(1).max(100000).default(1),
});
const instant = z.iso.datetime({ offset: true, precision: undefined });
export const correctionSchema = z
  .strictObject({
    kind: z.enum(["AMEND_SHIFT", "ADD_MISSING_SHIFT"]),
    shiftId: z.uuid().optional(),
    dutyId: z.uuid().optional(),
    expectedVersion: z.number().int().positive().optional(),
    operationKey: z.uuid(),
    reason: attendanceReason,
    proposed: z.strictObject({
      clockedInAt: instant,
      clockedOutAt: instant,
      breaks: z
        .array(
          z.strictObject({
            id: z.uuid().optional(),
            code: z.string().regex(/^[A-Z][A-Z0-9_]{0,15}$/),
            startedAt: instant,
            endedAt: instant,
            voided: z.boolean().default(false),
          }),
        )
        .max(100)
        .optional(),
    }),
  })
  .refine(
    (b) =>
      b.kind === "AMEND_SHIFT"
        ? !!b.shiftId && !b.dutyId && !!b.expectedVersion
        : !!b.dutyId && !b.shiftId && !b.expectedVersion,
    "Choose one correction target",
  );
export const shiftReviewSchema = z
  .object({
    operationKey: z.uuid(),
    expectedVersion: z.number().int().positive(),
    decision: z.enum(["APPROVED", "REJECTED"]),
    mode: z.enum(["SUGGESTED", "OVERRIDE"]).default("SUGGESTED"),
    value: exactSeconds.optional(),
    reason: z.string().trim().max(2000).default(""),
    acknowledgeFlags: z.boolean().default(false),
  })
  .refine(
    (b) =>
      (b.decision !== "REJECTED" && b.mode !== "OVERRIDE") ||
      b.reason.length >= 10,
    "A reason of 10–2000 characters is required",
  )
  .refine((b) => b.mode !== "OVERRIDE" || !!b.value, "Enter override seconds");
export function duration(seconds: string | null | undefined) {
  if (seconds == null) return "—";
  const us = BigInt(new Decimal(seconds).mul(1000000).toFixed(0)),
    whole = us / 1000000n,
    fraction = (us % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole / 3600n}:${((whole % 3600n) / 60n).toString().padStart(2, "0")}:${(whole % 60n).toString().padStart(2, "0")}${fraction ? "." + fraction : ""}`;
}
export function attendanceLabel(code: string) {
  return code.toLowerCase().replaceAll("_", " ");
}
export function manilaInput(instant: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const get = (name: string) => parts.find((p) => p.type === name)!.value,
    frac = instant.match(/\.\d+/)?.[0] ?? "";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}${frac}`;
}
export function manilaInstant(local: string) {
  return (
    local.replace(" ", "T") + (local.length === 16 ? ":00" : "") + "+08:00"
  );
}
