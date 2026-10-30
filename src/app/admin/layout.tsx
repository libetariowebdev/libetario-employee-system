import { pageSession } from "@/server/page-session";
import { Shell } from "@/components/shell";
export const dynamic = "force-dynamic";
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const s = await pageSession(true);
  return (
    <Shell admin csrf={s.csrf} name="Administrator">
      {children}
    </Shell>
  );
}
