import { Deliverables } from "@/components/deliverables";
import Link from "next/link";
import { workPage, serialized, pageRecord } from "@/server/work-page";
import { taskDetail } from "@/server/dal/tasks";
import { TaskDetail } from "@/components/work-console";
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
  return (
    <>
      <Link href="/work/tasks" className="text-link">
        ← My tasks
      </Link>
      <TaskDetail admin={w.admin} csrf={w.csrf} data={serialized(data)} />
      <Deliverables w={w} taskId={id} />
    </>
  );
}
