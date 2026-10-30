import { AuthForm } from "@/components/forms";
export default function Reset() {
  return (
    <main className="simple-auth">
      <a className="text-brand" href="/login">
        libetario ↗
      </a>
      <div className="card">
        <p className="eyebrow">ACCOUNT RECOVERY</p>
        <h1>Set a new password.</h1>
        <p className="muted">
          Ask your administrator to verify your identity and privately provide a
          reset token. It expires after 15 minutes by default and can be used
          once.
        </p>
        <AuthForm mode="reset" />
        <a className="reset-link small" href="/login">
          ← Back to sign in
        </a>
      </div>
    </main>
  );
}
