import { redirect } from "next/navigation";
import { pageSession } from "@/server/page-session";
import { dutyStatus } from "@/server/services/duty";
import { DutySignIn } from "@/components/duty-console";
export const dynamic = "force-dynamic";
export default async function DutyPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const s = await pageSession();
  if (s.role !== "EMPLOYEE") redirect("/admin/duty");
  const q = await searchParams,
    data = await dutyStatus(s, q.date);
  return (
    <main className="simple-auth">
      <a className="text-brand" href="/me">
        libetario ↗
      </a>
      <section className="card form-stack">
        <p className="eyebrow">MY DUTY AUTHORIZATION</p>
        <h1>Secure duty access.</h1>
        <p className="small muted">
          Fetched{" "}
          {data.fetchedAt.toLocaleString("en-PH", { timeZone: "Asia/Manila" })}
        </p>
        <form method="GET" className="form-stack">
          <label>
            Duty date
            <input type="date" name="date" defaultValue={data.date} required />
          </label>
          <button className="button secondary">
            Load date / refresh status
          </button>
        </form>
        {data.grants.map((g) => (
          <div className="notice" key={g.id}>
            <strong>
              {g.duty_date.toISOString().slice(0, 10)} · {g.status}
            </strong>
            <p className="small">
              Until{" "}
              {g.valid_until.toLocaleString("en-PH", {
                timeZone: "Asia/Manila",
              })}
              {g.overnight_allowed ? " · explicit overnight window" : ""} ·
              version {g.authorization_version}
            </p>
          </div>
        ))}
        {data.grants.length === 0 && (
          <p className="notice">
            No authorization for this date or valid overnight carry. Ask your
            administrator.
          </p>
        )}
        <DutySignIn csrf={s.csrf} date={data.date} />
        <a href="/duty/context">Open duty-protected context</a>
        <a href="/duty/reauth">Resume the same duty authorization</a>
        <a href="/me">← Workspace</a>
      </section>
    </main>
  );
}
