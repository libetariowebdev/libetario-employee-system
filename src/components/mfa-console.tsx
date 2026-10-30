"use client";
import { useEffect, useState } from "react";
import { mutation, Logout } from "./forms";
type Status = {
  scope: string;
  purpose: string | null;
  enrollment: { state: string; id: string; generation: number } | null;
  pinConfigured: boolean;
  pinEnabled: boolean;
  remainingCodes: number;
};
export function MfaConsole({
  mode,
  csrf: initialCsrf,
  role,
}: {
  mode: string;
  csrf: string;
  role: string;
}) {
  const [csrf, setCsrf] = useState(initialCsrf),
    [status, setStatus] = useState<Status | null>(null),
    [qr, setQr] = useState(""),
    [enrollmentId, setEnrollmentId] = useState(""),
    [codes, setCodes] = useState<string[]>([]),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const refresh = () =>
    fetch("/api/auth/mfa/status")
      .then((r) => r.json())
      .then(setStatus);
  useEffect(() => {
    refresh().catch(() => setError("Unable to load authenticator status"));
  }, []);
  async function run(
    path: string,
    data: unknown,
    after?: (result: any) => Promise<void> | void,
  ) {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const result = await mutation(path, data, csrf);
      await after?.(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function confirmed(result: any) {
    setQr("");
    setCodes(result.codes);
    const current = await (await fetch("/api/session")).json();
    setCsrf(current.csrf);
    await refresh();
  }
  if (mode === "verify")
    return (
      <>
        <p className="muted">
          Enter the current code from your enrolled authenticator. This
          password-verified session has no administrator privileges yet.
        </p>
        <form
          className="form-stack"
          onSubmit={(e) => {
            e.preventDefault();
            run(
              "auth/mfa/verify",
              { code: new FormData(e.currentTarget).get("code") },
              () => window.location.assign("/"),
            );
          }}
        >
          <CodeInput />
          <button className="button primary" disabled={busy}>
            Verify authenticator →
          </button>
        </form>
        {error && (
          <p role="alert" className="notice error">
            {error}
          </p>
        )}
        <a className="reset-link" href="/mfa/recovery">
          Lost your authenticator?
        </a>
        <Logout csrf={csrf} />
      </>
    );
  return (
    <div className="form-stack">
      <p className="muted">
        Authenticator:{" "}
        <strong>{status?.enrollment?.state ?? "Not enrolled"}</strong>
        {status?.enrollment?.state === "CONFIRMED" &&
          ` · ${status.remainingCodes} recovery codes remaining`}
      </p>
      {(!status?.enrollment || status.enrollment.state !== "CONFIRMED") && (
        <>
          <p className="muted small">
            Confirm a new authenticator to finish setup. A setup session cannot
            access administrator tools. QR codes are shown once and are not
            saved by this app.
          </p>
          {!qr ? (
            <form
              className="form-stack"
              onSubmit={(e) => {
                e.preventDefault();
                const d = new FormData(e.currentTarget);
                run(
                  "auth/mfa/enroll",
                  { password: d.get("password"), replace: d.has("replace") },
                  (r) => {
                    setQr(r.qr);
                    setEnrollmentId(r.enrollmentId);
                  },
                );
              }}
            >
              <PasswordInput />
              <label className="checkbox-label">
                <input name="replace" type="checkbox" />
                Replace a pending QR if the previous one was lost
              </label>
              <button disabled={busy} className="button primary">
                Create one-time enrollment QR
              </button>
            </form>
          ) : (
            <div className="form-stack">
              <img
                src={qr}
                width={320}
                height={320}
                alt="One-time authenticator enrollment QR. Scan privately with your authenticator app."
                style={{
                  maxWidth: "100%",
                  height: "auto",
                  alignSelf: "center",
                }}
              />
              <p className="small muted">
                Scan with Google Authenticator or Microsoft Authenticator, then
                enter its code. This QR expires after five minutes.
              </p>
              <form
                className="form-stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  run(
                    "auth/mfa/confirm",
                    {
                      enrollmentId,
                      code: new FormData(e.currentTarget).get("code"),
                    },
                    confirmed,
                  );
                }}
              >
                <CodeInput />
                <button disabled={busy} className="button primary">
                  Confirm new authenticator
                </button>
              </form>
            </div>
          )}
        </>
      )}
      {codes.length > 0 && (
        <div className="notice success" role="status">
          <strong>Save these recovery codes privately now.</strong>
          <p>
            Shown once. Each code can be used once with your password to replace
            a lost authenticator. The old authenticator and sessions will be
            revoked.
          </p>
          {codes.map((c) => (
            <code key={c} className="secret">
              {c}
            </code>
          ))}
          <a className="button primary" href="/">
            Continue to workspace →
          </a>
        </div>
      )}
      {status?.enrollment?.state === "CONFIRMED" && codes.length === 0 && (
        <>
          <p className="small muted">
            Use a NEW code for each action. A code used to enroll or sign in
            cannot be reused in the same time step.
          </p>
          <form
            className="form-stack"
            onSubmit={(e) => {
              e.preventDefault();
              run(
                "auth/mfa/reauth",
                { code: new FormData(e.currentTarget).get("code") },
                () =>
                  setNotice(
                    "Recent MFA verified. You can return to the administrator security action.",
                  ),
              );
            }}
          >
            <h2>Verify recent MFA</h2>
            <CodeInput />
            <button disabled={busy} className="button secondary">
              Verify a fresh code
            </button>
          </form>
          {role === "EMPLOYEE" && (
            <form
              className="form-stack"
              onSubmit={(e) => {
                e.preventDefault();
                const d = Object.fromEntries(new FormData(e.currentTarget));
                run("auth/mfa/pin", d, async () => {
                  setNotice("PIN saved securely.");
                  await refresh();
                });
              }}
            >
              <h2>
                {status.pinConfigured
                  ? "Change or replace my PIN"
                  : "Set my PIN"}
              </h2>
              <p className="small muted">
                PIN duty enforcement is{" "}
                {status.pinEnabled ? "enabled" : "disabled by default"}. Duty
                login arrives in checkpoint 2b. A forgotten PIN can be replaced
                with your password and fresh TOTP.
              </p>
              <PasswordInput />
              <CodeInput />
              <label>
                New six-digit PIN
                <input
                  name="pin"
                  type="password"
                  inputMode="numeric"
                  autoComplete="new-password"
                  pattern="[0-9]{6}"
                  minLength={6}
                  maxLength={6}
                  required
                />
              </label>
              <button disabled={busy} className="button secondary">
                Save PIN
              </button>
            </form>
          )}
          <form
            className="form-stack"
            onSubmit={(e) => {
              e.preventDefault();
              run(
                "auth/mfa/codes",
                Object.fromEntries(new FormData(e.currentTarget)),
                (r) => setCodes(r.codes),
              );
            }}
          >
            <h2>Replace recovery codes</h2>
            <p className="small muted">
              Regenerating revokes every old recovery code.
            </p>
            <PasswordInput />
            <CodeInput />
            <button disabled={busy} className="button secondary">
              Generate new recovery codes
            </button>
          </form>
        </>
      )}
      {notice && (
        <p className="notice success" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <div>
        <a className="text-link" href="/">
          ← Workspace
        </a>{" "}
        ·{" "}
        <a className="text-link" href="/mfa/recovery">
          Recovery options
        </a>
      </div>
      <Logout csrf={csrf} />
    </div>
  );
}
function PasswordInput() {
  return (
    <label>
      Current password
      <input
        name="password"
        type="password"
        autoComplete="current-password"
        maxLength={512}
        required
      />
    </label>
  );
}
function CodeInput() {
  return (
    <label>
      Authenticator code
      <input
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        minLength={6}
        maxLength={6}
        required
      />
    </label>
  );
}
export function MfaRecovery() {
  const [csrf, setCsrf] = useState(""),
    [kind, setKind] = useState("recover"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    fetch("/api/auth/csrf")
      .then((r) => r.json())
      .then((r) => setCsrf(r.csrf))
      .catch(() => setError("Unable to load secure form"));
  }, []);
  return (
    <>
      <p className="muted">
        Use a saved recovery code, or ask another administrator to verify your
        identity and privately issue an authenticator-reset token. Your old
        authenticator and sessions will be revoked.
      </p>
      <form
        className="form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          setBusy(true);
          try {
            await mutation(
              kind === "recover" ? "auth/mfa/recover" : "auth/mfa/reset/redeem",
              Object.fromEntries(new FormData(e.currentTarget)),
              csrf,
            );
            window.location.assign("/mfa/setup");
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Recovery method
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="recover">Saved single-use recovery code</option>
            <option value="reset">Administrator-issued reset token</option>
          </select>
        </label>
        <label>
          Email or username
          <input
            name="identifier"
            autoComplete="username"
            required
            maxLength={254}
          />
        </label>
        <PasswordInput />
        <label>
          {kind === "recover" ? "Recovery code" : "Private reset token"}
          <input
            name="code"
            type="password"
            autoComplete="off"
            maxLength={150}
            required
          />
        </label>
        {error && (
          <p role="alert" className="notice error">
            {error}
          </p>
        )}
        <button disabled={!csrf || busy} className="button primary">
          Continue to new authenticator setup →
        </button>
      </form>
      <a className="reset-link" href="/login">
        ← Back to sign in
      </a>
    </>
  );
}
export function MfaResetIssuer({
  csrf,
  accounts,
}: {
  csrf: string;
  accounts: { id: string; username: string; role: string }[];
}) {
  const [error, setError] = useState(""),
    [token, setToken] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <form
      className="card form-stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setError("");
        setToken("");
        setBusy(true);
        const d = new FormData(e.currentTarget);
        try {
          const r = await mutation(
            "admin/employees/" + d.get("target") + "/mfa-reset",
            { note: d.get("note"), reason: d.get("reason") },
            csrf,
          );
          setToken(r.token);
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2>Assist with authenticator reset</h2>
      <p className="muted small">
        For loss of both device and recovery codes. Verify identity first. Your
        own recent TOTP must be within five minutes; use{" "}
        <a href="/mfa/security">Verify recent MFA</a> if needed. This revokes
        the target's authenticator, codes and all sessions immediately.
      </p>
      <label>
        Account
        <select name="target" required>
          <option value="">Select an account</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.username} · {a.role}
            </option>
          ))}
        </select>
      </label>
      <label>
        Identity verification note
        <textarea name="note" minLength={10} maxLength={500} required />
      </label>
      <label>
        Reason
        <textarea name="reason" minLength={10} maxLength={500} required />
      </label>
      {token && (
        <div role="status" className="notice success">
          Deliver this token privately once. Default expiry is 15 minutes.
          <code className="secret">{token}</code>Target opens /mfa/recovery with
          their password and this token.
        </div>
      )}
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      <button disabled={busy} className="button secondary">
        Revoke factor & issue reset token
      </button>
    </form>
  );
}
