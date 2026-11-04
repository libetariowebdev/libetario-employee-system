import type pg from "pg";

export async function openShiftCount(c: pg.Client) {
  const {
    rows: [row],
  } = await c.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM public.attendance_shifts WHERE clocked_out_at IS NULL",
  );
  return row.n;
}

// A true result deliberately leaves the transaction open across service stop.
export async function holdQuietShiftGate(c: pg.Client) {
  await c.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try {
    await c.query("SET LOCAL idle_in_transaction_session_timeout=0");
    await c.query("SET LOCAL transaction_timeout=0");
    await c.query("LOCK TABLE public.attendance_shifts IN SHARE MODE NOWAIT");
    // SHARE conflicts with INSERT/UPDATE. Count again under the lock so an
    // admitted Clock In cannot commit between this check and service stop.
    if ((await openShiftCount(c)) === 0) return true;
  } catch (error) {
    await c.query("ROLLBACK");
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "55P03"
    )
      return false;
    throw error;
  }
  await c.query("ROLLBACK");
  return false;
}
