import { randomInt, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { digest, fixture } from "./helpers";
import { freeze, restoreClock } from "./duty-helpers";
import { weeklyCutoff } from "../src/lib/time";
import { session } from "../src/server/auth/service";
import { changePayroll, readPayroll } from "../src/server/services/payroll";

export const fixturePay = {
  source: "APPROVED_ATTENDANCE",
  breaks: "CONFIRM_CAPTURED",
  overnight: "REVIEWED_SPLIT",
  paidDay: "ANY_POSITIVE",
  partialDay: "PRORATE",
  minimumPay: "NONE",
  lateness: "NO_ADJUSTMENT",
  overtime: "MANUAL",
  restDay: "MANUAL",
  holiday: "MANUAL",
  premium: "MANUAL",
  allowance: "MANUAL",
  bonus: "MANUAL",
  deductions: "CATALOG",
  contributions: "NONE",
  withholding: "NONE",
  loans: "NONE",
  timeRounding: "NONE",
  moneyRounding: "HALF_EVEN",
  moneyUnitCentavos: 1,
  weekday: 6,
  paydayOffset: 2,
  zeroNet: "REVIEW_NO_DISBURSEMENT",
  paymentMethods: [
    { code: "TEST_BANK", reference: "DIGITS", dateRule: "ON_OR_AFTER_PAYDAY" },
  ],
};
export const payReason = "Reviewed fake payroll acceptance fixture";
export const addDays = (day: string, days: number) =>
  new Date(new Date(day).getTime() + days * 86400000)
    .toISOString()
    .slice(0, 10);

export async function payrollFixture(
  config: Record<string, unknown> | null = fixturePay,
) {
  const f = await fixture();
  const base = new Date("2035-01-01T04:00:00Z").getTime();
  let start: string;
  for (;;) {
    start = weeklyCutoff(
      new Date(base + randomInt(50, 2500) * 7 * 86400000),
      6,
    ).startDate;
    const clash = await f.owner.query(
      `SELECT 1 FROM payroll_periods WHERE start_date BETWEEN $1::date-7 AND $1::date+7
      UNION ALL SELECT 1 FROM policy_versions WHERE pay_effective_date BETWEEN $1::date-7 AND $1::date+7
      UNION ALL SELECT 1 FROM earning_types WHERE effective_date BETWEEN $1::date-7 AND $1::date+7`,
      [start],
    );
    if (!clash.rowCount) break;
  }
  const end = addDays(start, 7);
  async function at(instant: string) {
    const now = new Date(instant);
    await freeze(f.owner, now);
    await f.owner.query(
      `UPDATE sessions SET idle_expires_at=$1::timestamptz+interval '15 minutes',
      absolute_expires_at=$1::timestamptz+interval '1 hour',
      mfa_verified_at=CASE WHEN user_id=$2 THEN $1::timestamptz ELSE mfa_verified_at END
      WHERE token_hash=ANY($3)`,
      [now, f.ids.admin, Object.values(f.tokens).map(digest)],
    );
  }
  await at(end + "T02:00:00Z");
  const admin = await session(f.tokens.admin);
  async function publish(cfg: Record<string, unknown>, effectiveDate = start) {
    const current = await readPayroll<{ id: string }>(admin, "settings");
    return changePayroll(admin, "settings", {
      expectedId: current.id,
      effectiveDate,
      reason: payReason,
      configuration: cfg,
    });
  }
  async function regular(effectiveDate = start) {
    return changePayroll(admin, "catalog", {
      kind: "EARNING",
      code: "REGULAR",
      label: "Regular pay",
      category: "REGULAR",
      effectiveDate,
      enabled: true,
      reason: payReason,
      rule: { mode: "REGULAR" },
    });
  }
  if (config) {
    await publish(config);
    await regular();
  }
  async function schedule(who: "a" | "b") {
    return (
      await f.owner.query(
        `INSERT INTO employee_schedule_history(employee_id,effective_from,expected_daily_seconds,work_policy_id,created_by)
      SELECT $1,$2,28800,work_policy_id,$3 FROM company_settings RETURNING id`,
        [f.ids[who], addDays(start, -7), f.ids.admin],
      )
    ).rows[0].id as string;
  }
  const schedules = { a: await schedule("a"), b: await schedule("b") };
  async function grant(
    who: "a" | "b",
    date: string,
    until: string | null = null,
  ) {
    return (
      await f.owner.query(
        `INSERT INTO duty_authorizations(employee_id,duty_date,status,granted_by,reason,valid_from,valid_until,overnight_allowed,work_policy_id)
      SELECT $1,$2,'ACTIVATED',$3,$4,private.payroll_midnight($2::date),greatest(private.payroll_midnight($2::date+1),$5::timestamptz),true,work_policy_id
      FROM company_settings RETURNING id,valid_from,valid_until`,
        [f.ids[who], date, f.ids.admin, payReason, until],
      )
    ).rows[0];
  }
  async function workingDay(who: "a" | "b", date: string) {
    const day = new Date(date).getUTCDay() || 7;
    await f.owner.query(
      `INSERT INTO employee_schedule_days(schedule_id,weekday,working_day,start_local,end_local,ends_next_day)
      VALUES($1,$2,true,'08:00','08:00',true) ON CONFLICT DO NOTHING`,
      [schedules[who], day],
    );
    return day;
  }
  async function shift(
    who: "a" | "b",
    date: string,
    from: string,
    until: string | null,
    approvedSeconds: string | null,
    override = false,
  ) {
    const employee = f.ids[who];
    const duty = await grant(who, date, until);
    const day = await workingDay(who, date);
    const s = (
      await f.owner.query(
        `INSERT INTO attendance_shifts(employee_id,duty_id,duty_authorization_version,duty_date,grant_from,grant_until,
      shift_number,recorded_in_at,recorded_out_at,clocked_in_at,clocked_out_at,source,close_source,close_reason,closed_by,
      policy_id,schedule_id,weekday,policy_snapshot,schedule_snapshot,approval_status,approved_payable_seconds,review_mode,reviewed_at,reviewed_by,review_reason)
      SELECT $1,$2,1,$3,$4,$5,1,$6,$7,$6,$7,'EMPLOYEE',CASE WHEN $7::timestamptz IS NOT NULL THEN 'EMPLOYEE' END,
       CASE WHEN $7::timestamptz IS NOT NULL THEN 'CLOCK_OUT' END,CASE WHEN $7::timestamptz IS NOT NULL THEN $8::uuid END,
       work_policy_id,$9,$10,private.attendance_policy(),
       jsonb_build_object('working_day',true,'paid_break_seconds',0,'unpaid_break_seconds',0),
       CASE WHEN $11::numeric IS NULL THEN 'PENDING' ELSE 'APPROVED' END,$11,
       CASE WHEN $11::numeric IS NOT NULL THEN $12::text END,CASE WHEN $11::numeric IS NOT NULL THEN private.security_now() END,
       CASE WHEN $11::numeric IS NOT NULL THEN $8::uuid END,CASE WHEN $11::numeric IS NOT NULL THEN $13::text END
      FROM company_settings RETURNING id,version`,
        [
          employee,
          duty.id,
          date,
          duty.valid_from,
          duty.valid_until,
          from,
          until,
          f.ids.admin,
          schedules[who],
          day,
          approvedSeconds,
          override ? "OVERRIDE" : "SUGGESTED",
          payReason,
        ],
      )
    ).rows[0];
    return {
      id: s.id as string,
      version: s.version as number,
      dutyId: duty.id as string,
    };
  }
  async function prepare(who: ("a" | "b")[] = ["a"], startDate = start) {
    return changePayroll(admin, "periods", {
      startDate,
      employeeIds: who.map((name) => f.ids[name]),
      operationKey: randomUUID(),
    });
  }
  const period = (id: string) => readPayroll<PayPeriod>(admin, "period", id);
  const line = (id: string) => readPayroll<PayLine>(admin, "line", id);
  async function approve(
    id: string,
    state?: PayPeriod,
    operationKey = randomUUID(),
  ) {
    const p = state ?? (await period(id));
    return changePayroll(
      admin,
      "approve",
      { expectedVersion: p.version, manifest: p.reviewManifest, operationKey },
      id,
    );
  }
  const command = (
    id: string,
    version: number,
    action: string,
    body: Record<string, unknown> = {},
  ) =>
    changePayroll(
      admin,
      "line",
      { action, operationKey: randomUUID(), expectedVersion: version, ...body },
      id,
    );
  async function cleanup() {
    try {
      await restoreClock(f.owner);
    } finally {
      await f.owner.end();
    }
  }
  return {
    ...f,
    start,
    end,
    at,
    admin,
    publish,
    regular,
    prepare,
    period,
    line,
    approve,
    command,
    shift,
    grant,
    workingDay,
    cleanup,
  };
}
export type PayLine = {
  id: string;
  employeeId: string;
  state: string;
  version: number;
  gross: string;
  deductions: string;
  net: string;
  snapshotDigest: string | null;
  sourceChanged: boolean;
  snapshot: Record<string, unknown> | null;
  issues: {
    code: string;
    missing?: string[];
    flags?: string[];
    date?: string;
  }[];
  items: {
    description: string;
    amount: string;
    kind: string;
    detail: Record<string, string>;
    attendance: { shiftId: string; seconds: string; dutyDate: string }[];
  }[];
};
export type PayPeriod = {
  version: number;
  state: string;
  payday: string;
  reviewManifest: string;
  lines: PayLine[];
};

export async function waitForPayrollLock(owner: Client, pattern: string) {
  for (let tryCount = 0; tryCount < 120; tryCount++) {
    const row = await owner.query(
      "SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE $1",
      [pattern],
    );
    if (row.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Expected a PostgreSQL payroll lock wait");
}
