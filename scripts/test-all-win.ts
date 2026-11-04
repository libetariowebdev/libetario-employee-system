import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";

if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error(
    "This runner requires the project's Windows x64 PostgreSQL distribution",
  );
const require = createRequire(import.meta.url);
const embedded = createRequire(require.resolve("embedded-postgres"));
const binaries = (await import(
  pathToFileURL(embedded.resolve("@embedded-postgres/windows-x64")).href
)) as {
  initdb: string;
  postgres: string;
  pg_ctl: string;
};
const repo = await realpath(process.cwd());
const temp = await realpath(tmpdir());
const scratch = await mkdtemp(path.join(temp, "libetario-test-"));
const checkout = path.join(scratch, "checkout");
const isolated = path.resolve(scratch);
if (
  path.dirname(isolated) !== temp ||
  !path.basename(isolated).startsWith("libetario-test-") ||
  isolated.toLowerCase().startsWith(repo.toLowerCase() + path.sep)
) {
  throw new Error("Unsafe disposable test directory");
}
const children = new Set<ChildProcess>();
const replay = process.argv.includes("--replay");
let interrupted = false;
let stopping = false;

// Deliberately omit inherited app configuration, dotenv options and secrets.
const env: NodeJS.ProcessEnv = { NODE_ENV: "development" };
for (const key of Object.keys(process.env)) {
  if (
    /^(path|pathext|systemroot|windir|comspec|temp|tmp|userprofile|appdata|localappdata|programfiles(?:\(x86\))?)$/i.test(
      key,
    )
  ) {
    env[key] = process.env[key];
  } else {
    delete process.env[key];
  }
}
env.NEXT_TELEMETRY_DISABLED = "1";
env.CI = "true";

function run(
  executable: string,
  args: string[],
  childEnv = env,
  quiet = false,
) {
  if (interrupted) throw new Error("Test run interrupted");
  const child = spawn(executable, args, {
    cwd: checkout,
    env: childEnv,
    stdio: quiet ? "ignore" : "inherit",
    windowsHide: true,
  });
  children.add(child);
  const done = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  }).finally(() => children.delete(child));
  return { child, done };
}

async function command(
  executable: string,
  args: string[],
  childEnv = env,
  quiet = false,
) {
  const code = await run(executable, args, childEnv, quiet).done;
  if (code !== 0) throw new Error(`Isolated command failed (exit ${code})`);
}

const allocatedPorts = new Set<number>();
function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createServer().once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      if (!address || typeof address === "string") {
        socket.close();
        reject(new Error("Cannot allocate an isolated port"));
        return;
      }
      socket.close((err) => {
        if (err) return reject(err);
        if (allocatedPorts.has(address.port))
          return void availablePort().then(resolve, reject);
        allocatedPorts.add(address.port);
        resolve(address.port);
      });
    });
  });
}

async function stopChildren() {
  await Promise.all(
    [...children].map((child) => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null)
        return;
      return new Promise<void>((resolve) => {
        const kill = spawn(
          path.join(
            env.SystemRoot ?? env.SYSTEMROOT ?? "C:/Windows",
            "System32",
            "taskkill.exe",
          ),
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" },
        );
        kill.once("error", () => resolve());
        kill.once("close", () => resolve());
      });
    }),
  );
}

async function cleanup() {
  if (stopping) return;
  stopping = true;
  await stopChildren();
  // The node_modules junction must be detached before recursive cleanup.
  const deps = path.join(checkout, "node_modules");
  if ((await lstat(deps).catch(() => null))?.isSymbolicLink()) {
    await rm(deps);
  }
  if ((await realpath(scratch).catch(() => null)) === isolated) {
    await rm(isolated, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 250,
    });
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    interrupted = true;
    void stopChildren();
  });
}

