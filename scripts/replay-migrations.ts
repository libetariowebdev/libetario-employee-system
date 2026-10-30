import { config } from "dotenv";
config({ path: ".env.test.local", override: true, quiet: true });
import pg from "pg";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
const base = new URL(process.env.MIGRATION_DATABASE_URL!);
if (
  !["localhost", "127.0.0.1"].includes(base.hostname) ||
  !base.pathname.endsWith("_test")
)
  throw new Error("Replay requires the dedicated local test cluster");
const name = "libetario_replay_test_" + randomBytes(8).toString("hex");
if (!/^libetario_replay_test_[a-f0-9]{16}$/.test(name))
  throw new Error("Invalid disposable database name");
const adminUrl = new URL(base);
adminUrl.pathname = "/postgres";
const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
let created = false;
try {
  await admin.query(`CREATE DATABASE ${name} OWNER libetario_migrator`);
  created = true;
  const url = new URL(base);
  url.pathname = "/" + name;
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["node_modules/prisma/build/index.js", "migrate", "deploy"],
      {
        stdio: "inherit",
        env: { ...process.env, MIGRATION_DATABASE_URL: url.toString() },
      },
    );
    child.on("exit", resolve);
    child.on("error", reject);
  });
  if (code !== 0) throw new Error("Migration replay failed");
  const check = new pg.Client({ connectionString: url.toString() });
  await check.connect();
  try {
    const row = (
      await check.query(
        "SELECT count(*)::int AS n,bool_and(c.relrowsecurity) AS secured FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname<>'_prisma_migrations'",
      )
    ).rows[0];
    if (row.n !== 17 || !row.secured)
      throw new Error("Replay schema/RLS mismatch");
  } finally {
    await check.end();
  }
  console.log(
    "Clean migration replay passed: seventeen approved Phase 2 tables, all protected by RLS.",
  );
} finally {
  // The only drop target is the new, random, empty-of-user-data database created above.
  if (created) await admin.query(`DROP DATABASE ${name}`);
  await admin.end();
}
