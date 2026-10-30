import EmbeddedPostgres from "embedded-postgres";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

await mkdir(".local", { recursive: true });
const file = ".local/cluster.json";
let settings: { password: string; port: number };
try {
  settings = JSON.parse(await readFile(file, "utf8"));
} catch {
  settings = { password: randomBytes(32).toString("hex"), port: 55432 };
  await writeFile(file, JSON.stringify(settings), { mode: 0o600 });
}
const pg = new EmbeddedPostgres({
  databaseDir: path.resolve(".local/postgres"),
  user: "libetario_migrator",
  password: settings.password,
  port: settings.port,
  persistent: true,
  authMethod: "scram-sha-256",
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  postgresFlags: ["-h", "127.0.0.1"],
  onLog: () => {},
  onError: (e: unknown) =>
    console.error(String(e).replaceAll(settings.password, "[redacted]")),
});
try {
  await readFile(".local/postgres/PG_VERSION");
} catch {
  await pg.initialise();
}
await pg.start();
console.log(
  `Workspace-only PostgreSQL ready on 127.0.0.1:${settings.port}. Keep this process running.`,
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await pg.stop();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 60_000);
