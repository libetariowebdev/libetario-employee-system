import { PrivateFiles } from "@/components/submission-console";
import { listFiles } from "@/server/files/service";
import Link from "next/link";
import {
  workPage,
  serialized,
  pageRecord,
  workSearch,
} from "@/server/work-page";
import { projectDetail, listTasks, workAdminOptions } from "@/server/dal/tasks";
import {
  ProjectInfo,
  ProjectForm,
  CreateTask,
  TaskList,
} from "@/components/work-console";
export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const w = await workPage(true),
    { id } = await params,
    p = await pageRecord(projectDetail(w, id)),
    data = await listTasks(w, {
      ...workSearch(await searchParams),
      project: id,
    }),
    options = await workAdminOptions(w);
  return (
    <>
      <Link className="text-link" href="/admin/projects">
        ← Projects
      </Link>
      <ProjectInfo project={serialized(p)} />
      <section className="card work-panel">
        <h2>Common project files</h2>
        <PrivateFiles
          files={serialized(await listFiles(w, "PROJECT", id))}
          kind="projects"
          parent={id}
          csrf={w.csrf}
          upload={w.admin && p.status === "ACTIVE"}
        />
      </section>
      <details className="card work-panel">
        <summary>Edit project & status</summary>
        <ProjectForm csrf={w.csrf} project={serialized(p)} />
      </details>
      {!["COMPLETED", "CANCELLED"].includes(p.status) && (
        <CreateTask csrf={w.csrf} projectId={id} options={options} />
      )}
      <TaskList admin csrf={w.csrf} data={serialized(data)} options={options} />
    </>
  );
}
