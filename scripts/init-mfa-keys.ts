import { readFile, appendFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { parse } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mfaKeyring } from "../src/lib/mfa-crypto";
export async function initializeKeyringFile(file: string) {
  if (process.env.NODE_ENV === "production")
    throw new Error("Local key initialization refuses production");
  const content = await readFile(file, "utf8"),
    env = parse(content);
  if (env.MFA_ACTIVE_KEY_ID || env.MFA_ENCRYPTION_KEYS) {
    mfaKeyring(env);
    return false;
  }
  const id = "local-" + randomBytes(6).toString("hex"),
    key = randomBytes(32).toString("base64");
  await appendFile(
    file,
    `\nMFA_ACTIVE_KEY_ID=${id}\nMFA_ENCRYPTION_KEYS='${JSON.stringify({ [id]: key })}'\n`,
    { mode: 0o600 },
  );
  return true;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  for (const file of [".env", ".env.test.local"]) {
    await initializeKeyringFile(file);
    console.log("MFA key configuration verified:", file);
  }
  console.log(
    "Back up the keyring separately from the database. Keys were not printed or replaced.",
  );
}
