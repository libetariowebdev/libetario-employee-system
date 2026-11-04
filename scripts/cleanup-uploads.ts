import { config } from "dotenv";
config({
  path: process.argv.includes("--test") ? ".env.test.local" : ".env",
  override: true,
  quiet: true,
});
import { randomUUID } from "node:crypto";
import { assertOperatorTarget, operatorConnection } from "./lib/operator-db";
import { storageRoot, removeRejectedBytes } from "../src/server/files/storage";
const url = assertOperatorTarget(
  process.env.MIGRATION_DATABASE_URL,
  process.argv.includes("--allow-production"),
);
const fileIndex = process.argv.indexOf("--file-id"),
  target = fileIndex < 0 ? null : process.argv[fileIndex + 1];
if (
  target !== null &&
  (!target ||
    !/^([a-f0-9]{8}-){1}[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      target,
    ))
)
  throw new Error("Valid file UUID required");
const c = await operatorConnection(url);
let count = 0;
try {
  await storageRoot();
  // Bounded operator action, never a background service. AVAILABLE rows are never selected.
  await c.query("BEGIN");
  await c.query("SELECT pg_advisory_xact_lock(72426824::bigint)");
  const rows = (
    await c.query(
      "SELECT id,storage_key,state FROM file_objects WHERE purpose='WORK' AND state IN ('QUARANTINED','REJECTED') AND bytes_deleted_at IS NULL AND created_at<=private.security_now()-interval '24 hours' AND ($1::uuid IS NULL OR id=$1) ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED",
      [target],
    )
  ).rows;
  for (const row of rows) {
    await removeRejectedBytes(row.storage_key);
    await c.query(
      "UPDATE file_objects SET state='REJECTED',validated_at=coalesce(validated_at,private.security_now()),validation_outcome=coalesce(validation_outcome,'ABANDONED_UPLOAD_CLEANUP'),bytes_deleted_at=private.security_now() WHERE id=$1",
      [row.id],
    );
    await c.query(
      "INSERT INTO audit_log(action,occurred_at,request_id,payload) VALUES('file.operator_cleanup',private.security_now(),$1,$2)",
      [
        randomUUID(),
        JSON.stringify({ file_id: row.id, previous_state: row.state }),
      ],
    );
    count++;
  }
  await c.query("COMMIT");
  console.log(
    `Removed staged/rejected bytes for ${count} objects; metadata and available files retained.`,
  );
} catch (e) {
  await c.query("ROLLBACK");
  throw e;
} finally {
  await c.end();
}
