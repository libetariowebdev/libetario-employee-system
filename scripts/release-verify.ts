import pg from "pg";
import {
  releaseConnection,
  releaseTarget,
  safeOperatorError,
} from "./lib/release-db";

async function main() {
  const target = releaseTarget(
    process.argv.length === 3 && process.argv[2] === "--allow-production",
  );
  const c = await releaseConnection(target);
  try {
    const {
      rows: [inventory],
    } = await c.query(`
      SELECT count(*)::int n,bool_and(relrowsecurity AND pg_get_userbyid(relowner)='libetario_migrator') ok
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' AND c.relname<>'_prisma_migrations'
    `);
    const {
      rows: [roles],
    } = await c.query(`
      SELECT count(*)::int n,bool_and(rolcanlogin AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolbypassrls)
        AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid)) ok
      FROM pg_roles r WHERE rolname IN ('libetario_runtime','libetario_auth')
    `);
    const {
      rows: [grants],
    } = await c.query(`
      SELECT NOT (
        has_column_privilege('libetario_runtime','users','password_hash','SELECT') OR
        has_column_privilege('libetario_runtime','sessions','token_hash','SELECT') OR
        has_table_privilege('libetario_auth','payroll_lines','SELECT') OR
        has_column_privilege('libetario_auth','payroll_lines','net','SELECT') OR
        has_table_privilege('libetario_auth','employee_profiles','SELECT') OR
        has_column_privilege('libetario_auth','employee_profiles','legal_name','SELECT') OR
        has_table_privilege('libetario_runtime','payments','UPDATE,DELETE,TRUNCATE') OR
        has_table_privilege('libetario_runtime','payroll_lines','UPDATE,DELETE,TRUNCATE') OR
        has_table_privilege('libetario_runtime','audit_log','INSERT,UPDATE,DELETE,TRUNCATE') OR
        has_table_privilege('libetario_auth','audit_log','INSERT,UPDATE,DELETE,TRUNCATE') OR
        has_schema_privilege('libetario_runtime','public','CREATE') OR
        has_schema_privilege('libetario_auth','public','CREATE')
      ) ok
    `);
    if (
      inventory.n !== 43 ||
      !inventory.ok ||
      roles.n !== 2 ||
      !roles.ok ||
      !grants.ok
    )
      throw new Error("Release role, grant or RLS inventory failed");
  } finally {
    await c.end();
  }
  for (const [key, role] of [
    ["DATABASE_URL", "libetario_runtime"],
    ["AUTH_DATABASE_URL", "libetario_auth"],
  ]) {
    const url = new URL(process.env[key] ?? "");
    if (
      url.protocol !== "postgresql:" ||
      url.username !== role ||
      url.hostname !== target.url.hostname ||
      url.port !== target.port ||
      url.pathname !== "/" + target.database ||
      url.search ||
      url.hash
    )
      throw new Error(
        "App role URL must match the release database and expected login",
      );
    const app = new pg.Client({
      connectionString: url.href,
      connectionTimeoutMillis: 5000,
    });
    await app.connect();
    try {
      if (role === "libetario_runtime") {
        const own = await app.query(
          "SELECT id FROM payroll_lines UNION ALL SELECT user_id FROM employee_profiles LIMIT 1",
        );
        if (own.rowCount)
          throw new Error("Anonymous runtime data denial failed");
      } else {
        const check = await app.query("SELECT current_user AS role");
        if (check.rows[0].role !== role)
          throw new Error("Auth connection used the wrong login");
      }
    } finally {
      await app.end();
    }
  }
  console.log(
    "43 RLS tables, owner and restricted role grants, both app connections and anonymous denial verified.",
  );
}

main().catch((error: unknown) => {
  console.error(safeOperatorError(error));
  process.exitCode = 1;
});
