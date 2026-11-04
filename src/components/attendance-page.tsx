import Link from "next/link";
import {
  AttendanceBulk,
  AttendanceFilters,
  AttendanceRefresh,
  AttendanceSettings,
  AttendanceTable,
  ClockPanel,
  CorrectionCards,
  CorrectionForm,
  AttendanceReview,
  FlagList,
} from "./attendance-console";
import {
  attendanceDetail,
  attendanceCorrections,
  attendancePeople,
  attendancePolicy,
  currentAttendance,
  listAttendance,
} from "@/server/services/attendance";
import type { WorkSession } from "@/server/dal/work";
import { businessDate } from "@/lib/time";
import { duration } from "@/lib/attendance";
import { shiftSegments } from "@/server/services/work-time";
const time = (t: string | null) =>
  t
    ? new Intl.DateTimeFormat("en-PH", {
        timeZone: "Asia/Manila",
        dateStyle: "medium",
        timeStyle: "medium",
      }).format(new Date(t))
    : "No actual punch";
export async function AttendancePage({
  w,
  search,
}: {
  w: WorkSession;
  search: Record<string, string>;
}) {
  const [list, corrections, policy, people, current] = await Promise.all([
    listAttendance(w, search),
    attendanceCorrections(w, search),
    attendancePolicy(w),
    w.admin ? attendancePeople(w) : Promise.resolve([]),
    w.admin ? Promise.resolve(null) : currentAttendance(w),
  ]);
  const day = businessDate(new Date(list.asOf)),
    filters = {
      ...search,
      from: search.from ?? day,
      to: search.to ?? search.from ?? day,
    };
  const base = w.admin ? "/admin/attendance" : "/work/attendance",
    pageUrl = (page: number) =>
      base + "?" + new URLSearchParams({ ...filters, page: String(page) });
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">CLOCKS, BREAKS & REVIEW</p>
          <h1>{w.admin ? "Attendance review." : "My attendance."}</h1>
          <p className="muted">
            Recorded attendance stays separate from task time and payroll. All
            times use Asia/Manila.
          </p>
        </div>
        <AttendanceRefresh csrf={w.csrf} />
      </div>
      {current && <ClockPanel current={current} csrf={w.csrf} />}
      <AttendanceFilters filters={filters} people={people} />
      <p className="small muted">
        {list.total} matching shifts · Page {list.page} · Fetched{" "}
        {time(list.asOf)} · Records are grouped by their authorized duty date.
      </p>
      <AttendanceTable items={list.items} admin={w.admin} />
      <div className="work-pagination">
        {list.page > 1 ? (
          <Link className="button secondary" href={pageUrl(list.page - 1)}>
            Previous shifts
          </Link>
        ) : (
          <span>First shift page</span>
        )}
        <span>Page {list.page}</span>
        {list.page * 50 < list.total && (
          <Link className="button secondary" href={pageUrl(list.page + 1)}>
            Next shifts
          </Link>
        )}
      </div>
      {w.admin && (
        <AttendanceBulk
          key={JSON.stringify(filters)}
          filters={filters}
          csrf={w.csrf}
        />
      )}
      <CorrectionForm
        key={"missing-" + filters.from}
        missing
        policy={policy}
        date={filters.from}
        csrf={w.csrf}
        people={people}
      />
      <CorrectionCards
        items={corrections.items}
        csrf={w.csrf}
        admin={w.admin}
      />
      <p className="small muted">
        {corrections.total} correction requests · Page {corrections.page}
      </p>
      <div className="work-pagination">
        {corrections.page > 1 && (
          <Link
            className="button secondary"
            href={pageUrl(corrections.page - 1)}
          >
            Previous corrections
          </Link>
        )}
        {corrections.page * 50 < corrections.total && (
          <Link
            className="button secondary"
            href={pageUrl(corrections.page + 1)}
          >
            Next corrections
          </Link>
        )}
      </div>
      {w.admin && (
        <AttendanceSettings
          key={policy.policyId}
          policy={policy}
          csrf={w.csrf}
        />
      )}
    </>
  );
}
export async function AttendanceDetailPage({
  w,
  id,
}: {
  w: WorkSession;
  id: string;
}) {
  const row = await attendanceDetail(w, id),
    s = row.shift,
    corrections = await attendanceCorrections(w, {
      from: s.duty_date,
      to: s.duty_date,
      ...(w.admin ? { employeeId: s.employee_id } : {}),
    }),
    current = w.admin ? null : await currentAttendance(w),
    segments = w.admin ? await shiftSegments(w, id) : [];
  return (
    <>
      <div className="page-heading">
        <div>
          <Link
            className="text-link"
            href={w.admin ? "/admin/attendance" : "/work/attendance"}
          >
            ← Attendance
          </Link>
          <p className="eyebrow">
            {row.employee.number} · DUTY DATE {s.duty_date}
          </p>
          <h1>{row.employee.name}</h1>
          <p className="muted">
            {s.source === "CORRECTION"
              ? "Administrator-approved missing punch"
              : "Employee-recorded shift"}{" "}
            · {s.approval_status}
          </p>
        </div>
        <AttendanceRefresh csrf={w.csrf} />
      </div>
      {current?.active?.shift.id === id && (
        <ClockPanel current={current} csrf={w.csrf} />
      )}
      <section className="card work-panel">
        <h2>Recorded & effective attendance</h2>
        <div className="attendance-metrics">
          <div>
            <small>Gross elapsed</small>
            <strong>{duration(row.grossSeconds)}</strong>
          </div>
          <div>
            <small>Paid breaks</small>
            <strong>{duration(row.paidBreakSeconds)}</strong>
          </div>
          <div>
            <small>Unpaid breaks</small>
            <strong>{duration(row.unpaidBreakSeconds)}</strong>
          </div>
          <div>
            <small>Approved by administrator</small>
            <strong>{duration(s.approved_payable_seconds)}</strong>
          </div>
        </div>
        <div className="form-grid">
          <div>
            <h3>Original actual punches</h3>
            <p>In: {time(s.recorded_in_at)}</p>
            <p>Out: {time(s.recorded_out_at)}</p>
            {s.system_closed_at && (
              <p>
                Original system closure observed: {time(s.system_closed_at)}
              </p>
            )}
          </div>
          <div>
            <h3>Effective interval</h3>
            <p>In: {time(s.clocked_in_at)}</p>
            <p>Out: {s.clocked_out_at ? time(s.clocked_out_at) : "Open"}</p>
            <p>Closure reason: {s.close_reason ?? "Not closed"}</p>
          </div>
        </div>
        <FlagList flags={row.flags} />
        {s.review_reason && (
          <p className="notice">
            Administrator review: {s.review_reason} · {time(s.reviewed_at)}
          </p>
        )}
        <p className="small muted">
          Gross attendance, paid/unpaid breaks and explicit approved seconds are
          distinct. A task-time gap never creates a deduction. Values reflect
          the server snapshot at {time(row.asOf)}.
        </p>
      </section>
      <section className="card work-panel">
        <h2>Break history</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Code / treatment</th>
                <th>Effective start/end · Manila</th>
                <th>Original evidence</th>
                <th>Allowance</th>
              </tr>
            </thead>
            <tbody>
              {row.breaks.map((b) => (
                <tr key={b.id}>
                  <td>
                    {b.code} · {b.paid ? "paid" : "unpaid"}
                    {b.is_voided ? " · voided with correction" : ""}
                  </td>
                  <td>
                    {time(b.started_at)}
                    <small className="block muted">
                      {b.ended_at ? time(b.ended_at) : "Open"}
                    </small>
                  </td>
                  <td>
                    {time(b.recorded_start)}
                    <small className="block muted">
                      {time(b.recorded_end)}
                    </small>
                  </td>
                  <td>
                    {b.allowance_seconds === null
                      ? "Unconfigured"
                      : duration(String(b.allowance_seconds))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!row.breaks.length && <p className="muted">No breaks recorded.</p>}
        </div>
      </section>
      {w.admin && <AttendanceReview key={s.version} row={row} csrf={w.csrf} />}
      <CorrectionForm key={"correction-" + s.version} row={row} csrf={w.csrf} />
      <CorrectionCards
        items={corrections.items.filter((c) => c.target_shift_id === id)}
        csrf={w.csrf}
        admin={w.admin}
        segments={segments.slice(0, 100)}
      />
    </>
  );
}
