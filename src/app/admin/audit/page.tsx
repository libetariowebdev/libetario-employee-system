import { pageSession } from "@/server/page-session";
import { scoped } from "@/server/db";
export default async function Audit() {
  const s = await pageSession(true),
    events = await scoped(s.hash, (tx) =>
      tx.audit_log.findMany({ orderBy: { occurred_at: "desc" }, take: 50 }),
    );
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">ACCOUNTABILITY</p>
          <h1>
            Audit trail<span className="heading-dot">.</span>
          </h1>
          <p className="muted">
            The most recent 50 immutable events. Times shown in Asia/Manila.
          </p>
        </div>
        <span className="pill">APPEND-ONLY</span>
      </div>
      <div className="card table-card">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>WHEN</th>
                <th>ACTION</th>
                <th>ACTOR</th>
                <th>RECORDED DETAILS</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td>
                    {e.occurred_at.toLocaleString("en-PH", {
                      timeZone: "Asia/Manila",
                    })}
                  </td>
                  <td className="mono">{e.action}</td>
                  <td className="small">
                    {e.actor_user_id ?? "System / setup"}
                  </td>
                  <td>
                    <details>
                      <summary>View change</summary>
                      <pre className="audit-pre">
                        {JSON.stringify(e.payload, null, 2)}
                      </pre>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
