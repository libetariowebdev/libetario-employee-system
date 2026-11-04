import { randomUUID } from "node:crypto";
import { workFixture } from "./work-helpers";
import { freeze } from "./duty-helpers";
import { digest } from "./helpers";
import { otp } from "../src/lib/mfa-crypto";
import { login, session } from "../src/server/auth/service";
import { verifyAdminMfa } from "../src/server/auth/mfa";
import { startDuty, completeDutyStage } from "../src/server/auth/duty";
import { workSession } from "../src/server/dal/work";
import { requireDuty } from "../src/server/dal/duty";
import {
  attendanceCommand,
  attendanceDetail,
} from "../src/server/services/attendance";
export async function attendanceFixture() {
  const f = await workFixture();
  for (const who of ["a", "b", "c"] as const) {
    const schedule = (
      await f.owner.query(
        "INSERT INTO employee_schedule_history(employee_id,effective_from,expected_daily_seconds,work_policy_id,created_by) VALUES($1,$2,28800,(SELECT work_policy_id FROM company_settings WHERE id=1),$3) RETURNING id",
        [f.ids[who], f.day, f.ids.admin],
      )
    ).rows[0].id;
    const local = new Date(f.now.getTime() + 8 * 3600000)
      .toISOString()
      .slice(11, 19);
    for (let d = 1; d <= 7; d++)
      await f.owner.query(
        "INSERT INTO employee_schedule_days(schedule_id,weekday,working_day,start_local,end_local,paid_break_seconds,unpaid_break_seconds) VALUES($1,$2,true,$3,'23:59:59',900,1800)",
        [schedule, d, local],
      );
  }
  const cleanup = async () => {
    try {
      for (const id of [f.ids.a, f.ids.b, f.ids.c])
        await f.owner.query(
          "SELECT private.attendance_force_close(id,private.security_now(),'TEST_FIXTURE_FINISHED') FROM attendance_shifts WHERE employee_id=$1 AND clocked_out_at IS NULL",
          [id],
        );
    } finally {
      await f.cleanup();
    }
  };
  return { ...f, cleanup };
}
export type AF = Awaited<ReturnType<typeof attendanceFixture>>;
export async function advance(f: AF, seconds: number) {
  f.now = new Date(f.now.getTime() + seconds * 1000);
  await freeze(f.owner, f.now);
}
export async function freshDuty(f: AF, who: "a" | "b" | "c" = "a") {
  try {
    await requireDuty(f.duty[who].token, false);
    return;
  } catch {}
  const net = digest(randomUUID()),
    ch = await startDuty(f.duty[who].token, undefined, undefined, true, net);
  const issued = await completeDutyStage(
    f.duty[who].token,
    ch.challenge,
    "TOTP",
    otp(f.duty[who].secret, f.now.getTime()),
    net,
  );
  if (issued.kind !== "SESSION")
    throw new Error("Duty reauthentication required");
  f.duty[who].token = issued.token;
  f[who] = await workSession(undefined, issued.token);
}
export async function freshAdmin(f: AF) {
  try {
    const s = await session(f.tokens.admin);
    if (
      s.mfa_verified_at &&
      f.now.getTime() - new Date(s.mfa_verified_at).getTime() < 5 * 60000
    ) {
      f.admin = await workSession(s.token);
      return;
    }
  } catch {}
  const net = digest(randomUUID()),
    pending = await login("admin_" + f.suffix, f.password, net);
  const result = await verifyAdminMfa(
    await session(pending.token, true, true),
    otp(f.adminSecret, f.now.getTime()),
    net,
  );
  f.tokens.admin = result.token;
  f.admin = await workSession(result.token);
}
export async function clockIn(
  f: AF,
  who: "a" | "b" | "c" = "a",
  key = randomUUID(),
) {
  await freshDuty(f, who);
  return attendanceCommand(f[who], "CLOCK_IN", null, { operationKey: key });
}
export async function clockOut(f: AF, id: string, who: "a" | "b" | "c" = "a") {
  await freshDuty(f, who);
  const s = await attendanceDetail(f[who], id);
  return attendanceCommand(f[who], "CLOCK_OUT", id, {
    operationKey: randomUUID(),
    expectedVersion: s.shift.version,
  });
}
