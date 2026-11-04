import {
  releaseConnection,
  releaseTarget,
  safeOperatorError,
} from "./lib/release-db";

async function main() {
  const target = releaseTarget(
    process.argv.length === 3 && process.argv[2] === "--allow-production",
  );
  if (target.target === "scratch")
    throw new Error("Scheduled reconciliation requires stage or prod");
  const c = await releaseConnection(target);
  try {
    let changed = 0;
    for (let batch = 0; batch < 10; batch++) {
      const {
        rows: [result],
      } = await c.query("SELECT private.attendance_reconcile_due() n");
      changed += result.n;
      if (!result.n) break;
    }
    const {
      rows: [backlog],
    } = await c.query(`
      SELECT count(*)::int n FROM attendance_shifts s WHERE clocked_out_at IS NULL AND
       (grant_until<=private.security_now() OR
        (extract(epoch FROM private.security_now()-clocked_in_at)>(policy_snapshot->>'longShiftReviewSeconds')::int
         AND NOT 'LONG_SHIFT'=ANY(flags)))
    `);
    console.log(
      `Attendance reconciliation changed ${changed} rows. Remaining due ${backlog.n}.`,
    );
    if (backlog.n)
      throw new Error(
        "Attendance reconciliation backlog requires operator review",
      );
  } finally {
    await c.end();
  }
}

main().catch((error: unknown) => {
  console.error(safeOperatorError(error));
  process.exitCode = 1;
});
