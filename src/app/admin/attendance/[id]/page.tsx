import { AttendanceDetailPage } from "@/components/attendance-page";
import { workPage, pageRecord } from "@/server/work-page";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return pageRecord(
    AttendanceDetailPage({ w: await workPage(true), id: (await params).id }),
  );
}
