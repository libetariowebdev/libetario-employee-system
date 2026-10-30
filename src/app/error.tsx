"use client";
export default function Error({ reset }: { reset: () => void }) {
  return (
    <div className="card">
      <h1>Unable to load this page.</h1>
      <p className="muted">
        Try again, or sign in if your session has expired.
      </p>
      <button className="button primary" onClick={reset}>
        Try again
      </button>{" "}
      <a className="text-link" href="/login">
        Sign in
      </a>
    </div>
  );
}
