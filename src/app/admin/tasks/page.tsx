import { workPage, serialized, workSearch } from "@/server/work-page";
import { listTasks, workAdminOptions } from "@/server/dal/tasks";
import { TaskList } from "@/components/work-console";
export default async function Tasks({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const w = await workPage(true),
    data = await listTasks(w, workSearch(await searchParams)),
    options = await workAdminOptions(w);
  return (
    <TaskList admin csrf={w.csrf} data={serialized(data)} options={options} />
  );
}
