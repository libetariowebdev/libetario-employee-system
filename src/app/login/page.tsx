import { AuthForm } from "@/components/forms";
import { ArrowUpRight, ShieldCheck } from "lucide-react";
export default function Login() {
  return (
    <main className="auth-page">
      <section className="auth-story">
        <a className="wordmark" href="/login">
          <span className="brand-mark">
            L<span>↗</span>
          </span>
          <span>
            libetario
            <span className="brand-sub">DIGITAL MARKETING SERVICES</span>
          </span>
        </a>
        <div>
          <p className="eyebrow">THE TEAM BEHIND THE WORK</p>
          <h1>
            Good work.
            <br />
            Great people.
            <br />
            <em>One workspace.</em>
          </h1>
          <p>A focused space for the people building what comes next.</p>
        </div>
        <div className="auth-footer">
          <ShieldCheck size={17} /> Private team workspace{" "}
          <span>2A / ACCOUNT SECURITY</span>
        </div>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          <span className="pill">
            TEAM ACCESS <ArrowUpRight size={12} />
          </span>
          <h2>Welcome back.</h2>
          <p className="muted">Sign in with your Libetario account.</p>
          <AuthForm mode="login" />
          <a className="small reset-link" href="/mfa/recovery">
            Lost your authenticator?
          </a>
          <br />
          <a className="small reset-link" href="/reset-password">
            Need help with your password?
          </a>
          <div className="auth-note">
            <ShieldCheck size={18} />
            <p>
              Account access only. Duty authorization and secure duty sign-in
              will be available in checkpoint 2b.
            </p>
          </div>
        </div>
        <p className="auth-bottom">
          LIBETARIO DIGITAL MARKETING SERVICES <span>INTERNAL USE ONLY</span>
        </p>
      </section>
    </main>
  );
}
