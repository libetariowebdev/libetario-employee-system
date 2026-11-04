import { Deliverables } from "@/components/deliverables";
import Link from "next/link";
import { workPage, serialized, pageRecord } from "@/server/work-page";
import { taskDetail } from "@/server/dal/tasks";
import { TaskDetail } from "@/components/work-console";
import { TimerControls } from "@/components/time-controls";
import { ledger } from "@/server/services/work-time";
import { currentAttendance } from "@/server/services/attendance";
export default async function TaskPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ commentsPage?: string }>;
}) {
  const w = await workPage(),
    { id } = await params,
    data = await pageRecord(
      taskDetail(w, id, Number((await searchParams).commentsPage ?? 1)),
    );
  const assignment = data.assignments.find(
    (a) => a.employee_id === w.user_id && !a.access_revoked_at,
  );
  const [snapshot, attendance] = w.admin
    ? [null, null]
    : await Promise.all([ledger(w), currentAttendance(w)]);
  return (
    <>
      <Link href="/work/tasks" className="text-link">
        ← My tasks
      </Link>
      <TaskDetail admin={w.admin} csrf={w.csrf} data={serialized(data)} />
      {assignment && snapshot && attendance && (
        <TimerControls
          snapshot={snapshot}
          csrf={w.csrf}
          ready={!!attendance.active}
          onBreak={
            !!attendance.active?.breaks.some((b) => !b.ended_at && !b.is_voided)
          }
          target={{
            id: assignment.id,
            version: assignment.version,
            eligible:
              data.task.project_status === "ACTIVE" &&
              !["APPROVED", "CANCELLED"].includes(data.task.status) &&
              ["PENDING", "IN_PROGRESS", "REVISION_REQUIRED"].includes(
                assignment.status,
              ),
          }}
        />
      )}
      <Deliverables w={w} taskId={id} />
    </>
  );
}
