import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { mfaKeyring } from "../src/lib/mfa-crypto";
import {
  releaseAudit,
  releaseConnection,
  releaseTarget,
  safeOperatorError,
} from "./lib/release-db";
import {
  pgEnvironment,
  postgresBin,
  privateDirectory,
  run,
  shaFile,
} from "./lib/release-io";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const manifestSchema = z.strictObject({
  format: z.literal(1),
  id: z.string(),
  at: z.iso.datetime(),
  environment: z.enum(["stage", "prod"]),
  database: z.string(),
  release: z.string(),
  postgres: z.string().startsWith("18."),
  roles: z.tuple([
    z.literal("libetario_migrator"),
    z.literal("libetario_runtime"),
    z.literal("libetario_auth"),
  ]),
  migrations: z.array(z.string()),
  keyIds: z.array(z.string()).min(1),
  files: z.strictObject({ "database.dump": sha, "private.tar": sha }),
});

async function main() {
  const { values } = parseArgs({
    options: {
      "allow-production": { type: "boolean" },
      "prepare-cutover": { type: "boolean" },
      "backup-id": { type: "string" },
      sha256: { type: "string" },
    },
  });
  const target = releaseTarget(values["allow-production"] === true);
  if (process.platform !== "linux" || process.getuid?.() !== 0)
    throw new Error("Run restore on the isolated Linux target as root");
  if ((target.target !== "scratch") !== (values["prepare-cutover"] === true))
    throw new Error(
      "Default restore target is scratch. A clean cutover cluster requires --prepare-cutover",
    );
  const id = values["backup-id"] ?? "";
  if (!/^(?:prod|stage)-[0-9TZ-]{24}-[a-f0-9]{12}$/.test(id))
    throw new Error("Provide the exact verified backup ID");
  const digest = sha.parse(values.sha256);
  const key = process.env.UPLOAD_VALIDATION_KEY;
  if (!key || !/^[a-f0-9]{64}$/.test(key))
    throw new Error("Provide a fresh upload capability for the restored app");
  const keys = mfaKeyring().keys;
  const root = `/var/lib/libetario/${target.target}`;
  const base = await privateDirectory(root + "/restore-scratch");
  const input = path.join(base, id + ".age");
  const identity = `/etc/libetario/${target.target}/restore-identity.txt`;
  for (const file of [input, identity]) {
    const info = await lstat(file);
    if (
      !info.isFile() ||
      (info.mode & 0o077) !== 0 ||
      (await realpath(file)) !== file
    )
      throw new Error(
        "Expected private, regular archive and recovery identity files",
      );
  }
  const finalRoot = root + "/restored-private";
  if (
    await lstat(finalRoot).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    )
  )
    throw new Error("The restored-private output path must be absent");
  if (target.target !== "scratch") {
    if (!(await lstat(`/run/libetario/${target.target}/maintenance`)).isFile())
      throw new Error("Enable maintenance before preparing cutover");
    if (
      (await run(
        "/usr/bin/systemctl",
        [
          "show",
          "-p",
          "ActiveState",
          "--value",
          `libetario@${target.target}.service`,
        ],
        10_000,
      )) !== "inactive"
    )
      throw new Error(
        "Stop the target application service before preparing cutover",
      );
  }
  const duration = 4 * 60 * 60 * 1000;
  if ((await shaFile(input)) !== digest)
    throw new Error(
      "Encrypted archive does not match the independently recorded hash",
    );
  const scratch = await mkdtemp(path.join(base, "restore-"));
  try {
    const tar = path.join(scratch, "bundle.tar");
    const bundle = path.join(scratch, "bundle");
    const files = path.join(scratch, "private");
    await mkdir(bundle, { mode: 0o700 });
    await mkdir(files, { mode: 0o700 });
    await run(
      "/usr/bin/age",
      ["-d", "-i", identity, "-o", tar, input],
      duration,
    );
    await run(
      "/usr/bin/python3",
      ["scripts/release-unpack.py", "bundle", tar, bundle],
      duration,
    );
    const manifest = manifestSchema.parse(
      JSON.parse(await readFile(path.join(bundle, "manifest.json"), "utf8")),
    );
    const tag = (await readFile("RELEASE_TAG", "utf8")).trim();
    const migrations = (
      await readdir("prisma/migrations", { withFileTypes: true })
    )
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    if (
      manifest.id !== id ||
      manifest.database !== "libetario_" + manifest.environment ||
      tag !== manifest.release ||
      JSON.stringify(manifest.migrations) !== JSON.stringify(migrations) ||
      !manifest.keyIds.every((keyId) => keys.has(keyId)) ||
      (target.target !== "scratch" && manifest.environment !== target.target)
    )
      throw new Error(
        "Backup target, release, migrations or keyring did not match",
      );
    for (const [file, hash] of Object.entries(manifest.files))
      if ((await shaFile(path.join(bundle, file))) !== hash)
        throw new Error("Backup member checksum mismatch");
    await run(
      "/usr/bin/python3",
      [
        "scripts/release-unpack.py",
        "private",
        path.join(bundle, "private.tar"),
        files,
      ],
      duration,
    );
    const empty = await releaseConnection(target, true);
    await empty.end();
    const pgEnv = await pgEnvironment(target, scratch);
    await run(
      postgresBin + "pg_restore",
      [
        "-w",
        "--dbname",
        target.database,
        "--exit-on-error",
        "--single-transaction",
        path.join(bundle, "database.dump"),
      ],
      duration,
      pgEnv,
    );
    const c = await releaseConnection(target);
    try {
      const {
        rows: [schema],
      } = await c.query(`
        SELECT count(*)::int count,bool_and(c.relrowsecurity) secured
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind='r' AND c.relname<>'_prisma_migrations'
      `);
      if (schema.count !== 43 || !schema.secured)
        throw new Error("Restored RLS inventory does not match");
      const stored = await c.query(
        "SELECT storage_key, purpose, sha256, size_bytes FROM file_objects WHERE state='AVAILABLE'",
      );
      for (const row of stored.rows) {
        if (
          !/^[a-f0-9]{64}$/.test(row.storage_key) ||
          !["WORK", "PAYSLIP"].includes(row.purpose)
        )
          throw new Error("Unexpected restored file metadata");
        const file = path.join(
          files,
          row.purpose === "PAYSLIP" ? "payslip-objects" : "objects",
          row.storage_key + ".bin",
        );
        const info = await lstat(file);
        if (
          !info.isFile() ||
          info.nlink !== 1 ||
          String(info.size) !== String(row.size_bytes) ||
          (await shaFile(file)) !== row.sha256
        )
          throw new Error(
            "An available restored file failed integrity verification",
          );
      }
      await c.query("BEGIN");
      await c.query(
        "UPDATE sessions SET revoked_at=coalesce(revoked_at,private.security_now()),revocation_reason='RESTORE' WHERE revoked_at IS NULL OR revocation_reason='EXPIRED'",
      );
      await c.query(
        "UPDATE auth_challenges SET invalidated_at=private.security_now() WHERE consumed_at IS NULL AND invalidated_at IS NULL",
      );
      await c.query(
        "UPDATE credential_resets SET consumed_at=private.security_now() WHERE consumed_at IS NULL",
      );
      const changed = await c.query(
        "UPDATE company_settings SET upload_validation_key_hash=$1 WHERE id=1",
        [createHash("sha256").update(key).digest("hex")],
      );
      if (changed.rowCount !== 1)
        throw new Error("Restored company settings are incomplete");
      await releaseAudit(c, "release.restore_verified", {
        backupId: id,
        target: target.target,
        files: stored.rowCount,
      });
      await c.query("COMMIT");
      await rename(files, finalRoot);
      console.log(
        `Verified restore ${id}. Checked ${stored.rowCount} available files. App remains offline.`,
      );
    } catch (error) {
      await c.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      await c.end();
    }
  } finally {
    if (path.dirname(scratch) === base && (await lstat(scratch)).isDirectory())
      await rm(scratch, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof SyntaxError || error instanceof z.ZodError
      ? "Invalid restore manifest or digest"
      : safeOperatorError(error),
  );
  process.exitCode = 1;
});
