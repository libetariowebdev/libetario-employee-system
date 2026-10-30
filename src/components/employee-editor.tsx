"use client";
import { useState } from "react";
import { mutation } from "./forms";
type Employee = {
  user_id: string;
  employee_number: string;
  legal_name: string;
  display_name: string;
  contact: string | null;
  designation: string;
  start_date: string;
  employment_status: string;
  version: number;
  email: string;
  username: string;
};
const fields = [
  ["employee_number", "Employee ID"],
  ["legal_name", "Legal name"],
  ["display_name", "Display name"],
  ["email", "Email"],
  ["username", "Username"],
  ["contact", "Contact (optional)"],
  ["designation", "Designation"],
  ["start_date", "Start date"],
] as const;
export function EmployeeEditor({
  csrf,
  initial,
}: {
  csrf: string;
  initial?: Employee;
}) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [created, setCreated] = useState<{
      id: string;
      temporaryPassword: string;
    } | null>(null),
    [saved, setSaved] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setSaved(false);
    const d = Object.fromEntries(new FormData(e.currentTarget));
    const data = {
      ...d,
      contact: d.contact || null,
      ...(initial ? { version: initial.version } : {}),
    };
    try {
      const r = await mutation(
        initial ? "admin/employees/" + initial.user_id : "admin/employees",
        data,
        csrf,
        initial ? "PATCH" : "POST",
      );
      if (initial) {
        setSaved(true);
        window.location.reload();
      } else setCreated(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (created)
    return (
      <div className="card">
        <span className="status active">Account created</span>
        <h2>Deliver these credentials privately.</h2>
        <p className="muted">
          The temporary password is shown once. The employee must change it
          before viewing their profile.
        </p>
        <code className="secret">{created.temporaryPassword}</code>
        <p className="small">
          If it is lost, issue a password-reset token from their profile.
        </p>
        <a className="button primary" href={"/admin/employees/" + created.id}>
          Open employee profile →
        </a>
      </div>
    );
  return (
    <form className="card form-stack" onSubmit={submit}>
      <div className="form-grid">
        {fields.map(([key, label]) => (
          <label key={key}>
            {label}
            <input
              name={key}
              defaultValue={initial?.[key] ?? ""}
              required={key !== "contact"}
              maxLength={key === "email" ? 254 : 160}
              type={
                key === "start_date"
                  ? "date"
                  : key === "email"
                    ? "email"
                    : "text"
              }
              autoComplete="off"
              pattern={key === "username" ? "[a-z0-9_.-]{3,40}" : undefined}
            />
          </label>
        ))}
        {initial && (
          <label>
            Account status
            <select
              name="employment_status"
              defaultValue={initial.employment_status}
            >
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive — revoke access</option>
            </select>
          </label>
        )}
      </div>
      {initial ? (
        <label>
          Reason for this change
          <textarea name="reason" minLength={10} maxLength={500} required />
        </label>
      ) : (
        <p className="muted small">
          A unique temporary password will be generated. Rates and schedules are
          configured separately after creation.
        </p>
      )}
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {saved && <p role="status">Saved.</p>}
      <button className="button primary" disabled={busy}>
        {busy
          ? "Saving…"
          : initial
            ? "Save employee changes"
            : "Create employee account"}{" "}
        ↗
      </button>
    </form>
  );
}
export function RateEditor({ csrf, id }: { csrf: string; id: string }) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <form
      className="card form-stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        const d = Object.fromEntries(new FormData(e.currentTarget));
        try {
          await mutation(
            "admin/employees/" + id + "/rates",
            {
              basis: d.basis,
              amount: d.amount,
              effective_from: d.effective_from,
              expected_daily_seconds: Number(d.expected_hours) * 3600,
              reason: d.reason,
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
      <div>
        <p className="eyebrow">COMPENSATION</p>
        <h2>Add an effective-dated rate</h2>
        <p className="muted small">
          The previous interval closes at the new effective date. Its amount
          remains in history.
        </p>
      </div>
      <div className="form-grid">
        <label>
          Rate basis
          <select name="basis">
            <option value="HOURLY">Hourly</option>
            <option value="DAILY">Daily</option>
          </select>
        </label>
        <label>
          Rate in PHP
          <input
            name="amount"
            inputMode="decimal"
            required
            pattern="[0-9]+(\.[0-9]{1,4})?"
            placeholder="0.0000"
          />
        </label>
        <label>
          Effective from
          <input name="effective_from" type="date" required />
        </label>
        <label>
          Expected daily hours
          <input
            name="expected_hours"
            type="number"
            min="0.25"
            max="24"
            step="0.25"
            required
          />
        </label>
      </div>
      <label>
        Reason
        <textarea name="reason" minLength={10} maxLength={500} required />
      </label>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      <button className="button primary" disabled={busy}>
        {busy ? "Saving…" : "Add rate to history"} ↗
      </button>
    </form>
  );
}
export function ScheduleEditor({ csrf, id }: { csrf: string; id: string }) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const days = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ];
  return (
    <form
      className="card form-stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        const d = new FormData(e.currentTarget);
        const rows = days.map((_, i) => {
          const n = i + 1,
            working = d.has("work" + n);
          return {
            weekday: n,
            working_day: working,
            start_local: working ? String(d.get("start" + n)) : null,
            end_local: working ? String(d.get("end" + n)) : null,
            ends_next_day: working && d.has("overnight" + n),
            paid_break_seconds: working ? Number(d.get("paid" + n)) * 60 : 0,
            unpaid_break_seconds: working
              ? Number(d.get("unpaid" + n)) * 60
              : 0,
          };
        });
        try {
          await mutation(
            "admin/employees/" + id + "/schedule",
            {
              effective_from: d.get("effective_from"),
              expected_daily_seconds: Number(d.get("expected_hours")) * 3600,
              reason: d.get("reason"),
              days: rows,
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
      <div>
        <p className="eyebrow">WORK SCHEDULE</p>
        <h2>Add a schedule version</h2>
        <p className="muted small">
          Tick working days and enter Manila local times. Unchecked days are
          non-working. Breaks are explicit policy fields; no attendance is
          deducted here.
        </p>
      </div>
      <div className="form-grid">
        <label>
          Effective from
          <input name="effective_from" type="date" required />
        </label>
        <label>
          Expected daily hours
          <input
            name="expected_hours"
            type="number"
            min="0.25"
            max="24"
            step="0.25"
            required
          />
        </label>
      </div>
      <div className="table-scroll">
        <table className="schedule-inputs">
          <thead>
            <tr>
              <th>WORKING DAY</th>
              <th>START</th>
              <th>END</th>
              <th>ENDS NEXT DAY</th>
              <th>PAID BREAK MIN</th>
              <th>UNPAID BREAK MIN</th>
            </tr>
          </thead>
          <tbody>
            {days.map((day, i) => (
              <tr key={day}>
                <td>
                  <label className="checkbox-label">
                    <input type="checkbox" name={"work" + (i + 1)} />
                    {day}
                  </label>
                </td>
                <td>
                  <input
                    aria-label={day + " start"}
                    name={"start" + (i + 1)}
                    type="time"
                    defaultValue="09:00"
                  />
                </td>
                <td>
                  <input
                    aria-label={day + " end"}
                    name={"end" + (i + 1)}
                    type="time"
                    defaultValue="17:00"
                  />
                </td>
                <td>
                  <input
                    aria-label={day + " ends next day"}
                    name={"overnight" + (i + 1)}
                    type="checkbox"
                  />
                </td>
                <td>
                  <input
                    aria-label={day + " paid break minutes"}
                    name={"paid" + (i + 1)}
                    type="number"
                    min="0"
                    max="1440"
                    defaultValue="0"
                  />
                </td>
                <td>
                  <input
                    aria-label={day + " unpaid break minutes"}
                    name={"unpaid" + (i + 1)}
                    type="number"
                    min="0"
                    max="1440"
                    defaultValue="0"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <label>
        Reason
        <textarea name="reason" minLength={10} maxLength={500} required />
      </label>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      <button className="button primary" disabled={busy}>
        {busy ? "Saving…" : "Add schedule version"} ↗
      </button>
    </form>
  );
}
export function ResetIssuer({ csrf, id }: { csrf: string; id: string }) {
  const [token, setToken] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <form
      className="card form-stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setError("");
        setBusy(true);
        try {
          const r = await mutation(
            "admin/employees/" + id + "/reset",
            { note: new FormData(e.currentTarget).get("note") },
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
      <div>
        <p className="eyebrow">ACCOUNT SECURITY</p>
        <h2>Issue a password reset</h2>
        <p className="muted small">
          Verify identity first. This revokes every existing session and
          invalidates older tokens. Deliver the token privately; it is shown
          once.
        </p>
      </div>
      <label>
        How did you verify this person's identity?
        <textarea name="note" minLength={10} maxLength={500} required />
      </label>
      {token && (
        <div className="notice success">
          <strong>Single-use reset token</strong>
          <code className="secret">{token}</code>
          <p>
            Ask the employee to open /reset-password. Default expiry: 15
            minutes.
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      <button className="button secondary" disabled={busy}>
        {busy ? "Issuing…" : "Revoke sessions & issue token"}
      </button>
    </form>
  );
}
