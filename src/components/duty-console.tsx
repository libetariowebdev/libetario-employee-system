"use client";
import { useState } from "react";
import { mutation } from "./forms";
type Challenge = {
  challenge: string;
  stage: "PIN" | "TOTP";
  csrf: string;
  expiresAt: string;
};
const stamp = (v: string) =>
  new Date(v).toLocaleString("en-PH", { timeZone: "Asia/Manila" });
export function DutyLogout({ csrf }: { csrf: string }) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <div>
      <button
        className="button secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await mutation("auth/duty/logout", {}, csrf);
            window.location.assign("/duty");
          } catch (e) {
            setError((e as Error).message);
            setBusy(false);
          }
        }}
      >
        Sign out of duty access
      </button>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
export function DutySignIn({
  csrf,
  date,
  reauth = false,
}: {
  csrf: string;
  date: string;
  reauth?: boolean;
}) {
  const [ch, setCh] = useState<Challenge | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<void>) {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="form-stack">
      <p className="muted">
        Duty date: <strong>{date}</strong>. All windows use Asia/Manila.
        Authentication records no paid time.
      </p>
      {!ch ? (
        <form
          className="form-stack"
          onSubmit={(e) => {
            e.preventDefault();
            const d = new FormData(e.currentTarget);
            run(async () =>
              setCh(
                await mutation(
                  reauth ? "auth/duty/reauth" : "auth/duty/start",
                  reauth ? {} : { date, password: d.get("password") },
                  csrf,
                ),
              ),
            );
          }}
        >
          {reauth ? (
            <p className="muted">
              Continue the same authorization with current TOTP and PIN when
              enabled.
            </p>
          ) : (
            <label>
              Current password
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                maxLength={512}
              />
            </label>
          )}
          <button className="button primary" disabled={busy}>
            {reauth
              ? "Begin same-grant reauthentication"
              : "Begin secure duty sign-in"}{" "}
            →
          </button>
        </form>
      ) : (
        <form
          className="form-stack"
          key={ch.challenge}
          onSubmit={(e) => {
            e.preventDefault();
            const code = new FormData(e.currentTarget).get("code");
            run(async () => {
              const r = await mutation(
                ch.stage === "PIN" ? "auth/duty/pin" : "auth/duty/totp",
                {
                  code,
                  challenge: ch.challenge,
                  binding: reauth ? "DUTY" : "ACCOUNT",
                },
                ch.csrf,
              );
              if (r.kind === "CHALLENGE") setCh(r);
              else window.location.assign("/duty/context");
            });
          }}
        >
          <p className="small muted">
            {ch.stage === "PIN"
              ? "Step: employee PIN"
              : "Step: authenticator code"}{" "}
            · expires {stamp(ch.expiresAt)}
          </p>
          <label>
            {ch.stage === "PIN"
              ? "Six-digit employee PIN"
              : "Current authenticator code"}
            <input
              name="code"
              type={ch.stage === "PIN" ? "password" : "text"}
              inputMode="numeric"
              autoComplete={ch.stage === "PIN" ? "off" : "one-time-code"}
              pattern="[0-9]{6}"
              minLength={6}
              maxLength={6}
              required
              autoFocus
            />
          </label>
          <button className="button primary" disabled={busy}>
            Verify {ch.stage === "PIN" ? "PIN" : "authenticator"} →
          </button>
          <button
            className="button secondary"
            disabled={busy}
            type="button"
            onClick={() => setCh(null)}
          >
            Start again
          </button>
        </form>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <p className="small">
        <a href="/mfa/security">Set up authenticator / PIN</a> ·{" "}
        <a href="/mfa/recovery">Authenticator recovery</a>
      </p>
    </div>
  );
}
type Grant = {
  id: string;
  employee_id: string;
  duty_date: string;
  status: string;
  authorization_version: number;
  valid_until: string;
  overnight_allowed: boolean;
  first_authenticated_at: string | null;
};
type Dashboard = {
  date: string;
  fetchedAt: string;
  grants: Grant[];
  employees: { id: string; display_name: string; employee_number: string }[];
  events: {
    id: string;
    user_id: string | null;
    event_type: string;
    outcome: string;
    occurred_at: string;
  }[];
};
export function DutyAdmin({
  initial,
  csrf,
  workPolicy,
}: {
  initial: Dashboard;
  csrf: string;
  workPolicy: {
    id: string;
    overnightEnabled: boolean;
    overnightCarryHours: number;
  };
}) {
  const [data, setData] = useState(initial),
    [selected, setSelected] = useState<string[]>([]),
    [date, setDate] = useState(initial.date),
    [reason, setReason] = useState(""),
    [overnight, setOvernight] = useState(false),
    [until, setUntil] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [event, setEvent] = useState(""),
    [employee, setEmployee] = useState("");
  const names = new Map(data.employees.map((e) => [e.id, e.display_name]));
  async function refresh() {
    const query = new URLSearchParams({ date });
    if (event) query.set("event", event);
    if (employee) query.set("employee", employee);
    const r = await fetch("/api/admin/duty?" + query);
    const b = await r.json();
    if (!r.ok) throw new Error(b.error);
    setData(b);
  }
  async function run(fn: () => Promise<void>) {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function mutate(ids: string[], action: string, targetDate = date) {
    await run(async () => {
      const r = await mutation(
        "admin/duty",
        {
          employeeIds: ids,
          date: targetDate,
          action,
          reason,
          overnight: action === "REVOKE" ? false : overnight,
          ...(overnight && action !== "REVOKE" && until
            ? { validUntil: new Date(until + ":00+08:00").toISOString() }
            : {}),
        },
        csrf,
      );
      setNotice(
        `${r.changed} authorization(s) changed. Identical active grants are unchanged.`,
      );
      await refresh();
    });
  }
  return (
    <div className="form-stack">
      <div className="card form-stack">
        <h2>Duty authorizations</h2>
        <p className="muted small">
          Fetched {stamp(data.fetchedAt)}. Refresh explicitly; this is
          authorization status, not clock-in or paid time.
        </p>
        <form
          className="form-row"
          onSubmit={(e) => {
            e.preventDefault();
            run(refresh);
          }}
        >
          <label>
            Duty date
            <input
              type="date"
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                setSelected([]);
              }}
              required
            />
          </label>
          <button className="button secondary" disabled={busy}>
            Load date / refresh
          </button>
        </form>
        <label>
          Reason for activation, revoke or regrant
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            minLength={10}
            maxLength={500}
            required
          />
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={overnight}
            onChange={(e) => setOvernight(e.target.checked)}
          />
          Explicit overnight window (policy must permit it)
        </label>
        {overnight && (
          <label>
            Window end in Asia/Manila
            <input
              type="datetime-local"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              required
            />
            <span className="small muted">
              Maximum configured carry: {workPolicy.overnightCarryHours} hours
              past midnight.
            </span>
          </label>
        )}
        <fieldset style={{ maxHeight: 260, overflowY: "auto" }}>
          <legend>Select active employees (maximum 100)</legend>
          {data.employees.map((e) => (
            <label className="checkbox-label" key={e.id}>
              <input
                type="checkbox"
                checked={selected.includes(e.id)}
                onChange={(v) =>
                  setSelected(
                    v.target.checked
                      ? [...selected, e.id]
                      : selected.filter((id) => id !== e.id),
                  )
                }
              />
              {e.display_name} · {e.employee_number}
            </label>
          ))}
          {data.employees.length === 0 && (
            <p className="muted">No active employees configured.</p>
          )}
        </fieldset>
        <button
          className="button primary"
          disabled={
            busy ||
            selected.length === 0 ||
            selected.length > 100 ||
            data.date !== date
          }
          onClick={() => mutate(selected, "ACTIVATE")}
        >
          Activate selected ({selected.length})
        </button>
      </div>
      <div className="card table-card">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>EMPLOYEE / DUTY DATE</th>
                <th>STATUS</th>
                <th>WINDOW END</th>
                <th>ACTION</th>
              </tr>
            </thead>
            <tbody>
              {data.grants.map((g) => (
                <tr key={g.id}>
                  <td>
                    {names.get(g.employee_id) ?? g.employee_id}
                    <div className="small muted">
                      {g.duty_date.slice(0, 10)} · version{" "}
                      {g.authorization_version}
                    </div>
                  </td>
                  <td>
                    {g.status}
                    {g.overnight_allowed ? " · overnight" : ""}
                  </td>
                  <td>{stamp(g.valid_until)}</td>
                  <td>
                    <button
                      className="button secondary"
                      disabled={busy || data.date !== date}
                      onClick={() =>
                        mutate(
                          [g.employee_id],
                          g.status === "REVOKED" ? "REGRANT" : "REVOKE",
                          g.duty_date.slice(0, 10),
                        )
                      }
                    >
                      {g.status === "REVOKED" ? "Regrant" : "Revoke"}
                    </button>
                  </td>
                </tr>
              ))}
              {data.grants.length === 0 && (
                <tr>
                  <td colSpan={4}>
                    No authorizations for this date or active overnight carry.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card form-stack">
        <h2>Redacted security log</h2>
        <form
          className="form-row"
          onSubmit={(e) => {
            e.preventDefault();
            run(refresh);
          }}
        >
          <label>
            Event type
            <input
              value={event}
              onChange={(e) => setEvent(e.target.value)}
              placeholder="e.g. DUTY_LOGIN"
              pattern="[A-Z_]{1,50}"
            />
          </label>
          <label>
            Employee
            <select
              value={employee}
              onChange={(e) => setEmployee(e.target.value)}
            >
              <option value="">All accounts</option>
              {data.employees.map((e) => (
                <option value={e.id} key={e.id}>
                  {e.display_name}
                </option>
              ))}
            </select>
          </label>
          <button className="button secondary" disabled={busy}>
            Filter / refresh
          </button>
        </form>
        <p className="small muted">
          Latest 50 events for selected date. Codes, PINs, token hashes and
          network identifiers are omitted.
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>TIME</th>
                <th>EVENT</th>
                <th>OUTCOME</th>
                <th>ACCOUNT</th>
              </tr>
            </thead>
            <tbody>
              {data.events.map((e) => (
                <tr key={e.id}>
                  <td>{stamp(e.occurred_at)}</td>
                  <td>{e.event_type}</td>
                  <td>{e.outcome}</td>
                  <td>
                    {e.user_id
                      ? (names.get(e.user_id) ?? e.user_id)
                      : "Unknown account"}
                  </td>
                </tr>
              ))}
              {data.events.length === 0 && (
                <tr>
                  <td colSpan={4}>No security events for this filter.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <OvernightPolicy csrf={csrf} initial={workPolicy} />
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
    </div>
  );
}
function OvernightPolicy({
  csrf,
  initial,
}: {
  csrf: string;
  initial: {
    id: string;
    overnightEnabled: boolean;
    overnightCarryHours: number;
  };
}) {
  const [enabled, setEnabled] = useState(initial.overnightEnabled),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <form
      className="card form-stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setError("");
        setBusy(true);
        const d = new FormData(e.currentTarget);
        try {
          await mutation(
            "admin/settings/overnight",
            {
              expectedPolicyId: initial.id,
              overnightEnabled: enabled,
              overnightCarryHours: Number(d.get("carry")),
              reason: d.get("reason"),
            },
            csrf,
          );
          window.location.reload();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2>Overnight authorization policy</h2>
      <p className="muted small">
        Disabled by default. Changing policy does not extend an existing grant.
        New overnight grants still require an explicit window. This is separate
        from future attendance/pay rules.{" "}
        <a href="/mfa/security">Verify recent MFA</a> before saving.
      </p>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        Permit explicit overnight grants
      </label>
      <label>
        Maximum carry hours after midnight
        <input
          name="carry"
          type="number"
          min={1}
          max={8}
          defaultValue={initial.overnightCarryHours}
          required
        />
      </label>
      <label>
        Policy change reason
        <textarea name="reason" minLength={10} maxLength={500} required />
      </label>
      <button className="button secondary" disabled={busy}>
        Save new work-policy version
      </button>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
    </form>
  );
}
