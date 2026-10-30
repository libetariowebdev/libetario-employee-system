import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { HttpError } from "./auth/security";
import { session } from "./auth/service";
export async function pageSession(admin = false, allowPasswordChange = false) {
  try {
    const s = await session(
      (await cookies()).get("libetario_session")?.value,
      true,
    );
    if (s.must_change_password && !allowPasswordChange)
      redirect("/change-password");
    if (admin && s.role !== "ADMINISTRATOR") redirect("/me");
    return s;
  } catch (e) {
    if (e instanceof HttpError) redirect("/login");
    throw e;
  }
}
