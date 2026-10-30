import { formatDate, formatPHP } from "./profile-utils";
import type { employeeDetails } from "@/server/services/employees";
type Profile = Awaited<ReturnType<typeof employeeDetails>>;
export function ProfileHistory({ profile: p }: { profile: Profile }) {
  return (
    <>
      <div className="section-heading">
        <div>
          <h2>Rate history</h2>
          <p className="muted small">
            Your individual rate and the dates it applies.
          </p>
        </div>
        <span className="pill">PHP</span>
      </div>
      <div className="card table-card">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>BASIS</th>
                <th>RATE</th>
                <th>EFFECTIVE FROM</th>
                <th>UNTIL (EXCLUSIVE)</th>
                <th>EXPECTED HOURS</th>
              </tr>
            </thead>
            <tbody>
              {p.employee_rate_history.map((r) => (
                <tr key={r.id}>
                  <td>{r.basis === "DAILY" ? "Daily" : "Hourly"}</td>
                  <td className="mono">
                    {formatPHP(r.amount)}
                    <small className="rate-precision">
                      Exact rate: {r.amount}
                    </small>
                  </td>
                  <td>{formatDate(r.effective_from)}</td>
                  <td>
                    {r.effective_to ? formatDate(r.effective_to) : "Open-ended"}
                  </td>
                  <td>{r.expected_daily_seconds / 3600}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!p.employee_rate_history.length && (
            <p className="empty">
              No rate configured. Your administrator can add one.
            </p>
          )}
        </div>
      </div>
      <div className="section-heading">
        <div>
          <h2>Schedule history</h2>
          <p className="muted small">All clock times use Asia/Manila.</p>
        </div>
      </div>
      {!p.employee_schedule_history.length && (
        <div className="card empty">No schedule configured.</div>
      )}
      {p.employee_schedule_history.map((s) => (
        <div className="card table-card schedule-history" key={s.id}>
          <div className="table-caption">
            <strong>
              {formatDate(s.effective_from)} —{" "}
              {s.effective_to ? formatDate(s.effective_to) : "Open-ended"}
            </strong>
            <span>{s.expected_daily_seconds / 3600} expected hours/day</span>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>DAY</th>
                  <th>LOCAL HOURS</th>
                  <th>PAID BREAK</th>
                  <th>UNPAID BREAK</th>
                </tr>
              </thead>
              <tbody>
                {s.employee_schedule_days.map((d) => (
                  <tr key={d.weekday}>
                    <td>
                      {
                        [
                          "Monday",
                          "Tuesday",
                          "Wednesday",
                          "Thursday",
                          "Friday",
                          "Saturday",
                          "Sunday",
                        ][d.weekday - 1]
                      }
                    </td>
                    <td>
                      {d.working_day
                        ? `${d.start_local?.toISOString().slice(11, 16)} – ${d.end_local?.toISOString().slice(11, 16)}${d.ends_next_day ? " (+1 day)" : ""}`
                        : "Non-working"}
                    </td>
                    <td>{d.paid_break_seconds / 60} min</td>
                    <td>{d.unpaid_break_seconds / 60} min</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </>
  );
}
