import { pageSession } from "@/server/page-session";
import { settings } from "@/server/services/employees";
import { securitySchema } from "@/lib/config";
import { SettingsEditor } from "@/components/settings-editor";
export default async function Settings() {
  const s = await pageSession(true),
    data = await settings(s),
    security = data.policies.find(
      (p) => p.id === data.company.security_policy_id,
    )!;
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">WORKSPACE CONFIGURATION</p>
          <h1>
            A secure foundation<span className="heading-dot">.</span>
          </h1>
          <p className="muted">
            Versioned policies with an accountable history.
          </p>
        </div>
        <span className="pill">LOCAL DEVELOPMENT</span>
      </div>
      <div className="settings-grid">
        <SettingsEditor
          csrf={s.csrf}
          configuration={securitySchema.parse(security.configuration)}
        />
        <div className="form-stack">
          <section className="card">
            <p className="eyebrow">COMPANY</p>
            <h2>{data.company.company_name}</h2>
            <dl className="facts">
              <div>
                <dt>Business timezone</dt>
                <dd>{data.company.timezone}</dd>
              </div>
              <div>
                <dt>Currency</dt>
                <dd>{data.company.currency}</dd>
              </div>
              <div>
                <dt>Deployment</dt>
                <dd>Local only</dd>
              </div>
              <div>
                <dt>Security policy</dt>
                <dd>Version {security.revision}</dd>
              </div>
            </dl>
            <p className="muted small">
              Duty, work and payroll policies below are future-phase
              configuration references. Payroll approval is unavailable.
            </p>
          </section>
          {data.policies
            .filter((p) =>
              [
                data.company.work_policy_id,
                data.company.pay_policy_id,
              ].includes(p.id),
            )
            .map((p) => (
              <section className="card" key={p.id}>
                <p className="eyebrow">
                  {p.policy_key} POLICY · VERSION {p.revision}
                </p>
                <pre className="audit-pre">
                  {JSON.stringify(p.configuration, null, 2)}
                </pre>
              </section>
            ))}
        </div>
      </div>
    </>
  );
}
