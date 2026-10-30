import { pageSession } from "@/server/page-session";
import { employeeDetails } from "@/server/services/employees";
import { Shell } from "@/components/shell";
import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";
export default async function EmployeeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const s = await pageSession();
  if (s.role === "ADMINISTRATOR") redirect("/admin");
  const p = await employeeDetails(s, s.user_id);
  return (
    <Shell admin={false} csrf={s.csrf} name={p.display_name}>
      {children}
    </Shell>
  );
}
