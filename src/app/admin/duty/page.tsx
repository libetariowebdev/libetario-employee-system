import { pageSession } from "@/server/page-session";
import { dutyDashboard } from "@/server/services/duty";
import { scoped } from "@/server/db";
import { DutyAdmin } from "@/components/duty-console";
export default async function DutyAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const s = await pageSession(true),
    q = await searchParams,
    data = await dutyDashboard(s, q.date);
  const work = await scoped(s.hash, async (tx) => {
    const settings = await tx.company_settings.findUniqueOrThrow({
      where: { id: 1 },
    });
    return tx.policy_versions.findUniqueOrThrow({
      where: { id: settings.work_policy_id },
    });
  });
  const cfg = work.configuration as Record<string, any>;
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">DUTY ACCESS</p>
          <h1>Authorize the workday.</h1>
          <p className="muted">
            Grant and revoke access. Attendance begins in a later phase.
          </p>
        </div>
      </div>
      <DutyAdmin
        initial={JSON.parse(JSON.stringify(data))}
        csrf={s.csrf}
        workPolicy={{
          id: work.id,
          overnightEnabled: cfg.overnightEnabled ?? false,
          overnightCarryHours: cfg.overnightCarryHours ?? 8,
        }}
      />
    </>
  );
}
