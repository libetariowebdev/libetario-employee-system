import { submissions } from "@/server/services/submissions";
import { listFiles } from "@/server/files/service";
import { taskDetail } from "@/server/dal/tasks";
import type { WorkSession } from "@/server/dal/work";
import { serialized } from "@/server/work-page";
import { DraftStart, PrivateFiles, SubmissionCard } from "./submission-console";
export async function Deliverables({
  w,
  taskId,
}: {
  w: WorkSession;
  taskId: string;
}) {
  const detail = await taskDetail(w, taskId),
    items = await submissions(w, taskId),
    taskFiles = await listFiles(w, "TASK", taskId);
  const locked =
    detail.task.project_status !== "ACTIVE" ||
    ["CANCELLED", "APPROVED"].includes(detail.task.status);
  const active = items.find((s) => s.state === "DRAFT"),
    own = detail.assignments[0];
  return (
    <>
      <section className="card work-panel">
        <h2>Task reference files</h2>
        <PrivateFiles
          csrf={w.csrf}
          kind="tasks"
          parent={taskId}
          files={serialized(taskFiles)}
          upload={w.admin && !locked}
        />
      </section>
      <section className="work-panel">
        <h2>
          {w.admin ? "Submitted contributions & drafts" : "My submissions"}
        </h2>
        {locked && (
          <p className="notice">
            Submissions and reviews are read-only while the project/task is
            closed or approved.
          </p>
        )}
        {!w.admin && !active && own && (
          <DraftStart
            csrf={w.csrf}
            assignmentId={own.id}
            disabled={
              locked ||
              !["IN_PROGRESS", "REVISION_REQUIRED"].includes(own.status)
            }
          />
        )}{" "}
        {!items.length && <p className="muted">No submissions yet.</p>}
        {await Promise.all(
          items.map(async (s) => (
            <SubmissionCard
              key={s.id}
              s={serialized(s)}
              files={serialized(await listFiles(w, "SUBMISSION", s.id))}
              csrf={w.csrf}
              admin={w.admin}
              locked={locked}
              employeeLabel={
                detail.assignments.find((a) => a.employee_id === s.employee_id)
                  ?.display_name ?? undefined
              }
            />
          )),
        )}
      </section>
    </>
  );
}
