import { Shell } from "@/components/shell";
import { workPage } from "@/server/work-page";
export const dynamic = "force-dynamic";
export default async function WorkLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const w = await workPage();
  return (
    <Shell admin={w.admin} duty={!w.admin} name={w.name} csrf={w.csrf}>
      {children}
    </Shell>
  );
}
