import { AttendancePage } from "@/components/attendance-page";
import { workPage, workSearch, pageRecord } from "@/server/work-page";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return pageRecord(
    AttendancePage({
      w: await workPage(true),
      search: workSearch(await searchParams),
    }),
  );
}
