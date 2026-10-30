export default function NotFound() {
  return (
    <main className="simple-auth">
      <div className="card">
        <p className="eyebrow">404</p>
        <h1>Page unavailable.</h1>
        <p className="muted">
          This record does not exist or is unavailable to your account.
        </p>
        <a className="button primary" href="/">
          Return to workspace →
        </a>
      </div>
    </main>
  );
}
