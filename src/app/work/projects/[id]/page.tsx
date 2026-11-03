import {
  workPage,
  serialized,
  pageRecord,
  workSearch,
} from "@/server/work-page";
import { projectDetail, listTasks } from "@/server/dal/tasks";
import { ProjectInfo, TaskList } from "@/components/work-console";
export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const w = await workPage(),
    { id } = await params,
    p = await pageRecord(projectDetail(w, id)),
    data = await listTasks(w, {
      ...workSearch(await searchParams),
      project: id,
    });
  return (
    <>
      <ProjectInfo project={serialized(p)} />
      <TaskList admin={w.admin} csrf={w.csrf} data={serialized(data)} />
    </>
  );
}
