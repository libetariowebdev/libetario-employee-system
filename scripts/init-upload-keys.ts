import { readFile, writeFile } from "node:fs/promises";
import { parse } from "dotenv";
import { randomBytes, createHash } from "node:crypto";
import path from "node:path";
import { assertOperatorTarget, operatorConnection } from "./lib/operator-db";
for (const name of [".env", ".env.test.local"]) {
  const original = await readFile(name, "utf8"),
    env = parse(original);
  const url = assertOperatorTarget(
    env.MIGRATION_DATABASE_URL,
    process.argv.includes("--allow-production"),
  );
  const rotating = process.argv.includes("--rotate");
  const key = rotating
    ? randomBytes(32).toString("hex")
    : (env.UPLOAD_VALIDATION_KEY ?? randomBytes(32).toString("hex"));
  if (!/^[a-f0-9]{64}$/.test(key))
    throw new Error("Invalid upload key; preserve and repair configuration");
  const root =
    env.PRIVATE_UPLOAD_ROOT ??
    path
      .resolve(
        ".local",
        name === ".env" ? "private-uploads" : "private-uploads-test",
      )
      .replaceAll("\\", "/");
  const c = await operatorConnection(url);
  try {
    const hash = createHash("sha256").update(key).digest("hex");
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(72426820::bigint)");
    const row = (
      await c.query(
        "SELECT upload_validation_key_hash FROM company_settings WHERE id=1 FOR UPDATE",
      )
    ).rows[0];
    if (!row)
      throw new Error("Seed company settings before binding the upload key");
    if (
      row.upload_validation_key_hash &&
      row.upload_validation_key_hash !== hash &&
      !process.argv.includes("--rotate")
    )
      throw new Error(
        "Key/verifier mismatch: use an intentional --rotate after backing up configuration",
      );
    await c.query(
      "UPDATE company_settings SET upload_validation_key_hash=$1 WHERE id=1",
      [hash],
    );
    let text = original;
    if (!env.UPLOAD_VALIDATION_KEY)
      text += "\nUPLOAD_VALIDATION_KEY=" + key + "\n";
    else if (rotating)
      text = text.replace(
        /^UPLOAD_VALIDATION_KEY=.*$/m,
        "UPLOAD_VALIDATION_KEY=" + key,
      );
    if (!env.PRIVATE_UPLOAD_ROOT) text += "PRIVATE_UPLOAD_ROOT=" + root + "\n";
    await writeFile(name, text, { mode: 0o600 });
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    await c.end();
  }
}
console.log(
  "Upload capability configured for local dev/test; keys were preserved and not printed.",
);
