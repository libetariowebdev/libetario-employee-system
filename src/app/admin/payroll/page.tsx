import { PayrollPeriodsPage } from "@/components/payroll-pages";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ offset?: string }>;
}) {
  return <PayrollPeriodsPage offset={(await searchParams).offset} />;
}
