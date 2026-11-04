import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import { userInfo } from "node:os";
import { z } from "zod";
import { attendanceDefaults } from "../src/lib/attendance";
import { securitySchema } from "../src/lib/config";
import { hashPassword } from "../src/server/auth/security";
import {
  releaseAudit,
  releaseConnection,
  releaseTarget,
  safeOperatorError,
} from "./lib/release-db";

async function main() {
  const {
    values,
    positionals: [mode],
  } = parseArgs({
    allowPositionals: true,
    options: {
      "allow-production": { type: "boolean" },
      username: { type: "string" },
      email: { type: "string" },
    },
  });
  if (!["first-admin", "second-admin", "bind-upload"].includes(mode))
    throw new Error("Use first-admin, second-admin, or bind-upload");
  const target = releaseTarget(values["allow-production"] === true);
  if (target.target === "scratch")
    throw new Error("Use the restore tool for scratch databases");
  const username =
    mode === "bind-upload"
      ? null
      : z
          .string()
          .regex(/^[a-z0-9_.-]{3,40}$/)
          .parse(values.username);
  const email =
    mode === "bind-upload"
      ? null
      : z.email().parse(values.email?.toLowerCase());
  const uploadKey = process.env.UPLOAD_VALIDATION_KEY;
  if (mode !== "second-admin" && !/^[a-f0-9]{64}$/.test(uploadKey ?? ""))
    throw new Error("The server upload capability must be provisioned first");
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    throw new Error("Use a private interactive terminal");

  let masked = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!masked) process.stderr.write(chunk);
      callback();
    },
  });
  const prompt = createInterface({
    input: process.stdin,
    output,
    terminal: true,
    historySize: 0,
  });
  let passwordHash: string | null = null;
  try {
    const expected = `${mode} ${target.database}`;
    if ((await prompt.question(`Type ${expected} to confirm: `)) !== expected)
      throw new Error("Operation cancelled");
    if (mode !== "bind-upload") {
      masked = true;
      process.stderr.write("Temporary password (input hidden): ");
      const password = await prompt.question("");
      process.stderr.write("\nRepeat temporary password: ");
      if (password !== (await prompt.question("")))
        throw new Error("Passwords differ");
      process.stderr.write("\n");
      passwordHash = await hashPassword(password);
    }
  } finally {
    prompt.close();
  }
  const c = await releaseConnection(target);
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(72426820::bigint)");
    await c.query("LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE");
    const audit = { operator: userInfo().username, target: target.target };
    const hash = uploadKey
      ? createHash("sha256").update(uploadKey).digest("hex")
      : null;
    if (mode === "first-admin") {
      const occupied = (
        await c.query(
          "SELECT EXISTS(SELECT 1 FROM users) OR EXISTS(SELECT 1 FROM company_settings) OR EXISTS(SELECT 1 FROM policy_versions) occupied",
        )
      ).rows[0].occupied;
      if (occupied)
        throw new Error(
          "First administrator requires empty users, policies and settings",
        );
      const {
        rows: [admin],
      } = await c.query(
        "INSERT INTO users(email,username,password_hash,role) VALUES($1,$2,$3,'ADMINISTRATOR') RETURNING id",
        [email, username, passwordHash],
      );
      const policies: Record<string, string> = {};
      const config = {
        SECURITY: securitySchema.parse({}),
        WORK: {
          attendance: attendanceDefaults,
          pinEnabled: false,
          overnightEnabled: false,
          overnightCarryHours: 8,
          clockOutTimer: "CLOSE",
          maxShiftHours: 16,
        },
        PAY: {},
      };
      for (const [key, value] of Object.entries(config)) {
        const {
          rows: [row],
        } = await c.query(
          "INSERT INTO policy_versions(policy_key,revision,configuration,created_by) VALUES($1,1,$2,$3) RETURNING id",
          [key, JSON.stringify(value), admin.id],
        );
        policies[key] = row.id;
      }
      await c.query(
        "INSERT INTO company_settings(company_name,security_policy_id,work_policy_id,pay_policy_id,upload_validation_key_hash) VALUES($1,$2,$3,$4,$5)",
        [
          "Libetario Digital Marketing Services",
          policies.SECURITY,
          policies.WORK,
          policies.PAY,
          hash,
        ],
      );
      await releaseAudit(c, "release.first_admin_created", {
        ...audit,
        userId: admin.id,
      });
    } else if (mode === "second-admin") {
      const {
        rows: [existing],
      } = await c.query(`
        SELECT count(*)::int total, count(*) FILTER(WHERE u.disabled_at IS NULL AND NOT u.must_change_password
          AND EXISTS(SELECT FROM mfa_enrollments e WHERE e.user_id=u.id AND e.state='CONFIRMED'))::int confirmed
        FROM users u WHERE role='ADMINISTRATOR'
      `);
      if (existing.total !== 1 || existing.confirmed !== 1)
        throw new Error(
          "Second administrator requires exactly one existing, MFA-confirmed administrator",
        );
      const {
        rows: [admin],
      } = await c.query(
        "INSERT INTO users(email,username,password_hash,role) VALUES($1,$2,$3,'ADMINISTRATOR') RETURNING id",
        [email, username, passwordHash],
      );
      await releaseAudit(c, "release.second_admin_created", {
        ...audit,
        userId: admin.id,
      });
    } else {
      const clients = (
        await c.query(
          "SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND usename IN ('libetario_runtime','libetario_auth')",
        )
      ).rows[0].n;
      if (clients)
        throw new Error(
          "Stop the app and confirm both app role pools are disconnected first",
        );
      const result = await c.query(
        "UPDATE company_settings SET upload_validation_key_hash=$1 WHERE id=1",
        [hash],
      );
      if (result.rowCount !== 1)
        throw new Error("Bootstrap company settings first");
      await releaseAudit(c, "release.upload_capability_bound", audit);
    }
    await c.query("COMMIT");
    console.log(
      "Release operation committed and audited. No secrets were printed.",
    );
  } catch (error) {
    await c.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await c.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof z.ZodError
      ? "Enter a valid username and email"
      : safeOperatorError(error),
  );
  process.exitCode = 1;
});
