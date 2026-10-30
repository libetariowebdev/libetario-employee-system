import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { hashPassword } from "../src/server/auth/security";
import { securitySchema } from "../src/lib/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Obviously fictitious, development-only credentials. Also documented only in README.
export const sampleCredentials = [
  {
    username: "demo.admin",
    email: "admin@example.invalid",
    password: "FakeAdmin-ChangeMe-2026!",
    name: "Sample Administrator",
    role: "ADMINISTRATOR",
  },
  {
    username: "demo.employee.a",
    email: "employee.a@example.invalid",
    password: "FakeEmployeeA-ChangeMe-2026!",
    name: "Sample Employee A",
    role: "EMPLOYEE",
  },
  {
    username: "demo.employee.b",
    email: "employee.b@example.invalid",
    password: "FakeEmployeeB-ChangeMe-2026!",
    name: "Sample Employee B",
    role: "EMPLOYEE",
  },
];
async function seed() {
  if (process.env.NODE_ENV === "production")
    throw new Error("Development seeding is forbidden in production");
  const url = new URL(process.env.MIGRATION_DATABASE_URL!);
  if (
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !["/libetario", "/libetario_test"].includes(url.pathname)
  )
    throw new Error("Seed only the dedicated local Libetario database");
  const c = new pg.Client({ connectionString: url.toString() });
  await c.connect();
  try {
    if ((await c.query("SELECT count(*)::int AS n FROM users")).rows[0].n !== 0)
      throw new Error(
        "Seed requires an empty dedicated database; existing data was not changed",
      );
    await c.query("BEGIN");
    const ids: string[] = [];
    for (const user of sampleCredentials) {
      const id = randomUUID();
      ids.push(id);
      await c.query(
        "INSERT INTO users(id,email,username,password_hash,role) VALUES($1,$2,$3,$4,$5)",
        [
          id,
          user.email,
          user.username,
          await hashPassword(user.password),
          user.role,
        ],
      );
    }
    const policies: Record<string, string> = {};
    const configs = {
      SECURITY: securitySchema.parse({}),
      WORK: {
        pinEnabled: false,
        breaksPaid: true,
        overnightEnabled: false,
        clockOutTimer: "CLOSE",
        maxShiftHours: 16,
      },
      PAY: {
        rounding: "HALF_UP",
        cutoffWeekday: 1,
        partialDays: "UNCONFIGURED",
        statutoryTreatment: "UNCONFIGURED",
        holidays: "UNCONFIGURED",
        overtime: "REQUIRES_APPROVAL",
        deductionTypes: [],
      },
    };
    for (const key of ["SECURITY", "WORK", "PAY"] as const)
      policies[key] = (
        await c.query(
          "INSERT INTO policy_versions(policy_key,revision,configuration,created_by) VALUES($1,1,$2,$3) RETURNING id",
          [key, JSON.stringify(configs[key]), ids[0]],
        )
      ).rows[0].id;
    await c.query(
      "INSERT INTO company_settings(company_name,security_policy_id,work_policy_id,pay_policy_id) VALUES($1,$2,$3,$4)",
      [
        "Libetario Digital Marketing Services",
        policies.SECURITY,
        policies.WORK,
        policies.PAY,
      ],
    );
    for (let i = 1; i < 3; i++) {
      await c.query(
        "INSERT INTO employee_profiles(user_id,employee_number,legal_name,display_name,designation,start_date) VALUES($1,$2,$3,$3,$4,'2026-10-01')",
        [
          ids[i],
          `DEMO-00${i}`,
          sampleCredentials[i].name,
          i === 1 ? "Developer" : "Designer",
        ],
      );
      await c.query(
        "INSERT INTO employee_rate_history(employee_id,basis,amount,effective_from,expected_daily_seconds,pay_policy_id,created_by) VALUES($1,$2,$3,'2026-10-01',28800,$4,$5)",
        [
          ids[i],
          i === 1 ? "HOURLY" : "DAILY",
          i === 1 ? "150.1250" : "850.0000",
          policies.PAY,
          ids[0],
        ],
      );
      const schedule = (
        await c.query(
          "INSERT INTO employee_schedule_history(employee_id,effective_from,expected_daily_seconds,work_policy_id,created_by) VALUES($1,'2026-10-01',28800,$2,$3) RETURNING id",
          [ids[i], policies.WORK, ids[0]],
        )
      ).rows[0].id;
      for (let d = 1; d <= 7; d++)
        await c.query(
          "INSERT INTO employee_schedule_days(schedule_id,weekday,working_day,start_local,end_local,paid_break_seconds) VALUES($1,$2,$3,$4,$5,$6)",
          [
            schedule,
            d,
            d <= 5,
            d <= 5 ? "09:00" : null,
            d <= 5 ? "17:00" : null,
            d <= 5 ? 1800 : 0,
          ],
        );
    }
    await c.query("COMMIT");
    console.log(
      "Fictitious development accounts created. See README for temporary credentials. Password changes are mandatory.",
    );
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    await c.end();
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await seed();
