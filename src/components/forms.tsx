"use client";
import { useEffect, useState } from "react";
export async function mutation(
  path: string,
  data: unknown,
  csrf: string,
  method = "POST",
) {
  const response = await fetch("/api/" + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(data as object), csrf }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Request failed");
  return result;
}
export function AuthForm({ mode }: { mode: "login" | "reset" | "change" }) {
  const [csrf, setCsrf] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(false);
  useEffect(() => {
    fetch(mode === "change" ? "/api/session" : "/api/auth/csrf")
      .then((r) => r.json())
      .then((r) => setCsrf(r.csrf ?? ""))
      .catch(() =>
        setError("Unable to load secure form. Reload to try again."),
      );
  }, [mode]);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setBusy(true);
    const d = Object.fromEntries(new FormData(e.currentTarget));
    try {
      await mutation(
        mode === "login"
          ? "auth/login"
          : mode === "change"
            ? "auth/change-password"
            : "auth/reset",
        d,
        csrf,
      );
      if (mode === "login") window.location.assign("/");
      else setDone(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (done)
    return (
      <div className="notice success" role="status">
        Password saved. All previous sessions are signed out.{" "}
        <a href="/login">Sign in again →</a>
      </div>
    );
  return (
    <form onSubmit={submit} className="form-stack">
      {mode === "login" ? (
        <label>
          Email or username
          <input
            name="identifier"
            autoComplete="username"
            required
            maxLength={254}
            autoFocus
          />
        </label>
      ) : mode === "change" ? (
        <label>
          Current password
          <input
            name="current"
            type="password"
            autoComplete="current-password"
            required
            maxLength={512}
          />
        </label>
      ) : (
        <label>
          Private reset token
          <input
            name="token"
            autoComplete="off"
            required
            pattern="[a-f0-9]{64}"
            maxLength={64}
          />
        </label>
      )}
      <label>
        {mode === "login" ? "Password" : "New password"}
        <input
          name="password"
          type="password"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          required
          maxLength={512}
          minLength={mode === "login" ? 1 : 12}
        />
      </label>
      {mode !== "login" && (
        <p className="muted small">
          12–128 characters, including a letter and a non-letter. Use a
          different password from your current one.
        </p>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <button disabled={!csrf || busy} className="button primary">
        {busy
          ? "Please wait…"
          : mode === "login"
            ? "Sign in to workspace"
            : mode === "change"
              ? "Change password"
              : "Reset password"}{" "}
        <span aria-hidden>↗</span>
      </button>
    </form>
  );
}
export function Logout({ csrf }: { csrf: string }) {
  const [error, setError] = useState("");
  return (
    <>
      <button
        className="logout"
        onClick={async () => {
          try {
            await mutation("auth/logout", {}, csrf);
            window.location.assign("/login");
          } catch {
            setError("Sign out failed. Try again.");
          }
        }}
      >
        ↪ <span>Sign out</span>
      </button>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
