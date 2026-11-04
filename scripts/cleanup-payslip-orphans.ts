import { config } from "dotenv";
config({
  path: process.argv.includes("--test") ? ".env.test.local" : ".env",
  quiet: true,
});
import { randomUUID } from "node:crypto";
import { lstat, opendir } from "node:fs/promises";
import path from "node:path";
import { assertOperatorTarget, operatorConnection } from "./lib/operator-db";
import {
  removeRejectedBytes,
  storagePath,
  storageRoot,
} from "../src/server/files/storage";

const args = process.argv.slice(2);
const keyIndex = args.indexOf("--key");
const target = keyIndex < 0 ? null : args[keyIndex + 1];
if (keyIndex >= 0 && !/^[a-f0-9]{64}$/.test(target ?? ""))
  throw new Error("Provide the 64-hex key from the private payslip directory");
const url = assertOperatorTarget(
  process.env.MIGRATION_DATABASE_URL,
  args.includes("--allow-production"),
);
const root = await storageRoot("payslip");
const before = Date.now() - 24 * 60 * 60 * 1000;
const candidates = new Set<string>();
if (target) candidates.add(target);
else {
  for (const dir of ["payslip-quarantine", "payslip-objects"]) {
    const entries = await opendir(path.join(root, dir));
    let inspected = 0;
    for await (const entry of entries) {
      if (candidates.size >= 100 || inspected++ >= 5000) break;
      const match = /^([a-f0-9]{64})\.bin$/.exec(entry.name);
      if (match && entry.isFile()) candidates.add(match[1]);
    }
  }
}

const c = await operatorConnection(url);
let removed = 0;
try {
  for (const key of candidates) {
    await c.query("BEGIN");
    try {
      await c.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('payslip:'||$1,0))",
        [key],
      );
      const owned = await c.query(
        "SELECT 1 FROM file_objects WHERE storage_key=$1",
        [key],
      );
      if (!owned.rowCount) {
        const stats = await Promise.all(
          (["quarantine", "objects"] as const).map(async (area) =>
            lstat(await storagePath(key, area, "payslip")).catch((error) => {
              if (error.code === "ENOENT") return null;
              throw error;
            }),
          ),
        );
        if (
          stats.some(Boolean) &&
          stats.every((stat) => !stat || stat.mtimeMs < before)
        ) {
          await removeRejectedBytes(key, "payslip");
          await c.query(
            "INSERT INTO audit_log(action,occurred_at,request_id,payload) VALUES('payroll.payslip_orphan_removed',private.security_now(),$1,$2)",
            [randomUUID(), JSON.stringify({ purpose: "PAYSLIP" })],
          );
          removed++;
        }
      }
      await c.query("COMMIT");
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  await c.end();
}
console.log(
  `Removed ${removed} unowned payslip storage candidate(s). Published payslips were retained.`,
);
