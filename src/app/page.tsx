import { redirect } from "next/navigation";
import { pageSession } from "@/server/page-session";
export default async function Home() {
  const s = await pageSession();
  redirect(s.role === "ADMINISTRATOR" ? "/admin" : "/me");
}
