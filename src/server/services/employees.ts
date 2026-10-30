import { z } from "zod";
import { scoped } from "../db";
import { dateOnly } from "../../lib/time";
import { hashPassword, HttpError, randomToken, digest } from "../auth/security";
import type { Session } from "../auth/service";
import { securitySchema } from "../../lib/config";
import { Prisma } from "../../generated/prisma/client";

const text = z.string().trim().min(1).max(160);
const isoDate = z.string().refine((v) => {
  try {
    dateOnly(v);
    return true;
  } catch {
    return false;
  }
}, "Invalid date");
const personal = {
  employee_number: text,
  legal_name: text,
  display_name: text,
  contact: z.string().trim().max(160).nullable(),
  designation: text,
  start_date: isoDate,
};
const account = {
  email: z
    .email()
    .max(254)
    .transform((v) => v.trim().toLowerCase()),
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_.-]{3,40}$/),
};
export const createSchema = z.strictObject({ ...personal, ...account });
export const editSchema = z.strictObject({
  ...personal,
  ...account,
  employment_status: z.enum(["ACTIVE", "INACTIVE"]),
  version: z.number().int().positive(),
  reason: z.string().trim().min(10).max(500),
});
export const rateSchema = z.strictObject({
  basis: z.enum(["DAILY", "HOURLY"]),
  amount: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/),
  effective_from: isoDate,
  expected_daily_seconds: z.number().int().min(1).max(86400),
  reason: z.string().trim().min(10).max(500),
});
const daySchema = z.strictObject({
  weekday: z.number().int().min(1).max(7),
  working_day: z.boolean(),
  start_local: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .nullable(),
  end_local: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .nullable(),
  ends_next_day: z.boolean(),
  paid_break_seconds: z.number().int().min(0).max(86400),
  unpaid_break_seconds: z.number().int().min(0).max(86400),
});
export const scheduleSchema = z
  .strictObject({
    effective_from: isoDate,
    expected_daily_seconds: z.number().int().min(1).max(86400),
    days: z.array(daySchema).length(7),
    reason: z.string().trim().min(10).max(500),
  })
  .superRefine((s, ctx) => {
    if (new Set(s.days.map((d) => d.weekday)).size !== 7)
      ctx.addIssue({ code: "custom", message: "Provide each weekday once" });
    for (const d of s.days) {
      if (!d.working_day) {
        if (
          d.start_local ||
          d.end_local ||
          d.ends_next_day ||
          d.paid_break_seconds ||
          d.unpaid_break_seconds
        )
          ctx.addIssue({
            code: "custom",
            message: "Nonworking days must have no times or breaks",
          });
        continue;
      }
      if (!d.start_local || !d.end_local) {
        ctx.addIssue({
          code: "custom",
          message: "Working days need start/end times",
        });
        continue;
      }
      const mins = (t: string) =>
        Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
      const seconds =
        (mins(d.end_local) -
          mins(d.start_local) +
          (d.ends_next_day ? 1440 : 0)) *
        60;
      if (
        seconds <= 0 ||
        seconds > 86400 ||
        d.paid_break_seconds + d.unpaid_break_seconds >= seconds
      )
        ctx.addIssue({
          code: "custom",
          message: "Invalid daily schedule or breaks",
        });
    }
  });
