import { randomUUID } from "node:crypto";
import pg from "pg";
import { assertOperatorTarget } from "./operator-db";

export function releaseTarget(allowed: boolean) {
  if (process.env.NODE_ENV !== "production" || !allowed)
    throw new Error(
      "Release commands require NODE_ENV=production and --allow-production",
    );
  const target = process.env.LIBETARIO_TARGET;
  const database = process.env.LIBETARIO_DATABASE;
  const port = process.env.LIBETARIO_DB_PORT;
  if (
    (target !== "prod" && target !== "stage" && target !== "scratch") ||
    !database ||
    !(target === "scratch"
      ? /^libetario_restore_[a-z0-9_]{3,25}$/.test(database)
      : database === `libetario_${target}`) ||
    !port ||
    !/^\d{4,5}$/.test(port) ||
    Number(port) > 65535
  )
    throw new Error("Invalid release target, expected database or port");
  const url = assertOperatorTarget(process.env.MIGRATION_DATABASE_URL, true);
  if (
    url.protocol !== "postgresql:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== port ||
    url.pathname !== "/" + database ||
    url.username !== "libetario_migrator" ||
    !url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "The loopback migration URL must match the expected release target",
    );
  return { target, database, port, url };
}
export type ReleaseTarget = ReturnType<typeof releaseTarget>;

export async function releaseConnection(target: ReleaseTarget, empty = false) {
  const c = new pg.Client({
    connectionString: target.url.href,
    connectionTimeoutMillis: 5000,
  });
  try {
    await c.connect();
    const {
      rows: [check],
    } = await c.query(`
      SELECT current_database() database, inet_server_port() port, current_user username,
        pg_get_userbyid(d.datdba) owner,
        (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) elevated,
        to_regclass('public.users') IS NOT NULL initialized,
        (SELECT count(*)::int FROM pg_class cl JOIN pg_namespace n ON n.oid=cl.relnamespace
           WHERE n.nspname='public' AND cl.relkind IN ('r','p','v','m','f')) relations,
        EXISTS(SELECT FROM pg_namespace WHERE nspname='private') private_schema
      FROM pg_database d WHERE d.datname=current_database()
    `);
    if (
      !check ||
      check.database !== target.database ||
      String(check.port) !== target.port ||
      check.username !== "libetario_migrator" ||
      check.owner !== check.username ||
      check.elevated ||
      (empty
        ? check.relations !== 0 || check.private_schema
        : !check.initialized)
    )
      throw new Error(
        "Database owner or schema did not match the expected release operation",
      );
    if (!empty) {
      const row = (
        await c.query(
          "SELECT pg_get_userbyid(relowner) = current_user AS owned FROM pg_class WHERE oid='public.users'::regclass",
        )
      ).rows[0];
      if (!row?.owned)
        throw new Error(
          "Application objects must belong to the migration owner",
        );
    }
    return c;
  } catch (error) {
    await c.end().catch(() => {});
    throw error;
  }
}

export async function releaseAudit(
  c: pg.Client,
  action: string,
  payload: object,
  actor?: string,
) {
  await c.query(
    "INSERT INTO audit_log(actor_user_id,action,occurred_at,request_id,payload) VALUES($1,$2,private.security_now(),$3,$4)",
    [actor ?? null, action, randomUUID(), JSON.stringify(payload)],
  );
}

export function safeOperatorError(error: unknown) {
  return error instanceof Error && !("code" in error)
    ? error.message
    : "Release operation failed. No connection details or credentials were printed.";
}
