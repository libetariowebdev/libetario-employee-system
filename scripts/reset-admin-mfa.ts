import "dotenv/config";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { randomBytes, createHash } from "node:crypto";
import { userInfo } from "node:os";
import { assertOperatorTarget, operatorConnection } from "./lib/operator-db";
try {
  const { values } = parseArgs({
    options: {
      username: { type: "string" },
      "allow-production": { type: "boolean", default: false },
    },
    strict: true,
  });
  if (!values.username || !/^[a-z0-9_.-]{3,40}$/.test(values.username))
    throw new Error("Supply --username with the administrator username");
  const url = assertOperatorTarget(
    process.env.MIGRATION_DATABASE_URL,
    values["allow-production"],
  );
  const c = await operatorConnection(url);
  const rl = createInterface({ input: process.stdin, terminal: false }),
    lines = rl[Symbol.asyncIterator]();
  const ask = async (label: string) => {
    process.stdout.write(label);
    const result = await lines.next();
    if (result.done) throw new Error("Confirmation cancelled");
    return result.value.trim();
  };
  try {
    const target = (
      await c.query(
        "SELECT id,username FROM users WHERE username=$1 AND role='ADMINISTRATOR' AND disabled_at IS NULL",
        [values.username],
      )
    ).rows[0];
    if (!target) throw new Error("Enabled administrator not found");
    console.log(
      `Target: ${target.username} on ${url.hostname}${url.pathname}. This revokes its authenticator, recovery codes and all sessions. Password and role stay unchanged.`,
    );
    if (
      (await ask(`Type RESET ${target.username} to confirm: `)) !==
      `RESET ${target.username}`
    )
      throw new Error("Confirmation cancelled");
    const note = await ask("Identity verification note (10–500 characters): "),
      reason = await ask("Reason (10–500 characters): ");
    if (
      note.length < 10 ||
      note.length > 500 ||
      reason.length < 10 ||
      reason.length > 500
    )
      throw new Error(
        "Verification note and reason must each be 10–500 characters",
      );
    const token = randomBytes(32).toString("hex"),
      digest = createHash("sha256").update(token).digest("hex");
    await c.query("BEGIN");
    try {
      const stillAdmin = (
        await c.query(
          "SELECT id FROM users WHERE id=$1 AND role='ADMINISTRATOR' AND disabled_at IS NULL FOR UPDATE",
          [target.id],
        )
      ).rows[0];
      if (!stillAdmin) throw new Error("Account state changed");
      await c.query(
        "SELECT private.perform_mfa_reset($1,NULL,'CLI',$2,$3,$4,$5)",
        [target.id, digest, note, reason, userInfo().username],
      );
      await c.query("COMMIT");
      console.log(
        "Reset audited. Deliver this one-time token privately; do not redirect or save terminal output.",
      );
      console.log(`Reset token: ${token}`);
      console.log(
        "Use /mfa/recovery with the account password and this token, then confirm a NEW authenticator. Default expiry: 15 minutes.",
      );
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    }
  } finally {
    rl.close();
    await c.end();
  }
} catch (e) {
  console.error(
    e instanceof Error && !("code" in e)
      ? e.message
      : "Operator reset failed; no secrets were logged",
  );
  process.exitCode = 1;
}
