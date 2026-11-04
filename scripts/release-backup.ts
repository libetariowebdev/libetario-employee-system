import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  rm,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { mfaKeyring } from "../src/lib/mfa-crypto";
import {
  releaseConnection,
  releaseTarget,
  safeOperatorError,
} from "./lib/release-db";
import {
  pgEnvironment,
  postgresBin,
  privateDirectory,
  releaseChildEnv,
  run,
  shaFile,
} from "./lib/release-io";
import { holdQuietShiftGate, openShiftCount } from "./lib/backup-shift-gate";

function setting(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name] ?? String(fallback);
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < min || value > max)
    throw new Error("Invalid setting " + name);
  return value;
}

function manilaMinute() {
  return minute(
    manilaFormat({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
  );
}
const manilaFormat = (parts: Intl.DateTimeFormatOptions, time = new Date()) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Manila",
    ...parts,
  }).format(time);
function minute(value: string) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))
    throw new Error("Use HH:MM for backup window settings");
  const [hour, min] = value.split(":").map(Number);
  return 60 * hour + min;
}

async function remoteHash(config: string[], remote: string, timeout: number) {
  const hash = createHash("sha256");
  const child = spawn("/usr/bin/rclone", [...config, "cat", remote], {
    env: releaseChildEnv,
    stdio: ["ignore", "pipe", "ignore"],
    signal: AbortSignal.timeout(timeout),
  });
  const done = new Promise<boolean>((resolve) => {
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
  for await (const bytes of child.stdout) hash.update(bytes);
  if (!(await done)) throw new Error("Offsite backup read-back failed");
  return hash.digest("hex");
}

async function main() {
  const { values } = parseArgs({
    options: {
      "allow-production": { type: "boolean" },
      "on-demand": { type: "boolean" },
      "leave-stopped": { type: "boolean" },
    },
  });
  const target = releaseTarget(values["allow-production"] === true);
  if (
    process.platform !== "linux" ||
    process.getuid?.() !== 0 ||
    target.target === "scratch"
  )
    throw new Error("Run backup through the Linux release operator as root");
  if (values["leave-stopped"] && !values["on-demand"])
    throw new Error("Only a deployment backup can retain maintenance");
  const name = target.target;
  const appPort = name === "prod" ? 3100 : 3101;
  if (process.env.APP_PORT !== String(appPort))
    throw new Error("App port must match the release service and Caddy target");
  const wait = setting("BACKUP_WAIT_SECONDS", 900, 0, 3600);
  const poll = setting("BACKUP_POLL_SECONDS", 15, 1, 60);
  const capture = setting("BACKUP_CAPTURE_SECONDS", 900, 30, 7200) * 1000;
  const transfer = setting("BACKUP_TRANSFER_SECONDS", 3600, 60, 14400) * 1000;
  const from = minute(process.env.BACKUP_WINDOW_START ?? "02:30");
  const until = minute(process.env.BACKUP_WINDOW_END ?? "03:30");
  if (from === until) throw new Error("Backup window endpoints must differ");
  const inWindow = () => {
    if (values["on-demand"]) return true;
    const now = manilaMinute();
    return from < until
      ? now >= from && now < until
      : now >= from || now < until;
  };
  const root = await privateDirectory(process.env.PRIVATE_UPLOAD_ROOT);
  if (root !== `/var/lib/libetario/${name}/private`)
    throw new Error("Private root must match the release target");
  const base = await privateDirectory(
    `/var/lib/libetario/${name}/backup-scratch`,
  );
  const remote = process.env.BACKUP_REMOTE ?? "";
  if (
    !/^[a-zA-Z0-9_-]+:[a-zA-Z0-9_/-]+$/.test(remote) ||
    !remote.endsWith("/" + name)
  )
    throw new Error(
      "Configure a distinct rclone remote prefix ending in the target name",
    );
  const recipients = `/etc/libetario/${name}/backup-recipients.txt`;
  if (!(await lstat(recipients)).isFile())
    throw new Error("Provide the protected age recipients file");
  const rclone = ["--config", `/etc/libetario/${name}/rclone.conf`];
  const tag = (await readFile("RELEASE_TAG", "utf8")).trim();
  if (!/^v[0-9][a-zA-Z0-9._-]{0,49}$/.test(tag))
    throw new Error("Run from a tagged release");
  const keyIds = [...mfaKeyring().keys.keys()];
  const marker = `/run/libetario/${name}/maintenance`;
  const unit = `libetario@${name}.service`;
  const control = (action: string) =>
    run("/usr/bin/systemctl", [action, unit], 90_000);
  const started = performance.now();
  const c = await releaseConnection(target);
  let ownsMarker = false,
    stopAttempted = false,
    retained = false,
    locked = false,
    interrupted = false;
  let scratch: string | undefined;
  const onSignal = () => {
    interrupted = true;
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  const checkSignal = () => {
    if (interrupted) throw new Error("Backup interrupted");
  };
  async function reopen() {
    if (stopAttempted) {
      await control("start");
      await control("is-active");
      let ready = false;
      const deadline = performance.now() + 25_000;
      while (performance.now() < deadline) {
        const response = await fetch(`http://127.0.0.1:${appPort}/login`, {
          signal: AbortSignal.timeout(1_000),
        }).catch(() => null);
        if (response?.ok) {
          await response.body?.cancel();
          ready = true;
          break;
        }
        await response?.body?.cancel();
        await sleep(500);
      }
      if (!ready)
        throw new Error("App did not become ready. Maintenance was retained.");
      stopAttempted = false;
    }
    if (ownsMarker) {
      await unlink(marker);
      ownsMarker = false;
    }
  }
  try {
    await control("is-active");
    const {
      rows: [db],
    } = await c.query(
      "SELECT pg_database_size(current_database())::text size, current_setting('server_version') version",
    );
    const rawBytes = await run("/usr/bin/du", ["-sb", root], 30_000);
    const fileBytes = BigInt(rawBytes.split(/\s+/)[0]);
    const disk = await statfs(base, { bigint: true });
    if (
      disk.bavail * disk.bsize <
      4n * (fileBytes + BigInt(db.size)) + 256n * 1024n * 1024n
    )
      throw new Error("Insufficient backup scratch space");
    for (;;) {
      checkSignal();
      if (!inWindow())
        throw new Error("Backup skipped outside the configured window");
      if ((await openShiftCount(c)) === 0) {
        locked = await holdQuietShiftGate(c);
        if (locked && inWindow()) {
          const handle = await open(marker, "wx", 0o644);
          ownsMarker = true;
          await handle.close();
          break;
        }
        if (locked) await c.query("ROLLBACK");
        locked = false;
      }
      const remaining = wait * 1000 - (performance.now() - started);
      if (remaining <= 0)
        throw new Error("Backup skipped because attendance was active or busy");
      await sleep(Math.min(poll * 1000, remaining));
    }
    checkSignal();
    stopAttempted = true;
    await control("stop");
    const {
      rows: [writers],
    } = await c.query(
      "SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND usename IN ('libetario_runtime','libetario_auth')",
    );
    if (writers.n !== 0)
      throw new Error("App database writers are still connected");
    await c.query("COMMIT");
    locked = false;
    const at = new Date().toISOString();
    const id = `${name}-${at.replace(/[:.]/g, "-")}-${randomBytes(6).toString("hex")}`;
    scratch = await mkdtemp(path.join(base, "capture-"));
    const pgEnv = await pgEnvironment(target, scratch);
    const dump = path.join(scratch, "database.dump");
    const files = path.join(scratch, "private.tar");
    const deadline = performance.now() + capture;
    const budget = () => Math.max(1, Math.floor(deadline - performance.now()));
    await run(
      postgresBin + "pg_dump",
      ["-w", "-Fc", "-f", dump],
      budget(),
      pgEnv,
    );
    checkSignal();
    await run("/usr/bin/tar", ["-cf", files, "-C", root, "."], budget());
    if (!values["leave-stopped"]) await reopen();
    checkSignal();
    const { rows: migrations } = await c.query(
      'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
    );
    const manifest = {
      format: 1,
      id,
      at,
      environment: name,
      database: target.database,
      release: tag,
      postgres: db.version,
      roles: ["libetario_migrator", "libetario_runtime", "libetario_auth"],
      migrations: migrations.map((row) => row.migration_name),
      keyIds,
      files: {
        "database.dump": await shaFile(dump),
        "private.tar": await shaFile(files),
      },
    };
    await writeFile(
      path.join(scratch, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    const tar = path.join(scratch, "bundle.tar");
    const encrypted = path.join(scratch, "bundle.age");
    await run(
      "/usr/bin/tar",
      [
        "-cf",
        tar,
        "-C",
        scratch,
        "manifest.json",
        "database.dump",
        "private.tar",
      ],
      transfer,
    );
    await run(
      "/usr/bin/age",
      ["-R", recipients, "-o", encrypted, tar],
      transfer,
    );
    const digest = await shaFile(encrypted);
    const stamp = new Date(at);
    const classes = values["leave-stopped"] ? ["predeploy"] : ["daily"];
    if (
      !values["leave-stopped"] &&
      manilaFormat({ weekday: "short" }, stamp) === "Sun"
    )
      classes.push("weekly");
    if (
      !values["leave-stopped"] &&
      manilaFormat({ day: "2-digit" }, stamp) === "01"
    )
      classes.push("monthly");
    for (const group of classes) {
      checkSignal();
      const destination = remote + "/" + group + "/" + id + ".age";
      await run(
        "/usr/bin/rclone",
        [...rclone, "copyto", "--immutable", encrypted, destination],
        transfer,
      );
      if ((await remoteHash(rclone, destination, transfer)) !== digest)
        throw new Error("Offsite backup hash mismatch");
    }
    checkSignal();
    console.log(
      `Offsite backup verified ${id} ${classes.join(",")} SHA256 ${digest}`,
    );
    retained = values["leave-stopped"] === true;
  } finally {
    try {
      if (locked) await c.query("ROLLBACK");
    } finally {
      await c.end().catch(() => {});
      try {
        if (!retained) await reopen();
      } finally {
        if (
          scratch &&
          path.dirname(scratch) === base &&
          (await lstat(scratch)).isDirectory()
        )
          await rm(scratch, { recursive: true, force: true });
      }
    }
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
  }
}

main().catch((error: unknown) => {
  console.error(safeOperatorError(error));
  process.exitCode = 1;
});
