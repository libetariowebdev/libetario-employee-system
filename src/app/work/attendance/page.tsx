import { AttendancePage } from "@/components/attendance-page";
import { workPage, workSearch, pageRecord } from "@/server/work-page";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const w = await workPage();
  return pageRecord(
    AttendancePage({ w, search: workSearch(await searchParams) }),
  );
}
