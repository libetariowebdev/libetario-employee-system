import "server-only";
import Link from "next/link";
import { z } from "zod";
import { attendanceLabel, duration, manilaInput } from "@/lib/attendance";
import { timeFilters } from "@/lib/work-time";
import type { WorkSession } from "@/server/dal/work";
import { HttpError } from "@/server/auth/security";
import { currentAttendance } from "@/server/services/attendance";
import * as t from "@/server/services/work-time";
import {
  DailyEditor,
  LiveWork,
  SegmentReview,
  TimeSettings,
  TimerControls,
} from "./time-controls";

const date = (value: string | null) =>
  value ? manilaInput(value).replace("T", " ") : "—";
const skipNumber = (value?: string) =>
  z.coerce
    .number()
    .int()
    .min(0)
    .max(50000)
    .parse(value ?? 0);

function Pager({
  search,
  skip,
  pageSize,
  more,
}: {
  search: Record<string, string>;
  skip: number;
  pageSize: number;
  more: boolean;
}) {
  const url = (next: number) =>
    "?" + new URLSearchParams({ ...search, skip: String(next) });
  return (
    <nav className="work-actions" aria-label="Results pages">
      {skip > 0 && (
        <Link href={url(Math.max(0, skip - pageSize))}>Previous page</Link>
      )}
      {more && <Link href={url(skip + pageSize)}>Next page</Link>}
    </nav>
  );
}

export async function LedgerPage({
  w,
  search,
}: {
  w: WorkSession;
  search: Record<string, string>;
}) {
  const skip = skipNumber(search.skip);
  const [snapshot, attendance] = await Promise.all([
    t.ledger(w, search.employeeId, skip),
    w.admin ? null : currentAttendance(w),
  ]);
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">TIME RECORDS</p>
          <h1>Task time</h1>
        </div>
      </div>
      {attendance && (
        <TimerControls
          snapshot={snapshot}
          csrf={w.csrf}
          ready={!!attendance.active}
          onBreak={
            !!attendance.active?.breaks.some((b) => !b.ended_at && !b.is_voided)
          }
        />
      )}
      {!w.admin && (
        <p>
          Open <Link href="/work/tasks">My tasks</Link> to start a timer or
          switch tasks.
        </p>
      )}
      <div className="card table-card table-scroll">
        <table>
          <thead>
            <tr>
              <th>Task</th>
              <th>Kind</th>
              <th>Effective start · Manila</th>
              <th>Effective end · Manila</th>
              <th>Duration</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.items.slice(0, 50).map((s) => (
              <tr key={s.id}>
                <th scope="row">
                  <Link
                    href={
                      w.admin
                        ? "/admin/time/segments/" + s.id
                        : "/work/time/" + s.id
                    }
                  >
                    {s.task_label}
                  </Link>
                  <small className="block">{s.project_label}</small>
                </th>
                <td>{attendanceLabel(s.kind)}</td>
                <td>{date(s.started_at)}</td>
                <td>{s.ended_at ? date(s.ended_at) : "Open"}</td>
                <td>{duration(s.seconds)}</td>
                <td>{s.end_reason ? attendanceLabel(s.end_reason) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!snapshot.items.length && <p>No segments recorded.</p>}
      <Pager
        search={search}
        skip={skip}
        pageSize={50}
        more={snapshot.items.length > 50}
      />
    </>
  );
}

export async function SegmentPage({ w, id }: { w: WorkSession; id: string }) {
  const [s, history] = await Promise.all([
    t.segmentDetail(w, id),
    t.ledger(w, undefined, 0, id),
  ]);
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">TASK SEGMENT · DUTY DATE {s.duty_date}</p>
          <h1>{s.task_label}</h1>
          <p>
            {s.project_label} · {attendanceLabel(s.kind)} ·{" "}
            {duration(s.seconds)}
          </p>
        </div>
      </div>
      <section className="card work-panel">
        <p>
          Recorded: {date(s.recorded_start)} → {date(s.recorded_end)} Manila
        </p>
        <p>
          Effective: {date(s.started_at)} → {date(s.ended_at)} Manila
        </p>
        {s.revision_review_id && <p>Revision review: {s.revision_review_id}</p>}
        {s.end_reason && (
          <p>
            Segment ended by {attendanceLabel(s.end_reason)}.{" "}
            {s.timer_close_reason
              ? "Timer closed by " + attendanceLabel(s.timer_close_reason) + "."
              : ""}
          </p>
        )}
        {s.ended_at === s.started_at && (
          <p className="notice">Zero-duration interval retained for review.</p>
        )}
        {s.observed_end &&
          s.recorded_end &&
          s.observed_end < s.recorded_end && (
            <p className="notice">
              The observed server time was earlier than the recorded boundary.
            </p>
          )}
        <Link
          href={(w.admin ? "/admin" : "/work") + "/attendance/" + s.shift_id}
        >
          View linked attendance shift
        </Link>
      </section>
      {history.adjustments.length > 0 && (
        <section className="card work-panel">
          <h2>Correction history</h2>
          <ul>
            {history.adjustments.map((a) => (
              <li key={a.id}>
                {date(a.before_start)} → {date(a.before_end)} changed to{" "}
                {date(a.after_start)} → {date(a.after_end)} · {a.reason}
              </li>
            ))}
          </ul>
        </section>
      )}
      {w.admin && (
        <section className="card work-panel">
          <h2>Correct segment</h2>
          {s.shift_closed_at && s.root_state === "STOPPED" ? (
            <SegmentReview key={s.version} csrf={w.csrf} segment={s} />
          ) : (
            <p>
              Close the shift and stop the timer before correcting the segment.
            </p>
          )}
        </section>
      )}
    </>
  );
}