async function copySources() {
  await mkdir(checkout);
  for (const name of [
    "src",
    "prisma",
    "scripts",
    "tests",
    "public",
    "package.json",
    "pnpm-lock.yaml",
    "AGENTS.md",
    "next-env.d.ts",
    "tsconfig.json",
    "next.config.ts",
    "postcss.config.mjs",
    "prisma.config.ts",
  ]) {
    const input = path.join(repo, name);
    if (!(await lstat(input).catch(() => null))) continue;
    await cp(input, path.join(checkout, name), {
      recursive: true,
      filter: async (source) => {
        const stat = await lstat(source);
        if (stat.isSymbolicLink())
          throw new Error(
            "Linked source is not allowed in the disposable checkout",
          );
        return (
          !/^\.env(?:\.|$)/.test(path.basename(source)) &&
          ![".local", "generated"].includes(path.basename(source))
        );
      },
    });
  }
  await symlink(
    await realpath(path.join(repo, "node_modules")),
    path.join(checkout, "node_modules"),
    "junction",
  );
  await mkdir(path.join(checkout, ".local"));
}

async function provision(name: string, origin: string) {
  const port = await availablePort();
  const password = randomBytes(32).toString("hex");
  const runtimePassword = randomBytes(32).toString("hex");
  const authPassword = randomBytes(32).toString("hex");
  const key = randomBytes(32).toString("hex");
  const directory = path.join(scratch, `pg-${name}`);
  const passwordFile = path.join(scratch, `init-${name}`);
  await writeFile(passwordFile, password + "\n", { mode: 0o600, flag: "wx" });
  try {
    await command(
      binaries.initdb,
      [
        "--pgdata",
        directory,
        "--auth=scram-sha-256",
        "--username=libetario_migrator",
        "--pwfile",
        passwordFile,
        "--encoding=UTF8",
        "--locale=C",
      ],
      env,
      true,
    );
  } finally {
    await rm(passwordFile, { force: true });
  }
  const database = run(
    binaries.postgres,
    [
      "-D",
      directory,
      "-h",
      "127.0.0.1",
      "-p",
      String(port),
      "-c",
      "shared_buffers=32MB",
    ],
    env,
    true,
  );
  void database.done.catch(() => {});
  const url = (user: string, credential: string, database = "libetario_test") =>
    `postgresql://${user}:${credential}@127.0.0.1:${port}/${database}`;
  const until = Date.now() + 30_000;
  let owner: pg.Client | undefined;
  while (
    !interrupted &&
    Date.now() < until &&
    database.child.exitCode === null &&
    database.child.signalCode === null
  ) {
    const client = new pg.Client({
      connectionString: url("libetario_migrator", password, "postgres"),
      connectionTimeoutMillis: 1000,
    });
    try {
      await client.connect();
      owner = client;
      break;
    } catch {
      await client.end().catch(() => {});
      await delay(150);
    }
  }
  if (!owner) throw new Error("Disposable PostgreSQL failed readiness");
  console.log(`Isolated ${name} PostgreSQL ready on port ${port}`);
  try {
    await owner.query(
      `CREATE ROLE libetario_runtime LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    await owner.query(
      `CREATE ROLE libetario_auth LOGIN PASSWORD '${authPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    await owner.query(
      "CREATE DATABASE libetario_test OWNER libetario_migrator",
    );
    await owner.query("REVOKE CONNECT ON DATABASE libetario_test FROM PUBLIC");
    await owner.query(
      "GRANT CONNECT ON DATABASE libetario_test TO libetario_runtime,libetario_auth",
    );
  } finally {
    await owner.end();
  }
  const testVars = {
    MIGRATION_DATABASE_URL: url("libetario_migrator", password),
    DATABASE_URL: url("libetario_runtime", runtimePassword),
    AUTH_DATABASE_URL: url("libetario_auth", authPassword),
    SESSION_SECRET: randomBytes(48).toString("hex"),
    APP_ORIGIN: origin,
    HTTP_TEST_ORIGIN: origin,
    TRUST_PROXY: "false",
    MFA_ACTIVE_KEY_ID: "disposable",
    MFA_ENCRYPTION_KEYS: JSON.stringify({
      disposable: randomBytes(32).toString("base64"),
    }),
    PRIVATE_UPLOAD_ROOT: path
      .join(scratch, `uploads-${name}`)
      .replaceAll("\\", "/"),
    UPLOAD_VALIDATION_KEY: key,
  };
  const stageEnv = {
    ...env,
    ...testVars,
    DOTENV_CONFIG_PATH: ".env.test.local",
  };
  const envText =
    Object.entries(testVars)
      .map(([k, v]) => `${k}='${v}'`)
      .join("\n") + "\n";
  await command(
    process.execPath,
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    stageEnv,
  );
  if (!replay) {
    await command(
      process.execPath,
      ["--import", "tsx", "prisma/seed.ts"],
      stageEnv,
    );
    const db = new pg.Client({
      connectionString: stageEnv.MIGRATION_DATABASE_URL,
    });
    await db.connect();
    try {
      await db.query(
        "UPDATE company_settings SET upload_validation_key_hash=$1 WHERE id=1",
        [createHash("sha256").update(key).digest("hex")],
      );
    } finally {
      await db.end();
    }
  }
  return { stageEnv, envText, directory };
}

