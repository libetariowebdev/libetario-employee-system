import pg from "pg";
export function assertOperatorTarget(
  urlText: string | undefined,
  allowProduction: boolean,
  environment = process.env.NODE_ENV,
) {
  if (!urlText) throw new Error("MIGRATION_DATABASE_URL is required");
  const url = new URL(urlText);
  if (
    ["libetario_runtime", "libetario_auth"].includes(
      decodeURIComponent(url.username),
    )
  )
    throw new Error("Migration credentials required");
  const local =
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
    /^\/libetario(?:_test)?$/.test(url.pathname);
  if ((environment === "production" || !local) && !allowProduction)
    throw new Error(
      "Production or non-local target refused. Explicit --allow-production is required.",
    );
  return url;
}
export async function operatorConnection(url: URL) {
  const c = new pg.Client({ connectionString: url.toString() });
  await c.connect();
  const row = (
    await c.query(
      "SELECT current_user,pg_get_userbyid(relowner) owner FROM pg_class WHERE oid='public.users'::regclass",
    )
  ).rows[0];
  if (!row || row.current_user !== row.owner) {
    await c.end();
    throw new Error("Connection must use the migration/table-owner authority");
  }
  return c;
}
