import { randomUUID } from "node:crypto";
import pg from "pg";
import { dutyFixture, freeze } from "./duty-helpers";
import { digest } from "./helpers";
import { beginEnrollment, confirmEnrollment } from "../src/server/auth/mfa";
import { session } from "../src/server/auth/service";
import { startDuty, completeDutyStage } from "../src/server/auth/duty";
import { mutateDuty } from "../src/server/services/duty";
import { workSession } from "../src/server/dal/work";
import { createProject, createTask } from "../src/server/services/work";
import { openSecret, otp } from "../src/lib/mfa-crypto";
export async function workFixture(date?: string) {
  const f = await dutyFixture(date);
  try {
    const c = randomUUID(),
      ctoken = digest(randomUUID());
    await f.owner.query(
      "INSERT INTO users(id,email,username,password_hash,role,must_change_password) SELECT $1,$2,$3,password_hash,'EMPLOYEE',false FROM users WHERE id=$4",
      [c, `c_${f.suffix}@example.invalid`, `c_${f.suffix}`, f.ids.a],
    );
    await f.owner.query(
      "INSERT INTO employee_profiles(user_id,employee_number,legal_name,display_name,designation,start_date) VALUES($1,$2,$3,$3,'Designer','2026-01-01')",
      [c, `C-${f.suffix}`, `Test C ${f.suffix}`],
    );
    await f.owner.query(
      "INSERT INTO sessions(user_id,token_hash,csrf_token_hash,authorization_version,idle_expires_at,absolute_expires_at) VALUES($1,$2,$2,1,private.security_now()+interval '1 hour',private.security_now()+interval '2 hours')",
      [c, digest(ctoken)],
    );
    const ids = { ...f.ids, c },
      tokens = { ...f.tokens, c: ctoken };
    const duty: Record<string, { token: string; secret: Buffer }> = {};
    const admin = await workSession(tokens.admin);
    for (const who of ["a", "b", "c"] as const) {
      const s = await session(tokens[who]),
        n = digest(randomUUID());
      const pending = await beginEnrollment(s, f.password, false, n);
      const row = (
          await f.owner.query("SELECT * FROM mfa_enrollments WHERE id=$1", [
            pending.enrollmentId,
          ])
        ).rows[0],
        secret = openSecret(row);
      const confirmed = await confirmEnrollment(
        s,
        row.id,
        otp(secret, f.now.getTime()),
        n,
      );
      await mutateDuty(await session(tokens.admin), {
        employeeIds: [ids[who]],
        date: f.day,
        action: "ACTIVATE",
        reason: "Approved project-work test authorization",
      });
      f.now = new Date(f.now.getTime() + 30000);
      await freeze(f.owner, f.now);
      const ch = await startDuty(confirmed.token, f.day, f.password, false, n);
      const issued = await completeDutyStage(
        confirmed.token,
        ch.challenge,
        "TOTP",
        otp(secret, f.now.getTime()),
        n,
      );
      if (issued.kind !== "SESSION") throw new Error("Duty session required");
      tokens[who] = issued.account!.token;
      duty[who] = { token: issued.token, secret };
    }
    const a = await workSession(undefined, duty.a.token),
      b = await workSession(undefined, duty.b.token),
      cw = await workSession(undefined, duty.c.token);
    const project = await createProject(admin, {
      creationKey: randomUUID(),
      code: "P-" + f.suffix.toUpperCase(),
      name: "Project " + f.suffix,
    });
    return {
      ...f,
      ids,
      tokens,
      duty,
      admin,
      a,
      b,
      c: cw,
      projectId: project.id,
    };
  } catch (e) {
    await f.cleanup();
    throw e;
  }
}
export type WorkFixture = Awaited<ReturnType<typeof workFixture>>;
export function taskInput(
  f: WorkFixture,
  changes: Record<string, unknown> = {},
) {
  return {
    creationKey: randomUUID(),
    projectId: f.projectId,
    title: "Shared deliverable " + f.suffix,
    assignmentMode: "SELECTED",
    employeeIds: [f.ids.a, f.ids.b, f.ids.c],
    ...changes,
  };
}
export async function sharedTask(
  f: WorkFixture,
  changes: Record<string, unknown> = {},
) {
  return (await createTask(f.admin, taskInput(f, changes))).id;
}
export async function runtime<T>(
  token: string,
  fn: (c: pg.Client) => Promise<T>,
) {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.session_hash',$1,true)", [
      digest(token),
    ]);
    return await fn(c);
  } finally {
    await c.query("ROLLBACK");
    await c.end();
  }
}
export async function blocked(owner: pg.Client, fragment: string) {
  for (let i = 0; i < 150; i++) {
    await owner.query("SELECT pg_stat_clear_snapshot()");
    const r = await owner.query(
      "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid() AND query LIKE $1",
      ["%" + fragment + "%"],
    );
    if (r.rowCount) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Expected PostgreSQL lock was not observed");
}
