import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { HttpError } from "./auth/security";
import { session } from "./auth/service";
export async function pageSession(
  admin = false,
  allowPasswordChange = false,
  allowSetup = false,
) {
  try {
    const s = await session(
      (await cookies()).get("libetario_session")?.value,
      true,
      true,
    );
    if (s.must_change_password && !allowPasswordChange)
      redirect("/change-password");
    if (s.scope === "SETUP" && !allowSetup)
      redirect(
        s.setup_purpose === "PASSWORD_CHANGE"
          ? "/change-password"
          : s.setup_purpose === "MFA_LOGIN"
            ? "/mfa/verify"
            : s.setup_purpose === "MFA_RESET_REQUIRED"
              ? "/mfa/recovery"
              : "/mfa/setup",
      );
    if (admin && s.role !== "ADMINISTRATOR") redirect("/me");
    return s;
  } catch (e) {
    if (e instanceof HttpError) redirect("/login");
    throw e;
  }
}
