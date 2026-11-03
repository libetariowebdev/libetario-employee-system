import Link from "next/link";
import { workPage, serialized, pageRecord } from "@/server/work-page";
import { taskDetail, workAdminOptions } from "@/server/dal/tasks";
import { TaskDetail } from "@/components/work-console";
export default async function TaskPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ commentsPage?: string }>;
}) {
  const w = await workPage(true),
    { id } = await params,
    data = await pageRecord(
      taskDetail(w, id, Number((await searchParams).commentsPage ?? 1)),
    ),
    options = await workAdminOptions(w);
  return (
    <>
      <Link href="/admin/tasks" className="text-link">
        ← Team tasks
      </Link>
      <TaskDetail
        admin
        csrf={w.csrf}
        data={serialized(data)}
        options={options}
      />
    </>
  );
}
