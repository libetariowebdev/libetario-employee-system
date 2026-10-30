import "dotenv/config";
import { parseArgs } from "node:util";
import { openSecret, sealSecret, mfaKeyring } from "../src/lib/mfa-crypto";
import { assertOperatorTarget, operatorConnection } from "./lib/operator-db";
try {
  const { values } = parseArgs({
    options: { "allow-production": { type: "boolean", default: false } },
    strict: true,
  });
  const url = assertOperatorTarget(
      process.env.MIGRATION_DATABASE_URL,
      values["allow-production"],
    ),
    ring = mfaKeyring(),
    c = await operatorConnection(url);
  try {
    await c.query("BEGIN");
    let count = 0;
    // Match authentication lock ordering: users first, then enrollment rows.
    await c.query(
      "SELECT id FROM users WHERE id IN (SELECT user_id FROM mfa_enrollments WHERE state IN ('PENDING','CONFIRMED')) ORDER BY id FOR UPDATE",
    );
    const rows = (
      await c.query(
        "SELECT * FROM mfa_enrollments WHERE state IN ('PENDING','CONFIRMED') AND encryption_key_id<>$1 ORDER BY user_id,generation FOR UPDATE",
        [ring.active],
      )
    ).rows;
    for (const row of rows) {
      const secret = openSecret(row, ring);
      try {
        const sealed = sealSecret(secret, row, ring);
        await c.query(
          "UPDATE mfa_enrollments SET ciphertext=$2,nonce=$3,tag=$4,encryption_key_id=$5,updated_at=private.security_now(),version=version+1 WHERE id=$1",
          [
            row.id,
            sealed.ciphertext,
            sealed.nonce,
            sealed.tag,
            sealed.encryption_key_id,
          ],
        );
        count++;
      } finally {
        secret.fill(0);
      }
    }
    await c.query(
      "SELECT private.write_audit('mfa.keys_rotated',jsonb_build_object('count',$1::int,'active_key_id',$2::text,'source','CLI'))",
      [count, ring.active],
    );
    await c.query("COMMIT");
    console.log(
      `Rotated ${count} encrypted enrollments to key ID ${ring.active}. Generations and replay counters retained. Keep old keys for retained backups.`,
    );
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    await c.end();
  }
} catch {
  console.error(
    "MFA rotation failed; check keyring and migration authority. No secrets were logged.",
  );
  process.exitCode = 1;
}
