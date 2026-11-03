import { workPage, serialized, workSearch } from "@/server/work-page";
import { listTasks } from "@/server/dal/tasks";
import { TaskList } from "@/components/work-console";
export default async function Tasks({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const w = await workPage(),
    data = await listTasks(w, workSearch(await searchParams));
  return <TaskList admin={w.admin} csrf={w.csrf} data={serialized(data)} />;
}
