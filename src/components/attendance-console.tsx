"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Decimal from "decimal.js";
import { mutation } from "./forms";
import { SegmentFields, segmentFields } from "./time-controls";
import type { Segment } from "@/server/services/work-time";
import {
  attendanceLabel,
  duration,
  manilaInput,
  manilaInstant,
  type AttendancePolicy,
} from "@/lib/attendance";
import type {
  AttendanceRow,
  Correction,
  CurrentAttendance,
  BulkPreview,
} from "@/server/services/attendance";
type People = { id: string; name: string; number: string }[];
const stamp = (v: string | null) =>
  v
    ? new Intl.DateTimeFormat("en-PH", {
        timeZone: "Asia/Manila",
        dateStyle: "medium",
        timeStyle: "medium",
      }).format(new Date(v))
    : "Not recorded";
function useAction(csrf: string) {
  const router = useRouter(),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    receipt = useRef<{ payload: string; key: string } | null>(null);
  async function run(
    path: string,
    data: Record<string, unknown>,
    success = "Saved.",
  ) {
    setBusy(true);
    setError("");
    setMessage("");
    const payload = JSON.stringify({ path, data });
    if (receipt.current?.payload !== payload)
      receipt.current = { payload, key: crypto.randomUUID() };
    try {
      const result = await mutation(
        "attendance/" + path,
        { ...data, operationKey: receipt.current.key },
        csrf,
      );
      setMessage(success);
      receipt.current = null;
      router.refresh();
      return result;
    } catch (e) {
      setError((e as Error).message);
      router.refresh();
      return null;
    } finally {
      setBusy(false);
    }
  }
  return {
    busy,
    run,
    feedback: (
      <>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        {message && (
          <p className="notice success" role="status">
            {message}
          </p>
        )}
      </>
    ),
  };
}
export function AttendanceRefresh({ csrf }: { csrf: string }) {
  const a = useAction(csrf);
  return (
    <div>
      <button
        className="button secondary"
        disabled={a.busy}
        onClick={() =>
          a.run(
            "reconcile",
            {},
            "Attendance refreshed; due exceptions checked.",
          )
        }
      >
        Refresh & check due records
      </button>
      {a.feedback}
    </div>
  );
}
export function ClockPanel({
  current,
  csrf,
}: {
  current: CurrentAttendance;
  csrf: string;
}) {
  const a = useAction(csrf),
    row = current.active,
    s = row?.shift,
    [code, setCode] = useState("MEAL"),
    open = row?.breaks.find((b) => !b.ended_at && !b.is_voided);
  const codes = s?.policy_snapshot.breakCodes ?? current.policy.breakCodes;
  return (
    <section className="card work-panel">
      <p className="eyebrow">
        MY ATTENDANCE · DUTY DATE {current.duty.duty_date}
      </p>
      <h2>{s ? "You are clocked in." : "Ready to Clock In."}</h2>
      <p className="muted">
        Fetched {stamp(current.asOf)} · Asia/Manila. Sign-in alone records no
        attendance.
      </p>
      {row && (
        <>
          <p>
            Attendance elapsed <strong>{duration(row.grossSeconds)}</strong> ·
            Unpaid breaks {duration(row.unpaidBreakSeconds)} · Paid breaks{" "}
            {duration(row.paidBreakSeconds)}
          </p>
          <p>
            {open
              ? `On ${open.code} break (${open.paid ? "paid" : "unpaid"}).`
              : "No break running."}
          </p>
          <FlagList flags={row.flags} />
        </>
      )}
      <div className="work-actions">
        {!s ? (
          <button
            className="button primary"
            disabled={a.busy}
            onClick={() =>
              a.run("clock-in", {}, "Clock In recorded by the server.")
            }
          >
            Clock In
          </button>
        ) : (
          <>
            <button
              className="button primary"
              disabled={a.busy}
              onClick={() =>
                a.run(
                  `shifts/${s.id}/clock-out`,
                  { expectedVersion: s.version },
                  "Clock Out recorded; the open break was ended too.",
                )
              }
            >
              Clock Out
            </button>
            {open ? (
              <button
                className="button secondary"
                disabled={a.busy}
                onClick={() =>
                  a.run(
                    `breaks/${open.id}/end`,
                    { expectedVersion: open.version },
                    "Break ended.",
                  )
                }
              >
                End {open.code} break
              </button>
            ) : (
              <>
                <label className="attendance-inline">
                  Break type
                  <select
                    value={
                      codes.some((c) => c.code === code) ? code : codes[0].code
                    }
                    onChange={(e) => setCode(e.target.value)}
                  >
                    {codes.map((c) => (
                      <option value={c.code} key={c.code}>
                        {c.code} · {c.paid ? "paid" : "unpaid"}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="button secondary"
                  disabled={a.busy}
                  onClick={() =>
                    a.run(
                      `shifts/${s.id}/breaks`,
                      {
                        expectedVersion: s.version,
                        code: codes.some((c) => c.code === code)
                          ? code
                          : codes[0].code,
                      },
                      "Break started.",
                    )
                  }
                >
                  Start break
                </button>
              </>
            )}
            <Link
              className="button secondary"
              href={"/work/attendance/" + s.id}
            >
              Shift detail & corrections
            </Link>
          </>
        )}
      </div>
      {a.feedback}
    </section>
  );
}
export function FlagList({ flags }: { flags: string[] }) {
  return flags.length ? (
    <div className="notice">
      <strong>Review flags</strong>
      <ul>
        {flags.map((f) => (
          <li key={f}>{attendanceLabel(f)}</li>
        ))}
      </ul>
    </div>
  ) : (
    <p className="small muted">No review flags.</p>
  );
}
export function AttendanceFilters({
  filters,
  people = [],
}: {
  filters: Record<string, string>;
  people?: People;
}) {
  return (
    <form className="work-filters">
      <label>
        Duty date from
        <input type="date" name="from" defaultValue={filters.from} required />
      </label>
      <label>
        Duty date through
        <input type="date" name="to" defaultValue={filters.to} required />
      </label>
      {people.length > 0 && (
        <label>
          Employee
          <select name="employeeId" defaultValue={filters.employeeId ?? ""}>
            <option value="">All employees</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.number}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Review status
        <select name="status" defaultValue={filters.status ?? "ALL"}>
          {["ALL", "PENDING", "APPROVED", "REJECTED"].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>
      <label className="check-row">
        <input
          type="checkbox"
          name="flagged"
          value="true"
          defaultChecked={filters.flagged === "true"}
        />
        Flagged only
      </label>
      <button className="button secondary">Apply filters</button>
    </form>
  );
}
export function AttendanceTable({
  items,
  admin,
}: {
  items: AttendanceRow[];
  admin: boolean;
}) {
  return (
    <div className="card table-card">
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {[
                "Employee / duty date",
                "Clock In / Out · Manila",
                "Gross elapsed",
                "Unpaid / paid breaks",
                "Review",
                "Flags",
              ].map((x) => (
                <th key={x}>{x}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.shift.id}>
                <td>
                  <Link
                    className="text-link"
                    href={
                      (admin ? "/admin/attendance/" : "/work/attendance/") +
                      r.shift.id
                    }
                  >
                    {r.employee.name} ↗
                  </Link>
                  <small className="block muted">
                    {r.shift.duty_date} ·{" "}
                    {r.shift.source === "CORRECTION"
                      ? "Corrected missing punch"
                      : "Recorded shift"}
                  </small>
                </td>
                <td>
                  {stamp(r.shift.clocked_in_at)}
                  <small className="block muted">
                    {r.shift.clocked_out_at
                      ? stamp(r.shift.clocked_out_at)
                      : "Open"}
                  </small>
                </td>
                <td>{duration(r.grossSeconds)}</td>
                <td>
                  {duration(r.unpaidBreakSeconds)} /{" "}
                  {duration(r.paidBreakSeconds)}
                </td>
                <td>
                  {attendanceLabel(r.shift.approval_status)}
                  <small className="block muted">
                    {r.shift.approved_payable_seconds === null
                      ? "Approved seconds not set"
                      : duration(r.shift.approved_payable_seconds)}
                  </small>
                </td>
                <td>
                  {r.flags.length
                    ? r.flags.map(attendanceLabel).join(", ")
                    : "None"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!items.length && (
          <p className="empty">No attendance records match these filters.</p>
        )}
      </div>
    </div>
  );
}
export function AttendanceReview({
  row,
  csrf,
}: {
  row: AttendanceRow;
  csrf: string;
}) {
  const a = useAction(csrf),
    [decision, setDecision] = useState("APPROVED"),
    [mode, setMode] = useState("SUGGESTED");
  const reasonRequired =
    decision === "REJECTED" || mode === "OVERRIDE" || row.flags.length > 0;
  return (
    <section className="card work-panel">
      <h2>Attendance review</h2>
      <p>
        <strong>SUGGESTED: {duration(row.suggestedSeconds)}</strong> (
        {row.suggestedSeconds ?? "not available"} seconds)
      </p>
      <p className="small muted">
        Effective elapsed minus recorded unpaid breaks. This is a review aid.
        Nothing is approved until you record a decision. No extra deduction is
        added for an allowance overrun.
      </p>
      <form
        className="form-stack"
        onSubmit={(e) => {
          e.preventDefault();
          const d = new FormData(e.currentTarget);
          void a.run(
            `shifts/${row.shift.id}/review`,
            {
              expectedVersion: row.shift.version,
              decision,
              mode,
              ...(mode === "OVERRIDE" ? { value: String(d.get("value")) } : {}),
              reason: String(d.get("reason")),
              acknowledgeFlags: d.get("ack") === "on",
            },
            "Attendance review recorded.",
          );
        }}
      >
        <label>
          Decision
          <select
            value={decision}
            onChange={(e) => setDecision(e.target.value)}
          >
            <option value="APPROVED">Approve</option>
            <option value="REJECTED">Reject</option>
          </select>
        </label>
        <label>
          Value choice
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="SUGGESTED">Accept suggested seconds</option>
            <option value="OVERRIDE">Override seconds</option>
          </select>
        </label>
        {mode === "OVERRIDE" && (
          <label>
            Approved seconds · exact decimal
            <input
              name="value"
              inputMode="decimal"
              required
              pattern="[0-9]+(\.[0-9]{1,6})?"
              placeholder="Example: 28800"
            />
          </label>
        )}
        <label>
          Review / override reason
          {reasonRequired
            ? " · required"
            : " · optional when accepting a clean suggestion"}
          <textarea
            name="reason"
            rows={3}
            minLength={reasonRequired ? 10 : undefined}
            maxLength={2000}
            required={reasonRequired}
          />
        </label>
        {row.flags.length > 0 && (
          <label className="check-row">
            <input name="ack" type="checkbox" required />I reviewed and
            acknowledge every listed flag.
          </label>
        )}
        <p className="small muted">
          Recent administrator MFA is required. The upper bound is gross elapsed
          ({row.grossSeconds} seconds). Open shifts and pending corrections must
          be resolved first.
        </p>
        <button
          className="button primary"
          disabled={
            a.busy ||
            !row.shift.clocked_out_at ||
            row.flags.includes("CORRECTION_PENDING")
          }
        >
          Record attendance decision
        </button>
      </form>
      {a.feedback}
    </section>
  );
}
// Preserve all six PostgreSQL fractional digits in correction fields.
const manilaTimePattern =
  "[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]{1,6})?)?";
type ProposedBreak = {
  id?: string;
  code: string;
  startedAt: string;
  endedAt: string;
  voided: boolean;
};
export function CorrectionForm({
  row,
  csrf,
  missing = false,
  people = [],
  date,
  policy,
}: {
  row?: AttendanceRow;
  csrf: string;
  missing?: boolean;
  people?: People;
  date?: string;
  policy?: AttendancePolicy;
}) {
  const a = useAction(csrf),
    [employee, setEmployee] = useState(""),
    [day, setDay] = useState(date ?? row?.shift.duty_date ?? ""),
    [duty, setDuty] = useState(""),
    [lookupError, setLookupError] = useState("");
  const [start, setStart] = useState(
      row ? manilaInput(row.shift.clocked_in_at) : "",
    ),
    [end, setEnd] = useState(
      row ? manilaInput(row.shift.clocked_out_at ?? row.asOf) : "",
    );
  const codes = row?.shift.policy_snapshot.breakCodes ??
    policy?.breakCodes ?? [
      {
        code: "MEAL",
        paid: false,
        label: "Meal break",
        allowanceSeconds: null,
      },
      {
        code: "SHORT",
        paid: true,
        label: "Short break",
        allowanceSeconds: null,
      },
    ];
  const [breaks, setBreaks] = useState<ProposedBreak[]>(
    row?.breaks.map((b) => ({
      id: b.id,
      code: b.code,
      startedAt: manilaInput(b.started_at),
      endedAt: manilaInput(b.ended_at ?? row.asOf),
      voided: b.is_voided,
    })) ?? [],
  );
  function update(i: number, patch: Partial<ProposedBreak>) {
    setBreaks((old) => old.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  }
  return (
    <details className="card work-panel">
      <summary>
        {missing
          ? "Request a missing Clock In"
          : "Request / propose an attendance correction"}
      </summary>
      <p className="small muted">
        Original punches are preserved. These are proposed Manila times and
        require administrator approval. Include every original break; explicitly
        mark an erroneous break as void. A missing shift must refer to a real
        duty authorization.
      </p>
      {missing && (
        <div className="form-stack">
          {people.length > 0 && (
            <label>
              Employee for missing shift
              <select
                value={employee}
                onChange={(e) => {
                  setEmployee(e.target.value);
                  setDuty("");
                }}
                required
              >
                <option value="">Choose an employee</option>
                {people.map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.name} · {p.number}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Authorized duty date
            <input
              type="date"
              value={day}
              onChange={(e) => {
                setDay(e.target.value);
                setDuty("");
              }}
            />
          </label>
          <button
            className="button secondary"
            type="button"
            disabled={people.length > 0 && !employee}
            onClick={async () => {
              setLookupError("");
              setDuty("");
              try {
                const r = await fetch(
                  "/api/attendance/duties?" +
                    new URLSearchParams({
                      date: day,
                      ...(employee ? { employeeId: employee } : {}),
                    }),
                );
                const data = await r.json();
                if (!r.ok) throw new Error(data.error);
                if (!data.length)
                  throw new Error(
                    "No duty authorization exists for this employee/date.",
                  );
                setDuty(data[0].id);
              } catch (e) {
                setLookupError((e as Error).message);
              }
            }}
          >
            Find duty authorization
          </button>
          {duty && (
            <p className="notice success">
              Duty record found. This request does not activate it or create
              attendance.
            </p>
          )}
          {lookupError && (
            <p className="notice error" role="alert">
              {lookupError}
            </p>
          )}
        </div>
      )}
      <p className="small muted">
        Enter Manila times as YYYY-MM-DD HH:mm:ss. Fractional seconds are
        optional.
      </p>
      <form
        className="form-stack"
        onSubmit={(e) => {
          e.preventDefault();
          const d = new FormData(e.currentTarget);
          void a.run(
            "corrections",
            {
              kind: missing ? "ADD_MISSING_SHIFT" : "AMEND_SHIFT",
              ...(missing
                ? { dutyId: duty }
                : {
                    shiftId: row!.shift.id,
                    expectedVersion: row!.shift.version,
                  }),
              reason: String(d.get("reason")),
              proposed: {
                clockedInAt: manilaInstant(start),
                clockedOutAt: manilaInstant(end),
                breaks: breaks.map((b) => ({
                  ...b,
                  startedAt: manilaInstant(b.startedAt),
                  endedAt: manilaInstant(b.endedAt),
                })),
              },
            },
            "Correction request filed. Recorded values are unchanged pending review.",
          );
        }}
      >
        <div className="form-grid">
          <label>
            Proposed Clock In · Manila
            <input
              type="text"
              pattern={manilaTimePattern}
              maxLength={26}
              placeholder="YYYY-MM-DD HH:mm:ss"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              required
            />
          </label>
          <label>
            Proposed Clock Out · Manila
            <input
              type="text"
              pattern={manilaTimePattern}
              maxLength={26}
              placeholder="YYYY-MM-DD HH:mm:ss"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              required
            />
          </label>
        </div>
        {breaks.map((b, i) => (
          <fieldset className="attendance-break-edit" key={b.id ?? "new" + i}>
            <legend>
              {b.id ? "Existing" : "New"} break {i + 1}
            </legend>
            <div className="form-grid">
              <label>
                Break code
                <select
                  value={b.code}
                  onChange={(e) => update(i, { code: e.target.value })}
                >
                  {codes.map((c) => (
                    <option value={c.code} key={c.code}>
                      {c.code} · {c.paid ? "paid" : "unpaid"}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Break start · Manila
                <input
                  type="text"
                  pattern={manilaTimePattern}
                  maxLength={26}
                  placeholder="YYYY-MM-DD HH:mm:ss"
                  required
                  value={b.startedAt}
                  onChange={(e) => update(i, { startedAt: e.target.value })}
                />
              </label>
              <label>
                Break end · Manila
                <input
                  type="text"
                  pattern={manilaTimePattern}
                  maxLength={26}
                  placeholder="YYYY-MM-DD HH:mm:ss"
                  required
                  value={b.endedAt}
                  onChange={(e) => update(i, { endedAt: e.target.value })}
                />
              </label>
            </div>
            {b.id ? (
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={b.voided}
                  onChange={(e) => update(i, { voided: e.target.checked })}
                />
                Void this erroneous break, preserving its history
              </label>
            ) : (
              <button
                type="button"
                className="button secondary"
                onClick={() => setBreaks((x) => x.filter((_, j) => i !== j))}
              >
                Remove proposed new break
              </button>
            )}
          </fieldset>
        ))}
        <button
          type="button"
          className="button secondary"
          disabled={breaks.length >= 100}
          onClick={() =>
            setBreaks((x) => [
              ...x,
              {
                code: codes[0].code,
                startedAt: start,
                endedAt: end,
                voided: false,
              },
            ])
          }
        >
          Add proposed break
        </button>
        <label>
          Correction reason · 10–2,000 characters
          <textarea
            name="reason"
            required
            minLength={10}
            maxLength={2000}
            rows={3}
          />
        </label>
        <button
          className="button primary"
          disabled={a.busy || (missing && !duty)}
        >
          File correction request
        </button>
      </form>
      {a.feedback}
    </details>
  );
}
export function CorrectionCards({
  items,
  csrf,
  admin,
  segments = [],
}: {
  items: Correction[];
  csrf: string;
  admin: boolean;
  segments?: Segment[];
}) {
  return (
    <section className="work-panel">
      <h2>Attendance corrections</h2>
      {!items.length && (
        <p className="muted">No correction requests for these filters.</p>
      )}
      {items.map((c) => (
        <CorrectionCard
          key={c.id}
          correction={c}
          csrf={csrf}
          admin={admin}
          segments={segments}
        />
      ))}
    </section>
  );
}
function CorrectionCard({
  correction: c,
  csrf,
  admin,
  segments,
}: {
  correction: Correction;
  csrf: string;
  admin: boolean;
  segments: Segment[];
}) {
  const a = useAction(csrf),
    [decision, setDecision] = useState("APPROVED"),
    p = c.proposed_values as {
      clockedInAt: string;
      clockedOutAt: string;
      breaks: {
        code: string;
        paid: boolean;
        startedAt: string;
        endedAt: string;
        voided: boolean;
      }[];
    };
  const editKeys = useRef(new Map<string, string>());
  const editable = segments.filter(
    (s) =>
      s.shift_id === c.target_shift_id &&
      s.shift_closed_at &&
      s.root_state === "STOPPED",
  );
  return (
    <article className="card work-panel">
      <h3>
        {c.employee_name} · {c.duty_date} · {attendanceLabel(c.kind)}
      </h3>
      <p>
        {attendanceLabel(c.status)} · Requested {stamp(c.created_at)}
      </p>
      <p className="work-text">{c.reason}</p>
      <div className="form-grid">
        <div>
          <strong>Original effective punches</strong>
          <p>
            {c.original_values.shift
              ? `${stamp(c.original_values.shift.clocked_in_at)} → ${stamp(c.original_values.shift.clocked_out_at)}`
              : "No shift existed; actual punches remain absent."}
          </p>
        </div>
        <div>
          <strong>Proposed punches</strong>
          <p>
            {stamp(p.clockedInAt)} → {stamp(p.clockedOutAt)}
          </p>
        </div>
      </div>
      <ul>
        {p.breaks.map((b, i) => (
          <li key={i}>
            {b.code} ({b.paid ? "paid" : "unpaid"}
            {b.voided ? ", voided" : ""}): {stamp(b.startedAt)} →{" "}
            {stamp(b.endedAt)}
          </li>
        ))}
      </ul>
      {c.review_reason && (
        <p className="notice">
          Administrator decision: {c.review_reason} · {stamp(c.reviewed_at)}
        </p>
      )}
      {admin && c.status === "PENDING" && (
        <form
          className="form-stack"
          onSubmit={(e) => {
            e.preventDefault();
            const d = new FormData(e.currentTarget);
            const changes =
              decision === "APPROVED"
                ? editable
                    .filter((s) => d.has(s.id + "include"))
                    .map((s) => {
                      const fields = segmentFields(d, s, s.id);
                      const fingerprint = JSON.stringify(fields);
                      const operationKey =
                        editKeys.current.get(fingerprint) ??
                        crypto.randomUUID();
                      editKeys.current.set(fingerprint, operationKey);
                      return { ...fields, operationKey };
                    })
                : [];
            void a.run(
              `corrections/${c.id}/review`,
              {
                expectedVersion: c.version,
                decision,
                reason: String(d.get("reason")),
                ...(changes.length ? { segments: changes } : {}),
              },
              "Correction decision recorded; applied time needs attendance approval.",
            );
          }}
        >
          <label>
            Correction decision
            <select
              value={decision}
              onChange={(e) => setDecision(e.target.value)}
            >
              <option value="APPROVED">Approve filed proposal</option>
              <option value="REJECTED">Reject proposal</option>
            </select>
          </label>
          <label>
            Correction review reason
            <textarea
              name="reason"
              required
              minLength={10}
              maxLength={2000}
              rows={3}
            />
          </label>
          {decision === "APPROVED" && editable.length > 0 && (
            <details>
              <summary>Include related segment corrections</summary>
              <p>
                Only change the segments you have reviewed. The shift and
                segment corrections save together.
              </p>
              {editable.map((s) => (
                <SegmentFields
                  key={s.id + "-" + s.version}
                  segment={s}
                  prefix={s.id}
                  optional
                />
              ))}
            </details>
          )}
          {c.target_shift_id && !segments.length && (
            <Link href={"/admin/attendance/" + c.target_shift_id}>
              Open the shift and related segments
            </Link>
          )}
          <p className="small muted">
            Recent MFA required. If punches changed since filing, reject this
            request and file a replacement. Existing evidence and decisions
            cannot be rewritten.
          </p>
          <button className="button primary" disabled={a.busy}>
            Record correction decision
          </button>
        </form>
      )}
      {a.feedback}
    </article>
  );
}
export function AttendanceBulk({
  filters,
  csrf,
}: {
  filters: Record<string, string>;
  csrf: string;
}) {
  const a = useAction(csrf),
    [preview, setPreview] = useState<BulkPreview | null>(null);
  const total = preview?.eligible
    .reduce((n, s) => n.plus(s.suggestedSeconds), new Decimal(0))
    .toFixed(6);
  return (
    <details className="card work-panel">
      <summary>Approve clean shifts in these filters</summary>
      <p>
        Preview this duty-date range and employee selection. Only closed Pending
        shifts with no flags or pending corrections qualify. Flagged shifts
        require individual review.
      </p>
      <button
        className="button secondary"
        disabled={a.busy}
        onClick={async () => {
          const p = await a.run(
            "bulk-preview",
            { filters },
            "Clean-shift preview loaded.",
          );
          setPreview(p);
        }}
      >
        Preview clean shifts
      </button>
      {preview && (
        <>
          <p>
            <strong>{preview.eligible.length} clean shifts</strong> ·{" "}
            {preview.excluded} excluded · Suggested total {duration(total)}
          </p>
          <p className="small muted">
            Each suggestion is elapsed minus recorded unpaid breaks. Nothing is
            approved by previewing.
          </p>
          <ul className="attendance-preview">
            {preview.eligible.map((s) => (
              <li key={s.id}>
                {s.employeeName} · {s.employeeNumber} · {s.dutyDate} ·{" "}
                {stamp(s.clockedInAt)} → {stamp(s.clockedOutAt)} · Suggested{" "}
                {duration(s.suggestedSeconds)}
              </li>
            ))}
          </ul>
          <button
            className="button primary"
            disabled={a.busy || !preview.eligible.length}
            onClick={async () => {
              const result = await a.run(
                "bulk-approve",
                {
                  filters,
                  expected: preview.eligible.map(({ id, version }) => ({
                    id,
                    version,
                  })),
                },
                "Selected clean shifts approved using their suggestions.",
              );
              if (result) setPreview(null);
            }}
          >
            Approve these clean suggestions
          </button>
        </>
      )}
      {a.feedback}
    </details>
  );
}
export function AttendanceSettings({
  policy,
  csrf,
}: {
  policy: AttendancePolicy & { policyId: string };
  csrf: string;
}) {
  const a = useAction(csrf),
    [codes, setCodes] = useState(policy.breakCodes),
    [limit, setLimit] = useState(policy.maxShiftsPerDutyDate?.toString() ?? "");
  return (
    <details className="card work-panel">
      <summary>Attendance policy & break codes</summary>
      <p className="small muted">
        Changes apply to new shifts; recorded classification stays snapshotted.
        Confirm paid/unpaid treatment with the owner/accountant before payroll
        is implemented.
      </p>
      <form
        className="form-stack"
        onSubmit={(e) => {
          e.preventDefault();
          const d = new FormData(e.currentTarget);
          const { policyId, ...configuration } = policy;
          void a.run(
            "policy",
            {
              expectedPolicyId: policyId,
              configuration: {
                ...configuration,
                longShiftReviewSeconds: Number(d.get("long")),
                latenessGraceSeconds: Number(d.get("grace")),
                maxShiftsPerDutyDate: limit ? Number(limit) : null,
                breakCodes: codes,
              },
              reason: String(d.get("reason")),
            },
            "New attendance policy version saved.",
          );
        }}
      >
        <div className="form-grid">
          <label>
            Long-shift review threshold · seconds
            <input
              type="number"
              name="long"
              defaultValue={policy.longShiftReviewSeconds}
              min={3600}
              max={86400}
              required
            />
          </label>
          <label>
            Lateness grace · seconds
            <input
              type="number"
              name="grace"
              defaultValue={policy.latenessGraceSeconds}
              min={0}
              max={3600}
              required
            />
          </label>
          <label>
            Shifts per duty date · blank for no cap
            <input
              type="number"
              min={1}
              max={20}
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
            />
          </label>
        </div>
        {codes.map((c, i) => (
          <fieldset className="attendance-break-edit" key={i}>
            <legend>Break code {i + 1}</legend>
            <div className="form-grid">
              <label>
                Code
                <input
                  value={c.code}
                  maxLength={16}
                  pattern="[A-Z][A-Z0-9_]*"
                  required
                  onChange={(e) =>
                    setCodes((x) =>
                      x.map((v, j) =>
                        i === j ? { ...v, code: e.target.value } : v,
                      ),
                    )
                  }
                />
              </label>
              <label>
                Label
                <input
                  value={c.label}
                  maxLength={80}
                  required
                  onChange={(e) =>
                    setCodes((x) =>
                      x.map((v, j) =>
                        i === j ? { ...v, label: e.target.value } : v,
                      ),
                    )
                  }
                />
              </label>
              <label>
                Allowance seconds · blank uses schedule
                <input
                  type="number"
                  min={0}
                  max={86400}
                  value={c.allowanceSeconds ?? ""}
                  onChange={(e) =>
                    setCodes((x) =>
                      x.map((v, j) =>
                        i === j
                          ? {
                              ...v,
                              allowanceSeconds: e.target.value
                                ? Number(e.target.value)
                                : null,
                            }
                          : v,
                      ),
                    )
                  }
                />
              </label>
            </div>
            <label className="check-row">
              <input
                type="checkbox"
                checked={c.paid}
                onChange={(e) =>
                  setCodes((x) =>
                    x.map((v, j) =>
                      i === j ? { ...v, paid: e.target.checked } : v,
                    ),
                  )
                }
              />
              Paid break
            </label>
            <button
              type="button"
              className="button secondary"
              disabled={codes.length === 1}
              onClick={() => setCodes((x) => x.filter((_, j) => i !== j))}
            >
              Remove code for new shifts
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          className="button secondary"
          disabled={codes.length >= 20}
          onClick={() =>
            setCodes((x) => [
              ...x,
              {
                code: "NEW_" + x.length,
                label: "New break",
                paid: false,
                allowanceSeconds: null,
              },
            ])
          }
        >
          Add break code
        </button>
        <label>
          Policy change reason
          <textarea name="reason" required minLength={10} maxLength={2000} />
        </label>
        <button className="button primary" disabled={a.busy}>
          Save policy version · recent MFA required
        </button>
      </form>
      {a.feedback}
    </details>
  );
}
