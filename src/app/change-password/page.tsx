import { AuthForm, Logout } from "@/components/forms";
import { pageSession } from "@/server/page-session";
export const dynamic = "force-dynamic";
export default async function Change() {
  const s = await pageSession(false, true, true);
  return (
    <main className="simple-auth">
      <span className="text-brand">libetario ↗</span>
      <div className="card">
        <p className="eyebrow">SECURE YOUR ACCOUNT</p>
        <h1>
          {s.must_change_password
            ? "Make this account yours."
            : "Change your password."}
        </h1>
        <p className="muted">
          Set a private password. Saving it signs out all existing sessions,
          then you can sign in again.
        </p>
        <AuthForm mode="change" />
        <Logout csrf={s.csrf} />
      </div>
    </main>
  );
}
