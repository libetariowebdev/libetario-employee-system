import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import pg from "pg";

if (process.env.NODE_ENV === "production")
  throw new Error("Local bootstrap is forbidden in production");
const settings = JSON.parse(await readFile(".local/cluster.json", "utf8")) as {
  password: string;
  port: number;
};
const owner = new pg.Client({
  host: "127.0.0.1",
  port: settings.port,
  user: "libetario_migrator",
  password: settings.password,
  database: "postgres",
});
await owner.connect();
const values: Record<string, string> = {};
for (const role of ["libetario_runtime", "libetario_auth"]) {
  const exists = await owner.query("select 1 from pg_roles where rolname=$1", [
    role,
  ]);
  if (exists.rowCount) {
    throw new Error(
      "Roles already exist. Preserve existing .env files; do not rerun bootstrap.",
    );
  }
  const password = randomBytes(32).toString("hex");
  await owner.query(
    `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
  );
  values[role] = password;
}
for (const database of ["libetario", "libetario_test"]) {
  const exists = await owner.query(
    "select 1 from pg_database where datname=$1",
    [database],
  );
  if (!exists.rowCount)
    await owner.query(`CREATE DATABASE ${database} OWNER libetario_migrator`);
  await owner.query(`REVOKE CONNECT ON DATABASE ${database} FROM PUBLIC`);
  await owner.query(
    `GRANT CONNECT ON DATABASE ${database} TO libetario_runtime,libetario_auth`,
  );
}
function url(user: string, password: string, database: string) {
  return `postgresql://${user}:${password}@127.0.0.1:${settings.port}/${database}`;
}
const secret = randomBytes(48).toString("hex");
for (const [database, filename] of [
  ["libetario", ".env"],
  ["libetario_test", ".env.test.local"],
]) {
  const text =
    [
      `DATABASE_URL=${url("libetario_runtime", values.libetario_runtime, database)}`,
      `AUTH_DATABASE_URL=${url("libetario_auth", values.libetario_auth, database)}`,
      `MIGRATION_DATABASE_URL=${url("libetario_migrator", settings.password, database)}`,
      "APP_ORIGIN=http://127.0.0.1:3000",
      `SESSION_SECRET=${secret}`,
      "TRUST_PROXY=false",
    ].join("\n") + "\n";
  await writeFile(filename, text, { flag: "wx", mode: 0o600 });
}
await owner.end();
console.log(
  "Dedicated dev/test databases and restricted roles created. Local secrets saved to ignored environment files.",
);
