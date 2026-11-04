import { config } from "dotenv";
config({
  path: process.argv.includes("--test") ? ".env.test.local" : ".env",
  override: true,
  quiet: true,
});
import { assertOperatorTarget, operatorConnection } from "./lib/operator-db";
const url = assertOperatorTarget(
  process.env.MIGRATION_DATABASE_URL,
  process.argv.includes("--allow-production"),
);
if (process.argv.includes("--test") && url.pathname !== "/libetario_test")
  throw new Error("Dedicated test database required");
const c = await operatorConnection(url);
try {
  console.log(
    "Attendance due reconciliation:",
    (await c.query("SELECT private.attendance_reconcile_due() count")).rows[0]
      .count,
    "changed records (maximum 100).",
  );
} finally {
  await c.end();
}
