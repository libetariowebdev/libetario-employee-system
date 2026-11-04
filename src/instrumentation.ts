export async function register() {
  if (
    process.env.NEXT_RUNTIME === "nodejs" &&
    process.env.NEXT_PHASE !== "phase-production-build"
  ) {
    try {
      const { db } = await import("./server/db");
      await db.$queryRaw`SELECT private.attendance_reconcile_due()`;
    } catch {
      console.warn(
        "Attendance startup reconciliation unavailable; guarded views retain expiry bounds. Use authorized Refresh or the operator command.",
      );
    }
  }
}
