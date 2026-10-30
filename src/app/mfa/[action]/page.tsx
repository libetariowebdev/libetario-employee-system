import { notFound, redirect } from "next/navigation";
import { pageSession } from "@/server/page-session";
import { MfaConsole, MfaRecovery } from "@/components/mfa-console";
export const dynamic = "force-dynamic";
export default async function MfaPage({
  params,
}: {
  params: Promise<{ action: string }>;
}) {
  const { action } = await params;
  if (!["setup", "verify", "security", "recovery"].includes(action)) notFound();
  if (action === "recovery")
    return (
      <main className="simple-auth">
        <a className="text-brand" href="/login">
          libetario ↗
        </a>
        <section className="card">
          <p className="eyebrow">AUTHENTICATOR RECOVERY</p>
          <h1>Restore secure access.</h1>
          <MfaRecovery />
        </section>
      </main>
    );
  const s = await pageSession(false, true, true);
  if (s.must_change_password) redirect("/change-password");
  if (s.scope === "SETUP" && s.setup_purpose === "MFA_RESET_REQUIRED")
    redirect("/mfa/recovery");
  if (
    action === "verify" &&
    !(s.scope === "SETUP" && s.setup_purpose === "MFA_LOGIN")
  )
    redirect("/mfa/security");
  return (
    <main className="simple-auth">
      <a className="text-brand" href="/">
        libetario ↗
      </a>
      <section className="card">
        <p className="eyebrow">PRIVATE ACCOUNT SECURITY</p>
        <h1>
          {action === "verify"
            ? "One more secure step."
            : action === "setup"
              ? "Enroll your authenticator."
              : "My account security."}
        </h1>
        <MfaConsole mode={action} csrf={s.csrf} role={s.role} />
      </section>
    </main>
  );
}