function admin(s: Session) {
  if (
    s.role !== "ADMINISTRATOR" ||
    s.must_change_password ||
    s.scope !== "ACCOUNT" ||
    !s.mfa_verified_at
  )
    throw new HttpError(403, "Administrator access required");
}
async function reason(tx: Prisma.TransactionClient, value: string) {
  await tx.$queryRaw`SELECT set_config('app.change_reason',${value},true)`;
}
async function lockEmployee(tx: Prisma.TransactionClient, id: string) {
  const rows = await tx.$queryRaw<
    { user_id: string; start_date: Date }[]
  >`SELECT user_id,start_date FROM employee_profiles WHERE user_id=${id}::uuid FOR UPDATE`;
  if (!rows[0]) throw new HttpError(404, "Not found");
  return rows[0];
}
export async function listEmployees(s: Session) {
  admin(s);
  return scoped(s.hash, (tx) =>
    tx.employee_profiles.findMany({
      orderBy: { employee_number: "asc" },
      include: {
        users: {
          select: {
            email: true,
            username: true,
            disabled_at: true,
            must_change_password: true,
          },
        },
      },
    }),
  );
}
export async function employeeDetails(s: Session, id: string) {
  return scoped(s.hash, async (tx) => {
    const p = await tx.employee_profiles.findUnique({
      where: { user_id: id },
      include: {
        users: { select: { email: true, username: true } },
        employee_rate_history: { orderBy: { effective_from: "desc" } },
        employee_schedule_history: {
          orderBy: { effective_from: "desc" },
          include: { employee_schedule_days: { orderBy: { weekday: "asc" } } },
        },
      },
    });
    if (!p) throw new HttpError(404, "Not found");
    return {
      ...p,
      employee_rate_history: p.employee_rate_history.map((r) => ({
        ...r,
        amount: r.amount.toFixed(4),
      })),
    };
  });
}
export async function createEmployee(s: Session, input: unknown) {
  admin(s);
  const data = createSchema.parse(input),
    temporaryPassword = `Ld-${randomToken()}`;
  const passwordHash = await hashPassword(temporaryPassword);
  const user = await scoped(s.hash, async (tx) => {
    const u = await tx.users.create({
      data: {
        email: data.email,
        username: data.username,
        password_hash: passwordHash,
      },
      select: { id: true },
    });
    const { email: _e, username: _u, ...profile } = data;
    await tx.employee_profiles.create({
      data: {
        ...profile,
        start_date: dateOnly(profile.start_date),
        user_id: u.id,
      },
    });
    return u;
  });
  return { id: user.id, temporaryPassword }; // one-time response to the creating administrator
}
export async function editEmployee(s: Session, id: string, input: unknown) {
  admin(s);
  const data = editSchema.parse(input);
  return scoped(s.hash, async (tx) => {
    await reason(tx, data.reason);
    await lockEmployee(tx, id);
    const { email, username, reason: _r, version, ...profile } = data;
    // Edit user first; INACTIVE profile change revokes this user's sessions afterwards.
    await tx.users.update({
      where: { id },
      data: {
        email,
        username,
        version: { increment: 1 },
        updated_at: new Date(),
      },
      select: { id: true },
    });
    const updated = await tx.employee_profiles.updateMany({
      where: { user_id: id, version },
      data: {
        ...profile,
        start_date: dateOnly(profile.start_date),
        version: { increment: 1 },
        updated_at: new Date(),
      },
    });
    if (updated.count !== 1)
      throw new HttpError(409, "Profile changed. Reload before saving.");
    return { ok: true };
  });
}
export async function addRate(s: Session, id: string, input: unknown) {
  admin(s);
  const data = rateSchema.parse(input),
    date = dateOnly(data.effective_from);
  return scoped(s.hash, async (tx) => {
    await reason(tx, data.reason);
    const employee = await lockEmployee(tx, id);
    if (date < employee.start_date)
      throw new HttpError(400, "Rate cannot precede employment start");
    const settings = await tx.company_settings.findUniqueOrThrow({
      where: { id: 1 },
    });
    const previous = await tx.employee_rate_history.findFirst({
      where: { employee_id: id },
      orderBy: { effective_from: "desc" },
    });
    if (previous && date <= previous.effective_from)
      throw new HttpError(
        409,
        "Add rates after the most recent effective date",
      );
    if (previous && (!previous.effective_to || previous.effective_to > date))
      await tx.employee_rate_history.update({
        where: { id: previous.id },
        data: {
          effective_to: date,
          version: { increment: 1 },
          updated_at: new Date(),
        },
      });
    return tx.employee_rate_history.create({
      data: {
        employee_id: id,
        basis: data.basis,
        amount: new Prisma.Decimal(data.amount),
        effective_from: date,
        expected_daily_seconds: data.expected_daily_seconds,
        pay_policy_id: settings.pay_policy_id,
        created_by: s.user_id,
      },
    });
  });
}
export async function addSchedule(s: Session, id: string, input: unknown) {
  admin(s);
  const data = scheduleSchema.parse(input),
    date = dateOnly(data.effective_from);
  return scoped(s.hash, async (tx) => {
    await reason(tx, data.reason);
    const employee = await lockEmployee(tx, id);
    if (date < employee.start_date)
      throw new HttpError(400, "Schedule cannot precede employment start");
    const settings = await tx.company_settings.findUniqueOrThrow({
      where: { id: 1 },
    });
    const policy = await tx.policy_versions.findUniqueOrThrow({
      where: { id: settings.work_policy_id },
    });
    if (
      data.days.some((d) => d.ends_next_day) &&
      !(policy.configuration as Record<string, unknown>).overnightEnabled
    )
      throw new HttpError(
        400,
        "Enable overnight policy before configuring an overnight schedule",
      );
    const previous = await tx.employee_schedule_history.findFirst({
      where: { employee_id: id },
      orderBy: { effective_from: "desc" },
    });
    if (previous && date <= previous.effective_from)
      throw new HttpError(
        409,
        "Add schedules after the most recent effective date",
      );
    if (previous && (!previous.effective_to || previous.effective_to > date))
      await tx.employee_schedule_history.update({
        where: { id: previous.id },
        data: {
          effective_to: date,
          version: { increment: 1 },
          updated_at: new Date(),
        },
      });
    const schedule = await tx.employee_schedule_history.create({
      data: {
        employee_id: id,
        effective_from: date,
        expected_daily_seconds: data.expected_daily_seconds,
        work_policy_id: settings.work_policy_id,
        created_by: s.user_id,
      },
    });
    for (const d of data.days)
      await tx.employee_schedule_days.create({
        data: {
          ...d,
          schedule_id: schedule.id,
          start_local: d.start_local
            ? new Date(`1970-01-01T${d.start_local}:00Z`)
            : null,
          end_local: d.end_local
            ? new Date(`1970-01-01T${d.end_local}:00Z`)
            : null,
        },
      });
    return { id: schedule.id };
  });
}
export async function settings(s: Session) {
  admin(s);
  return scoped(s.hash, async (tx) => ({
    company: await tx.company_settings.findUniqueOrThrow({ where: { id: 1 } }),
    policies: await tx.policy_versions.findMany({
      orderBy: [{ policy_key: "asc" }, { revision: "desc" }],
    }),
  }));
}
export async function updateSecurity(s: Session, input: unknown) {
  admin(s);
  const data = z
    .strictObject({
      expectedPolicyId: z.uuid(),
      configuration: z.record(z.string(), z.unknown()),
      reason: z.string().trim().min(10).max(500),
    })
    .parse(input);
  return scoped(s.hash, async (tx) => {
    await reason(tx, data.reason);
    await tx.$queryRaw`SELECT id FROM company_settings WHERE id=1 FOR UPDATE`;
    const current = await tx.policy_versions.findFirstOrThrow({
      where: { policy_key: "SECURITY" },
      orderBy: { revision: "desc" },
    });
    if (current.id !== data.expectedPolicyId)
      throw new HttpError(409, "Security policy changed; reload before saving");
    const configuration = securitySchema.strict().parse({
      ...(current.configuration as Record<string, unknown>),
      ...data.configuration,
    });
    const p = await tx.policy_versions.create({
      data: {
        policy_key: "SECURITY",
        revision: current.revision + 1,
        configuration,
        created_by: s.user_id,
      },
    });
    await tx.company_settings.update({
      where: { id: 1 },
      data: {
        security_policy_id: p.id,
        version: { increment: 1 },
        updated_at: new Date(),
      },
    });
    return { ok: true };
  });
}
export async function updateOvernight(s: Session, input: unknown) {
  admin(s);
  const b = z
    .strictObject({
      expectedPolicyId: z.uuid(),
      overnightEnabled: z.boolean(),
      overnightCarryHours: z.number().int().min(1).max(8),
      reason: z.string().trim().min(10).max(500),
    })
    .parse(input);
  return scoped(s.hash, async (tx) => {
    await reason(tx, b.reason);
    const recent = await tx.$queryRaw<
      { allowed: boolean }[]
    >`SELECT private.admin_recent() AS allowed`;
    if (!recent[0].allowed)
      throw new HttpError(403, "Recent administrator MFA required");
    await tx.$queryRaw`SELECT id FROM company_settings WHERE id=1 FOR UPDATE`;
    const current = await tx.policy_versions.findFirstOrThrow({
      where: { policy_key: "WORK" },
      orderBy: { revision: "desc" },
    });
    if (current.id !== b.expectedPolicyId)
      throw new HttpError(409, "Work policy changed; reload before saving");
    const p = await tx.policy_versions.create({
      data: {
        policy_key: "WORK",
        revision: current.revision + 1,
        created_by: s.user_id,
        configuration: {
          ...(current.configuration as Record<string, any>),
          overnightEnabled: b.overnightEnabled,
          overnightCarryHours: b.overnightCarryHours,
        },
      },
    });
    await tx.company_settings.update({
      where: { id: 1 },
      data: {
        work_policy_id: p.id,
        version: { increment: 1 },
        updated_at: new Date(),
      },
    });
    return { ok: true };
  });
}
