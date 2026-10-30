import { pageSession } from "@/server/page-session";
import { scoped } from "@/server/db";
import { MfaResetIssuer } from "@/components/mfa-console";
type Account = {
  id: string;
  username: string;
  role: string;
  state: string | null;
};
export default async function Security() {
  const s = await pageSession(true),
    data = await scoped(s.hash, async (tx) => ({
      accounts: await tx.$queryRaw<
        Account[]
      >`SELECT u.id,u.username,u.role,e.state FROM users u LEFT JOIN LATERAL(SELECT state FROM mfa_enrollments WHERE user_id=u.id ORDER BY generation DESC LIMIT 1)e ON true WHERE u.disabled_at IS NULL ORDER BY u.username`,
      events: await tx.auth_events.findMany({
        orderBy: { occurred_at: "desc" },
        take: 50,
      }),
    }));
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">AUTHENTICATORS & ACCESS</p>
          <h1>
            Account security<span className="heading-dot">.</span>
          </h1>
          <p className="muted">
            Real enrollment states and the latest 50 security events. Times use
            Asia/Manila.
          </p>
        </div>
        <a className="button secondary" href="/mfa/security">
          My authenticator
        </a>
      </div>
      <div className="card table-card">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>ACCOUNT</th>
                <th>ROLE</th>
                <th>AUTHENTICATOR</th>
              </tr>
            </thead>
            <tbody>
              {data.accounts.map((a) => (
                <tr key={a.id}>
                  <td>{a.username}</td>
                  <td>{a.role}</td>
                  <td>{a.state ?? "Not enrolled"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="section-heading">
        <h2>Assisted recovery</h2>
      </div>
      <MfaResetIssuer
        csrf={s.csrf}
        accounts={data.accounts.filter((a) => a.id !== s.user_id)}
      />
      <div className="section-heading">
        <h2>Security events</h2>
        <a className="text-link" href="/admin/security">
          Refresh
        </a>
      </div>
      <div className="card table-card">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>WHEN</th>
                <th>EVENT</th>
                <th>OUTCOME</th>
                <th>ACCOUNT</th>
              </tr>
            </thead>
            <tbody>
              {data.events.map((e) => (
                <tr key={e.id}>
                  <td>
                    {e.occurred_at.toLocaleString("en-PH", {
                      timeZone: "Asia/Manila",
                    })}
                  </td>
                  <td>{e.event_type}</td>
                  <td>{e.outcome}</td>
                  <td className="small">{e.user_id ?? "Unknown account"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
