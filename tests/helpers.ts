import { config } from "dotenv";
config({ path: ".env.test.local", override: true, quiet: true });
import pg from "pg";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { hash } from "@node-rs/argon2";

export const digest = (s: string) =>
  createHash("sha256").update(s).digest("hex");
export function testOwner() {
  if (!new URL(process.env.MIGRATION_DATABASE_URL!).pathname.endsWith("_test"))
    throw new Error("Tests require a dedicated _test database");
  return new pg.Client({
    connectionString: process.env.MIGRATION_DATABASE_URL,
  });
}
export async function fixture(options?: { password?: string }) {
  const owner = testOwner();
  await owner.connect();
  const suffix = randomBytes(5).toString("hex");
  const ids = { admin: randomUUID(), a: randomUUID(), b: randomUUID() };
  const password =
    options?.password ?? `Test-${randomBytes(20).toString("hex")}`;
  const passwordHash = await hash(password, {
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
  for (const [name, id] of Object.entries(ids)) {
    await owner.query(
      "INSERT INTO users(id,email,username,password_hash,role,must_change_password) VALUES($1,$2,$3,$4,$5,false)",
      [
        id,
        `${name}_${suffix}@example.invalid`,
        `${name}_${suffix}`,
        passwordHash,
        name === "admin" ? "ADMINISTRATOR" : "EMPLOYEE",
      ],
    );
  }
  const tokens = {
    admin: randomBytes(32).toString("hex"),
    a: randomBytes(32).toString("hex"),
    b: randomBytes(32).toString("hex"),
  };
  for (const [name, token] of Object.entries(tokens)) {
    await owner.query(
      "INSERT INTO sessions(user_id,token_hash,csrf_token_hash,authorization_version,idle_expires_at,absolute_expires_at) VALUES($1,$2,$3,1,now()+interval '15 min',now()+interval '60 min')",
      [ids[name as keyof typeof ids], digest(token), digest(token + "csrf")],
    );
  }
  await owner.query("SELECT set_config('app.session_hash',$1,false)", [
    digest(tokens.admin),
  ]);
  let policies = (
    await owner.query("SELECT * FROM company_settings WHERE id=1")
  ).rows[0];
  if (!policies) {
    const p: Record<string, string> = {};
    const configs = {
      SECURITY: {
        idleMinutes: 15,
        absoluteMinutes: 60,
        accountLimit: 5,
        networkLimit: 30,
        windowMinutes: 15,
        lockMinutes: 15,
        resetMinutes: 15,
      },
      WORK: { pinEnabled: false, breaksPaid: true, overnightEnabled: false },
      PAY: {
        rounding: "HALF_UP",
        cutoffWeekday: 1,
        partialDays: "UNCONFIGURED",
        statutoryTreatment: "UNCONFIGURED",
      },
    };
    for (const key of ["SECURITY", "WORK", "PAY"] as const) {
      p[key] = (
        await owner.query(
          "INSERT INTO policy_versions(policy_key,revision,configuration,created_by) VALUES($1,1,$2,$3) RETURNING id",
          [key, JSON.stringify(configs[key]), ids.admin],
        )
      ).rows[0].id;
    }
    await owner.query(
      "INSERT INTO company_settings(company_name,security_policy_id,work_policy_id,pay_policy_id) VALUES($1,$2,$3,$4)",
      ["Libetario Digital Marketing Services", p.SECURITY, p.WORK, p.PAY],
    );
    policies = (await owner.query("SELECT * FROM company_settings")).rows[0];
  }
  for (const name of ["a", "b"] as const) {
    await owner.query(
      "INSERT INTO employee_profiles(user_id,employee_number,legal_name,display_name,designation,start_date) VALUES($1,$2,$3,$3,'Developer','2026-01-01')",
      [
        ids[name],
        `${name.toUpperCase()}-${suffix}`,
        `Test ${name.toUpperCase()} ${suffix}`,
      ],
    );
    await owner.query(
      "INSERT INTO employee_rate_history(employee_id,basis,amount,effective_from,expected_daily_seconds,pay_policy_id,created_by) VALUES($1,'HOURLY',$2,'2026-01-01',28800,$3,$4)",
      [
        ids[name],
        name === "a" ? "100.1250" : "250.5000",
        policies.pay_policy_id,
        ids.admin,
      ],
    );
  }
  return { owner, ids, tokens, suffix, password, policies };
}
