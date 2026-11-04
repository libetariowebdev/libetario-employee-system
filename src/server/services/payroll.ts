import "server-only";
import { z } from "zod";
import { payrollOptions } from "@/lib/payroll";
import { dateOnly } from "@/lib/time";
import { scoped } from "../db";
import { session, type Session } from "../auth/service";
import { HttpError } from "../auth/security";
import { requireDuty } from "../dal/duty";
import { databaseErrorCode, workError } from "../dal/work";
import type { Prisma } from "../../generated/prisma/client";

const date = z.string().refine((value) => {
  try {
    dateOnly(value);
    return true;
  } catch {
    return false;
  }
}, "Enter a valid Manila calendar date");
const note = z.string().trim().min(10).max(2000);
const evidence = z.string().trim().min(1).max(2000);
const money = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/);
const seconds = z
  .string()
  .regex(/^\d{1,6}(\.\d{1,6})?$/)
  .transform((value) => exactScale(value, 6));
const uuid = z.uuid();
const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9_]{0,31}$/);
const optionShape = Object.fromEntries(
  Object.entries(payrollOptions).map(([key, values]) => [
    key,
    z.enum(values).optional(),
  ]),
);
const policy = z.strictObject({
  ...optionShape,
  weekday: z.number().int().min(1).max(7).optional(),
  paydayOffset: z.number().int().min(0).max(28).optional(),
  timeUnitSeconds: z.number().int().min(1).max(3600).optional(),
  moneyUnitCentavos: z.number().int().min(1).max(10000).optional(),
  minimumDaySeconds: z.number().int().min(1).max(86400).optional(),
  minimumPay: z
    .union([z.literal("NONE"), money.transform(centavos)])
    .optional(),
  paymentMethods: z
    .array(
      z.strictObject({
        code,
        reference: z.enum(["EXACT_ALNUM", "UPPER_ALNUM", "DIGITS"]),
        dateRule: z.enum(["ON_OR_AFTER_CUTOFF", "ON_OR_AFTER_PAYDAY"]),
      }),
    )
    .min(1)
    .max(12)
    .optional(),
});
function exactScale(amount: string, scale: number) {
  const [whole, fraction = ""] = amount.split(".");
  return BigInt(whole).toString() + "." + fraction.padEnd(scale, "0");
}
function centavos(amount: string) {
  return exactScale(amount, 2);
}
const configure = z.strictObject({
  expectedId: uuid,
  effectiveDate: date,
  reason: note,
  configuration: policy,
});
const catalogBase = {
  code,
  label: z.string().trim().min(1).max(100),
  effectiveDate: date,
  enabled: z.boolean(),
  reason: note,
};
const catalog = z.discriminatedUnion("kind", [
  z.strictObject({
    ...catalogBase,
    kind: z.literal("EARNING"),
    category: z.enum([
      "REGULAR",
      "PREMIUM",
      "ALLOWANCE",
      "BONUS",
      "ADJUSTMENT",
    ]),
    rule: z.strictObject({ mode: z.enum(["REGULAR", "MANUAL"]) }),
  }),
  z.strictObject({
    ...catalogBase,
    kind: z.literal("DEDUCTION"),
    category: z.enum([
      "STATUTORY",
      "CONTRIBUTION",
      "WITHHOLDING",
      "LOAN",
      "OTHER",
      "ADJUSTMENT",
    ]),
    employeeId: uuid.optional(),
    designation: z.string().trim().min(1).max(100).optional(),
    rule: z.discriminatedUnion("mode", [
      z.strictObject({ mode: z.literal("MANUAL") }),
      z.strictObject({
        mode: z.literal("FIXED"),
        amount: money.transform(centavos),
      }),
    ]),
  }),
]);
const prepare = z.strictObject({
  startDate: date,
  employeeIds: z.array(uuid).min(1).max(100),
  operationKey: uuid,
});
const approve = z.strictObject({
  expectedVersion: z.number().int().positive(),
  manifest: z.string().regex(/^[a-f0-9]{64}$/),
  operationKey: uuid,
});
const lineBase = {
  expectedVersion: z.number().int().positive(),
  operationKey: uuid,
};
const reviewed = { ...lineBase, reason: note, evidence };
const manual = {
  ...reviewed,
  typeId: uuid,
  kind: z.enum(["EARNING", "DEDUCTION"]),
  date,
  amount: money.transform(centavos),
  premiumKind: z.enum(["overtime", "restDay", "holiday", "premium"]).optional(),
};
const line = z.discriminatedUnion("action", [
  z.strictObject({ ...lineBase, action: z.literal("RECALCULATE") }),
  z.strictObject({
    ...reviewed,
    action: z.enum([
      "VOID",
      "REPLACE",
      "APPROVE_REPLACEMENT",
      "CORRECTION_NEEDED",
      "ZERO_REVIEW",
    ]),
  }),
  z.strictObject({ ...manual, action: z.literal("MANUAL") }),
  z.strictObject({
    ...manual,
    action: z.literal("POST_CORRECTION"),
    correctionId: uuid,
  }),
  z.strictObject({
    ...reviewed,
    action: z.literal("REMOVE_MANUAL"),
    manualId: uuid,
  }),
  z.strictObject({
    ...reviewed,
    action: z.literal("SOURCE"),
    shiftId: uuid,
    shiftVersion: z.number().int().positive(),
    flags: z.array(z.string().max(100)).max(64),
    allocations: z
      .array(z.strictObject({ date, seconds }))
      .min(1)
      .max(3)
      .transform((allocations) =>
        allocations.sort((a, b) => a.date.localeCompare(b.date)),
      ),
  }),
]);

