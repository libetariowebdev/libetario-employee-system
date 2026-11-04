import { PayrollPeriodPage } from "@/components/payroll-pages";

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return <PayrollPeriodPage id={(await params).id} />;
}