export async function DailyPage({
  w,
  search,
}: {
  w: WorkSession;
  search: Record<string, string>;
}) {
  const day = search.date ?? (await t.report(w, {})).from;
  const skip = skipNumber(search.skip);
  const subject = search.employeeId;
  const data = !w.admin || subject ? await t.readDaily(w, day, subject) : null;
  const catalog = w.admin && !subject ? await t.dailyCatalog(w, day, skip) : [];
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">MANILA CALENDAR DATE</p>
          <h1>{w.admin ? "Daily reports" : "Daily report"}</h1>
        </div>
      </div>
      <form className="work-actions">
        <label>
          Date <input type="date" name="date" defaultValue={day} required />
        </label>
        {subject && <input type="hidden" name="employeeId" value={subject} />}
        <button className="button secondary">Open date</button>
        {subject && (
          <Link href={`?date=${day}`}>All employees on this date</Link>
        )}
      </form>
      {!w.admin && data && <DailyEditor key={day} data={data} csrf={w.csrf} />}
      {w.admin && data && (
        <section className="card work-panel">
          <h2>
            {data.report
              ? attendanceLabel(data.report.state)
              : "No report on this date"}
          </h2>
          {data.report && (
            <>
              {[
                ["Work in progress", data.report.work_in_progress],
                ["Issues", data.report.issues],
                ["Notes", data.report.notes],
                ["Next steps", data.report.next_steps],
              ].map(([label, value]) => (
                <div key={label}>
                  <h3>{label}</h3>
                  <p className="work-text">{value || "—"}</p>
                </div>
              ))}
              <h3>Included entries</h3>
              <ul>
                {data.entries
                  .filter((e) => e.included)
                  .map((e) => (
                    <li key={e.id}>
                      {e.project_label} · {e.task_label}{" "}
                      {e.reported_complete
                        ? "(employee reported complete)"
                        : ""}
                      <p className="work-text">{e.description}</p>
                    </li>
                  ))}
              </ul>
            </>
          )}
        </section>
      )}
      {w.admin && !subject && (
        <section className="card work-panel">
          <ul>
            {catalog.slice(0, 50).map((row) => (
              <li key={row.id}>
                <Link href={`?date=${day}&employeeId=${row.employee_id}`}>
                  {row.employee_name} · {attendanceLabel(row.state)}
                </Link>
              </li>
            ))}
          </ul>
          {!catalog.length && <p>No daily reports for this date.</p>}
          <Pager
            search={search}
            skip={skip}
            pageSize={50}
            more={catalog.length > 50}
          />
        </section>
      )}
    </>
  );
}

