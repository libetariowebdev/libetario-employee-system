import { fixture, digest } from "./helpers";
import { session } from "../src/server/auth/service";
import { beginEnrollment, confirmEnrollment } from "../src/server/auth/mfa";
import { openSecret, otp } from "../src/lib/mfa-crypto";
import type { Client } from "pg";
export async function freeze(c: Client, now: Date) {
  const target = new URL(process.env.MIGRATION_DATABASE_URL!);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
    target.pathname !== "/libetario_test" ||
    !Number.isFinite(now.getTime())
  )
    throw new Error("Clock override requires the dedicated local test owner");
  const check = (
    await c.query(
      "SELECT current_database() name,current_user=pg_get_userbyid(proowner) owner FROM pg_proc WHERE oid='private.security_now()'::regprocedure",
    )
  ).rows[0];
  if (check.name !== "libetario_test" || !check.owner)
    throw new Error("Trusted test-clock owner required");
  // Only test owner can replace this function. No request/environment clock override exists.
  await c.query(
    `CREATE OR REPLACE FUNCTION private.security_now() RETURNS timestamptz LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$SELECT '${now.toISOString()}'::timestamptz$$`,
  );
}
export async function restoreClock(c: Client) {
  await c.query(
    "CREATE OR REPLACE FUNCTION private.security_now() RETURNS timestamptz LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$SELECT clock_timestamp()$$",
  );
}
export async function dutyFixture() {
  const f = await fixture();
  const real = (await f.owner.query("SELECT clock_timestamp() now")).rows[0]
    .now as Date;
  // Future date, safely after real created_at defaults, deterministic Manila boundaries.
  const day = new Date(real.getTime() + 2 * 86400000)
      .toISOString()
      .slice(0, 10),
    now = new Date(day + "T10:00:00+08:00");
  await freeze(f.owner, now);
  await f.owner.query(
    "UPDATE sessions SET idle_expires_at=$2::timestamptz+interval '1 day',absolute_expires_at=$2::timestamptz+interval '2 days',mfa_verified_at=CASE WHEN mfa_verified_at IS NOT NULL THEN $2 END WHERE user_id=ANY($1::uuid[])",
    [Object.values(f.ids), now],
  );
  const settings = (
    await f.owner.query(
      "SELECT p.policy_key,p.configuration FROM company_settings s JOIN policy_versions p ON p.id IN (s.security_policy_id,s.work_policy_id)",
    )
  ).rows;
  const original = Object.fromEntries(
    settings.map((r) => [r.policy_key, r.configuration]),
  );
  const cleanup = async () => {
    try {
      await setPolicy(f, "SECURITY", original.SECURITY);
      await setPolicy(f, "WORK", original.WORK);
      await f.owner.query(
        "UPDATE security_throttles SET failure_count=0,locked_until=NULL,window_started_at=clock_timestamp() WHERE scope LIKE '%NETWORK%'",
      );
    } finally {
      await restoreClock(f.owner);
      await f.owner.end();
    }
  };
  return { ...f, day, now, cleanup };
}
export async function setPolicy(
  f: Awaited<ReturnType<typeof fixture>>,
  key: "WORK" | "SECURITY",
  configuration: Record<string, unknown>,
) {
  await f.owner.query("BEGIN");
  try {
    const row = (
      await f.owner.query(
        "INSERT INTO policy_versions(policy_key,revision,configuration,created_by) SELECT $1,max(revision)+1,$2,$3 FROM policy_versions WHERE policy_key=$1 RETURNING id",
        [key, configuration, f.ids.admin],
      )
    ).rows[0];
    // Column name comes from the closed enum, never user input.
    await f.owner.query(
      `UPDATE company_settings SET ${key === "WORK" ? "work_policy_id" : "security_policy_id"}=$1,version=version+1 WHERE id=1`,
      [row.id],
    );
    await f.owner.query("COMMIT");
  } catch (e) {
    await f.owner.query("ROLLBACK");
    throw e;
  }
}
export async function securityConfig(f: Awaited<ReturnType<typeof fixture>>) {
  return (
    await f.owner.query(
      "SELECT p.configuration FROM company_settings s JOIN policy_versions p ON p.id=s.security_policy_id",
    )
  ).rows[0].configuration;
}
export async function enrollDuty(
  f: Awaited<ReturnType<typeof fixture>>,
  now: Date,
  who: "a" | "b" = "a",
) {
  const s = await session(f.tokens[who]),
    n = digest(f.suffix + who),
    start = await beginEnrollment(s, f.password, false, n),
    row = (
      await f.owner.query("SELECT * FROM mfa_enrollments WHERE id=$1", [
        start.enrollmentId,
      ])
    ).rows[0],
    secret = openSecret(row);
  const result = await confirmEnrollment(
    s,
    row.id,
    otp(secret, now.getTime()),
    n,
  );
  return {
    secret,
    token: result.token,
    enrollmentId: row.id,
    codes: result.codes,
  };
}
