import { LedgerPage } from "@/components/time-pages";
import { pageRecord, workPage, workSearch } from "@/server/work-page";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return pageRecord(
    LedgerPage({
      w: await workPage(true),
      search: workSearch(await searchParams),
    }),
  );
}
