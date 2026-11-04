import { SegmentPage } from "@/components/time-pages";
import { pageRecord, workPage } from "@/server/work-page";

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return pageRecord(
    SegmentPage({ w: await workPage(false), id: (await params).id }),
  );
}
