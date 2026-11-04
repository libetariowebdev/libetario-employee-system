import { DailyPage } from "@/components/time-pages";
import { pageRecord, workPage, workSearch } from "@/server/work-page";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return pageRecord(
    DailyPage({
      w: await workPage(false),
      search: workSearch(await searchParams),
    }),
  );
}
