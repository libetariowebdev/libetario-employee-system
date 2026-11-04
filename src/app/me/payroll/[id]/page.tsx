import { MyPayrollPage } from "@/components/payroll-pages";

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return <MyPayrollPage id={(await params).id} />;
}