const labels: Record<string, string> = {
  summary: "Attendance and task comparison",
  tasks: "Task totals by contributor",
  segments: "Task segment sources",
  attendance: "Attendance and break sources",
  approvals: "Stored shift reviews",
  attendance_seconds: "Gross attendance",
  paid_break_seconds: "Paid breaks",
  unpaid_break_seconds: "Unpaid breaks",
  original_seconds: "Original time",
  revision_seconds: "Revision time",
  task_seconds: "Task time",
  gap_seconds: "Unallocated gap (review only)",
};
export async function ReportsPage({
  w,
  search,
}: {
  w: WorkSession;
  search: Record<string, string>;
}) {
  const filters = timeFilters.parse(search);
  const skip = skipNumber(search.skip);
  const [options, result] = await Promise.all([
    t.reportOptions(w),
    t.report(w, filters).catch((error: unknown) => {
      if (error instanceof HttpError && error.status === 400) return null;
      throw error;
    }),
  ]);
  const columns = t.reportColumns[filters.view];
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">ASIA/MANILA · EXACT DURATIONS</p>
          <h1>Time reports</h1>
        </div>
      </div>
      <form className="card work-panel form-stack">
        <div className="form-grid">
          <label>
            From (inclusive)
            <input
              name="from"
              type="date"
              defaultValue={filters.from ?? result?.from}
              required
            />
          </label>
          <label>
            Through (inclusive)
            <input
              name="to"
              type="date"
              defaultValue={filters.to ?? result?.to}
              required
            />
          </label>
          <label>
            Group by
            <select name="grain" defaultValue={filters.grain}>
              <option value="day">Day</option>
              <option value="week">Week</option>
            </select>
          </label>
          <label>
            Report
            <select name="view" defaultValue={filters.view}>
              {Object.keys(t.reportColumns).map((v) => (
                <option key={v} value={v}>
                  {labels[v]}
                </option>
              ))}
            </select>
          </label>
          {w.admin && (
            <label>
              Employee / assignee
              <select name="employeeId" defaultValue={filters.employeeId ?? ""}>
                <option value="">All employees</option>
                {options.employees.map((e) => (
                  <option value={e.id} key={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Project (task rows)
            <select name="projectId" defaultValue={filters.projectId ?? ""}>
              <option value="">All projects</option>
              {options.projects.map((p) => (
                <option value={p.id} key={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Status
            <select name="status" defaultValue={filters.status ?? ""}>
              <option value="">All statuses</option>
              {[
                "PENDING",
                "IN_PROGRESS",
                "REVISION_REQUIRED",
                "SUBMITTED",
                "APPROVED",
                "CANCELLED",
                "WITHDRAWN",
                "REJECTED",
              ].map((v) => (
                <option key={v} value={v}>
                  {attendanceLabel(v)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button className="button primary">Run report</button>
      </form>
      <p>
        Comparison rows show full attendance and task totals for the employee
        and period, even when a filter selects the rows. The gap is a review
        signal. Breaks and stored shift reviews stay separate.
      </p>
      {result ? (
        <>
          <div className="work-actions">
            <p>
              {result.rows.length} rows · Snapshot {date(result.asOf)} Manila
            </p>
            <a
              className="button secondary"
              href={
                "/api/time/export.csv?" +
                new URLSearchParams({
                  ...search,
                  from: result.from,
                  to: result.to,
                })
              }
            >
              Download CSV
            </a>
          </div>
          <div className="card table-card table-scroll">
            <table>
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c}>{labels[c] ?? attendanceLabel(c)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.slice(skip, skip + 50).map((r, i) => (
                  <tr key={skip + i}>
                    {columns.map((c) => (
                      <td key={c}>
                        {c === "source_id" &&
                        filters.view === "segments" &&
                        r.source_id ? (
                          <Link
                            href={
                              w.admin
                                ? "/admin/time/segments/" + r.source_id
                                : "/work/time/" + r.source_id
                            }
                          >
                            View segment
                          </Link>
                        ) : c === "shift_id" && r.shift_id ? (
                          <Link
                            href={
                              (w.admin ? "/admin" : "/work") +
                              "/attendance/" +
                              r.shift_id
                            }
                          >
                            View shift
                          </Link>
                        ) : c.endsWith("seconds") ? (
                          duration(r[c] == null ? null : String(r[c]))
                        ) : c.endsWith("_at") ||
                          c.endsWith("_start") ||
                          c.endsWith("_end") ? (
                          date(r[c] as string | null)
                        ) : Array.isArray(r[c]) ? (
                          (r[c] as string[]).map(attendanceLabel).join(", ")
                        ) : (
                          (r[c] ?? "—")
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager
            search={search}
            skip={skip}
            pageSize={50}
            more={result.rows.length > skip + 50}
          />
        </>
      ) : (
        <p className="notice" role="status">
          The report exceeds the allowed date or row limit. Narrow the filters
          and try again.
        </p>
      )}
      {w.admin && (
        <TimeSettings
          configuration={(await t.ledger(w)).configuration}
          csrf={w.csrf}
        />
      )}
    </>
  );
}

export async function LivePage({
  w,
  search,
}: {
  w: WorkSession;
  search: Record<string, string>;
}) {
  const skip = skipNumber(search.skip);
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">OPERATIONS · MANILA TODAY</p>
          <h1>Live work</h1>
        </div>
      </div>
      <LiveWork key={skip} initial={await t.live(w, skip)} skip={skip} />
    </>
  );
}
