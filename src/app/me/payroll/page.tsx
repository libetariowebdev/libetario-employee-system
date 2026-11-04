import { MyPayrollPage } from "@/components/payroll-pages";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ offset?: string }>;
}) {
  return <MyPayrollPage offset={(await searchParams).offset} />;
}
