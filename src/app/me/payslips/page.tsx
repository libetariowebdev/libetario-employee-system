import { PayslipsPage } from "@/components/payroll-pages";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ offset?: string }>;
}) {
  return <PayslipsPage offset={(await searchParams).offset} />;
}