async function waitForServer(
  origin: string,
  child: ChildProcess,
  secret: string,
) {
  const until = Date.now() + 90_000;
  while (Date.now() < until && child.exitCode === null && !interrupted) {
    const result = await fetch(origin + "/login", {
      signal: AbortSignal.timeout(3500),
    }).catch(() => null);
    if (result?.ok && (await result.text()).includes("Sign in to workspace")) {
      const response = await fetch(origin + "/api/auth/csrf", {
        signal: AbortSignal.timeout(3500),
      }).catch(() => null);
      if (response?.ok) {
        const body = (await response.json().catch(() => null)) as {
          csrf?: string;
        } | null;
        const [nonce, signature] =
          typeof body?.csrf === "string" ? body.csrf.split(".") : [];
        if (
          nonce &&
          signature ===
            createHmac("sha256", secret)
              .update("anonymous:" + nonce)
              .digest("hex")
        )
          return;
      }
    }
    await delay(350);
  }
  throw new Error("Disposable Next server failed readiness");
}

async function suite(name: "test" | "test:http", stageEnv: NodeJS.ProcessEnv) {
  const { scripts } = JSON.parse(
    await readFile(path.join(checkout, "package.json"), "utf8"),
  ) as {
    scripts: Record<"test" | "test:http", string>;
  };
  const [program, ...args] = scripts[name].trim().split(/\s+/);
  if (program !== "node" || !args.includes("--test"))
    throw new Error("Expected a Node test entry point");
  return command(process.execPath, args, stageEnv);
}

try {
  console.log("Disposable run " + path.basename(scratch));
  await copySources();
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const unit = await provision("unit", "http://127.0.0.1:3000");
  if (replay) {
    const db = new pg.Client({
      connectionString: unit.stageEnv.MIGRATION_DATABASE_URL,
    });
    await db.connect();
    try {
      const row = (
        await db.query(`SELECT count(*)::int AS count,bool_and(c.relrowsecurity) AS secured
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind='r' AND c.relname<>'_prisma_migrations'`)
      ).rows[0];
      if (row.count !== 43 || !row.secured)
        throw new Error("Expected 43 RLS-enabled application tables");
      console.log(
        "Disposable replay passed with 43 RLS-enabled application tables",
      );
    } finally {
      await db.end();
    }
  } else {
    const http = await provision("http", origin);
    await command(
      process.execPath,
      ["node_modules/prisma/build/index.js", "generate", "--no-hints"],
      unit.stageEnv,
    );
    const server = run(
      process.execPath,
      [
        "node_modules/next/dist/bin/next",
        "dev",
        "--webpack",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      http.stageEnv,
    );
    void server.done.catch(() => {});
    await waitForServer(origin, server.child, http.stageEnv.SESSION_SECRET);
    console.log(`Isolated HTTP server ready on port ${port}`);
    const file = path.join(checkout, ".env.test.local");
    await writeFile(file, unit.envText, { mode: 0o600 });
    await suite("test", unit.stageEnv);
    await command(
      binaries.pg_ctl,
      ["stop", "-D", unit.directory, "-m", "fast", "-w", "-t", "15"],
      env,
      true,
    );
    await writeFile(file, http.envText, { mode: 0o600 });
    await suite("test:http", http.stageEnv);
    console.log("Both isolated test suites passed");
  }
} catch (error) {
  process.exitCode = interrupted ? 130 : 1;
  console.error(
    error instanceof Error ? error.message : "Disposable tests failed",
  );
} finally {
  await cleanup();
}