export type PayrollView =
  "settings" | "directory" | "periods" | "period" | "line" | "own" | "own-line";

export async function payrollIdentity(account?: string, duty?: string) {
  const identity = await session(account);
  if (duty) {
    const other = await requireDuty(duty, false).catch((error: unknown) => {
      if (error instanceof HttpError) return null;
      throw error;
    });
    if (other && other.user_id !== identity.user_id)
      throw new HttpError(403, "Conflicting sign-in identities");
  }
  return identity;
}

function admin(identity: Session) {
  if (identity.role !== "ADMINISTRATOR" || identity.scope !== "ACCOUNT")
    throw new HttpError(403, "Administrator access required");
}

function databaseError(error: unknown): never {
  const code = databaseErrorCode(error);
  if (code === "P0422")
    throw new HttpError(
      422,
      "Resolve the payroll review issues and check the cutoff.",
    );
  if (code === "42501")
    throw new HttpError(
      403,
      "Valid administrator access and recent MFA are required for this change.",
    );
  if (code === "22023" || code === "23514")
    throw new HttpError(
      400,
      "The change does not meet the payroll rules. Check the settings and review inputs.",
    );
  return workError(error);
}

export async function readPayroll<T>(
  identity: Session,
  view: PayrollView,
  id?: string,
  offset = 0,
): Promise<T> {
  if (view !== "own" && view !== "own-line") admin(identity);
  const target = id ? uuid.parse(id) : null;
  const skip = z.number().int().min(0).max(50000).parse(offset);
  try {
    const rows = await scoped(
      identity.hash,
      (tx) =>
        tx.$queryRaw<
          { data: T }[]
        >`SELECT private.payroll_read(${view},${target}::uuid,${skip}::int) AS data`,
    );
    return rows[0].data;
  } catch (error) {
    return databaseError(error);
  }
}

type Command = "settings" | "catalog" | "periods" | "approve" | "line";
export async function changePayroll(
  identity: Session,
  command: Command,
  input: unknown,
  id?: string,
) {
  admin(identity);
  const target = id ? uuid.parse(id) : null;
  const schemas = {
    settings: configure,
    catalog,
    periods: prepare,
    approve,
    line,
  };
  const parsed = schemas[command].parse(input);
  const json = JSON.stringify(parsed);
  const statements = {
    settings: (tx: Prisma.TransactionClient) =>
      tx.$queryRaw<
        { id: string }[]
      >`SELECT private.payroll_configure(${json}::jsonb) AS id`,
    catalog: (tx: Prisma.TransactionClient) =>
      tx.$queryRaw<
        { id: string }[]
      >`SELECT private.payroll_catalog(${json}::jsonb) AS id`,
    periods: (tx: Prisma.TransactionClient) =>
      tx.$queryRaw<
        { id: string }[]
      >`SELECT private.payroll_prepare(${json}::jsonb) AS id`,
    approve: (tx: Prisma.TransactionClient) =>
      tx.$queryRaw<
        { id: string }[]
      >`SELECT private.payroll_approve(${target}::uuid,${json}::jsonb) AS id`,
    line: (tx: Prisma.TransactionClient) =>
      tx.$queryRaw<
        { id: string }[]
      >`SELECT private.payroll_line_command(${target}::uuid,${json}::jsonb) AS id`,
  };
  try {
    return (await scoped(identity.hash, statements[command]))[0];
  } catch (error) {
    return databaseError(error);
  }
}
