import { PayrollLinePage } from "@/components/payroll-pages";

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return <PayrollLinePage id={(await params).id} />;
}
