"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  attendanceLabel,
  duration,
  manilaInput,
  manilaInstant,
} from "@/lib/attendance";
import type { Daily, Ledger, Live, Segment } from "@/server/services/work-time";
import { mutation } from "./forms";

function useTimeAction(csrf: string) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const inFlight = useRef(false);
  const retry = useRef<{ fingerprint: string; key: string } | null>(null);
  async function run(
    path: string,
    data: Record<string, unknown>,
    done: string,
  ) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNotice("");
    const fingerprint = JSON.stringify([path, data]);
    if (retry.current?.fingerprint !== fingerprint)
      retry.current = { fingerprint, key: crypto.randomUUID() };
    try {
      await mutation(
        "time/" + path,
        { ...data, operationKey: retry.current.key },
        csrf,
      );
      retry.current = null;
      setNotice(done);
      router.refresh();
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "The action could not be completed.",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return { busy, notice, run };
}

export function TimerControls({
  snapshot,
  ready,
  onBreak,
  csrf,
  target,
}: {
  snapshot: Ledger;
  ready: boolean;
  onBreak: boolean;
  csrf: string;
  target?: { id: string; version: number; eligible: boolean };
}) {
  const a = useTimeAction(csrf);
  const router = useRouter();
  const active = snapshot.active;
  const same = !!active && active.assignment_id === target?.id;
  const canSwitch =
    snapshot.configuration.timers.switchMode === "ATOMIC_STOP_AND_START";
  const disabled = !ready || onBreak || a.busy;
  function command(action: string) {
    return a.run(
      "timer",
      {
        command: action,
        ...(active
          ? { timerId: active.id, timerVersion: active.timer_version }
          : {}),
        ...(target && (action === "START" || action === "SWITCH")
          ? { assignmentId: target.id, assignmentVersion: target.version }
          : {}),
      },
      "Timer updated.",
    );
  }
  return (
    <section className="card work-panel">
      <h2>Task timer</h2>
      {active ? (
        <>
          <p>
            <strong>{active.task_label}</strong> · {active.project_label}
          </p>
          <p>
            {attendanceLabel(active.timer_state!)} · {duration(active.seconds)}{" "}
            recorded ·{" "}
            {active.kind === "REVISION" ? "Revision work" : "Original work"}
          </p>
        </>
      ) : (
        <p>No active timer.</p>
      )}
      <p className="small muted">
        Server snapshot {manilaInput(snapshot.asOf).replace("T", " ")} Manila.
        Paused time does not accrue.
      </p>
      {!ready && (
        <p>
          <Link href="/work/attendance">Clock in</Link> before recording task
          time.
        </p>
      )}
      {onBreak && (
        <p>
          End your break before using the timer. Ending a break leaves the timer
          paused.
        </p>
      )}
      <div className="work-actions">
        <button
          className="button secondary"
          disabled={a.busy}
          onClick={() => router.refresh()}
        >
          Refresh timer
        </button>
        {active && (!target || same) && (
          <>
            {active.timer_state === "RUNNING" ? (
              <button
                className="button secondary"
                disabled={disabled}
                onClick={() => void command("PAUSE")}
              >
                Pause
              </button>
            ) : (
              <button
                className="button primary"
                disabled={disabled}
                onClick={() => void command("RESUME")}
              >
                Resume
              </button>
            )}
            <button
              className="button secondary"
              disabled={disabled}
              onClick={() => void command("STOP")}
            >
              Stop
            </button>
          </>
        )}
        {target?.eligible && !active && (
          <button
            className="button primary"
            disabled={disabled}
            onClick={() => void command("START")}
          >
            Start timer
          </button>
        )}
        {target?.eligible && active && !same && canSwitch && (
          <button
            className="button primary"
            disabled={disabled}
            onClick={() => void command("SWITCH")}
          >
            Stop current timer and switch to this task
          </button>
        )}
        {target && active && !same && (
          <Link className="button secondary" href="/work/time">
            Manage current timer
          </Link>
        )}
      </div>
      {a.notice && <p role="status">{a.notice}</p>}
    </section>
  );
}

export function SegmentFields({
  segment: s,
  prefix = "",
  optional = false,
}: {
  segment: Segment;
  prefix?: string;
  optional?: boolean;
}) {
  return (
    <fieldset className="form-stack">
      <legend>
        {s.task_label} · {s.kind.toLowerCase()} · {duration(s.seconds)}
      </legend>
      {optional && (
        <label className="check-row">
          <input type="checkbox" name={prefix + "include"} /> Include this
          segment correction
        </label>
      )}
      <div className="form-grid">
        <label>
          Effective start (Manila)
          <input
            name={prefix + "start"}
            defaultValue={manilaInput(s.started_at)}
            placeholder="YYYY-MM-DDTHH:mm:ss.ffffff"
          />
        </label>
        <label>
          Effective end (Manila)
          <input
            name={prefix + "end"}
            defaultValue={s.ended_at ? manilaInput(s.ended_at) : ""}
            placeholder="YYYY-MM-DDTHH:mm:ss.ffffff"
          />
        </label>
      </div>
      <label>
        Reason for changing this segment
        <textarea
          name={prefix + "reason"}
          maxLength={2000}
          minLength={10}
          required={!optional}
        />
      </label>
    </fieldset>
  );
}

export function segmentFields(data: FormData, s: Segment, prefix = "") {
  return {
    segmentId: s.id,
    expectedVersion: s.version,
    expectedTimerVersion: s.root_version,
    expectedShiftVersion: s.shift_version,
    startedAt: manilaInstant(String(data.get(prefix + "start") ?? "")),
    endedAt: manilaInstant(String(data.get(prefix + "end") ?? "")),
    reason: String(data.get(prefix + "reason") ?? ""),
  };
}

export function SegmentReview({
  segment,
  csrf,
}: {
  segment: Segment;
  csrf: string;
}) {
  const a = useTimeAction(csrf);
  return (
    <form
      className="form-stack"
      onSubmit={(e) => {
        e.preventDefault();
        void a.run(
          "segments/" + segment.id,
          segmentFields(new FormData(e.currentTarget), segment),
          "Correction saved. Original timestamps retained.",
        );
      }}
    >
      <SegmentFields segment={segment} />
      <p className="small muted">
        Recent MFA is required. An applied correction returns the shift to
        attendance review.
      </p>
      <button className="button primary" disabled={a.busy}>
        Save segment correction
      </button>
      {a.notice && <p role="status">{a.notice}</p>}
    </form>
  );
}

export function DailyEditor({ data, csrf }: { data: Daily; csrf: string }) {
  const a = useTimeAction(csrf);
  const report = data.report;
  const path = "daily/" + data.date;
  const [selected, setSelected] = useState("");
  const draft = report?.state !== "SUBMITTED";
  const narr = [
    ["workInProgress", "Work in progress", report?.work_in_progress],
    ["issues", "Issues", report?.issues],
    ["notes", "Notes", report?.notes],
    ["nextSteps", "Next steps", report?.next_steps],
  ] as const;
  return (
    <>
      <section className="card work-panel">
        <h2>
          {report ? attendanceLabel(report.state) : "Start a daily report"}
        </h2>
        {draft ? (
          <form
            key={report?.version ?? 0}
            className="form-stack"
            onSubmit={(e) => {
              e.preventDefault();
              const fields = new FormData(e.currentTarget);
              void a.run(
                path,
                {
                  action: "SAVE",
                  expectedVersion: report?.version ?? 0,
                  ...Object.fromEntries(
                    narr.map(([name]) => [
                      name,
                      String(fields.get(name) ?? ""),
                    ]),
                  ),
                },
                "Draft saved.",
              );
            }}
          >
            {narr.map(([name, label, value]) => (
              <label key={name}>
                {label}
                <textarea
                  name={name}
                  defaultValue={value}
                  maxLength={5000}
                  rows={3}
                />
              </label>
            ))}
            <button className="button primary" disabled={a.busy}>
              Save draft
            </button>
          </form>
        ) : (
          narr.map(([name, label, value]) => (
            <div key={name}>
              <h3>{label}</h3>
              <p className="work-text">{value || "—"}</p>
            </div>
          ))
        )}
      </section>
      {report && (
        <section className="card work-panel">
          <h2>Reported tasks</h2>
          <p className="small muted">
            These entries describe your work. Recorded task time and task
            approval come from their own records.
          </p>
          <ul>
            {data.entries
              .filter((e) => draft || e.included)
              .map((e) => (
                <li key={e.id}>
                  <strong>
                    {e.project_label} · {e.task_label}
                  </strong>{" "}
                  —{" "}
                  {e.included
                    ? e.reported_complete
                      ? "Reported complete"
                      : "Work reported"
                    : "Excluded"}
                  <p className="work-text">{e.description}</p>
                  {draft && (
                    <button
                      className="button secondary"
                      type="button"
                      disabled={a.busy}
                      onClick={() =>
                        void a.run(
                          path,
                          {
                            action: "ENTRY",
                            assignmentId: e.assignment_id,
                            expectedVersion: report.version,
                            description: e.description,
                            reportedComplete: e.reported_complete,
                            included: !e.included,
                          },
                          e.included ? "Entry excluded." : "Entry restored.",
                        )
                      }
                    >
                      {e.included ? "Exclude entry" : "Restore entry"}
                    </button>
                  )}
                </li>
              ))}
          </ul>
          {draft && (
            <>
              <form
                className="form-stack"
                key={report.version}
                onSubmit={(e) => {
                  e.preventDefault();
                  const fields = new FormData(e.currentTarget);
                  void a.run(
                    path,
                    {
                      action: "ENTRY",
                      expectedVersion: report.version,
                      assignmentId: selected,
                      description: String(fields.get("description") ?? ""),
                      included: true,
                      reportedComplete: fields.has("complete"),
                    },
                    "Entry saved.",
                  );
                }}
              >
                <label>
                  Assignment
                  <select
                    value={selected}
                    onChange={(e) => setSelected(e.target.value)}
                    required
                  >
                    <option value="">Choose your assignment</option>
                    {data.options.map((o) => (
                      <option key={o.assignment_id} value={o.assignment_id}>
                        {o.project_label} · {o.task_label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  What did you work on?
                  <textarea
                    name="description"
                    defaultValue={
                      data.entries.find((e) => e.assignment_id === selected)
                        ?.description
                    }
                    key={selected}
                    maxLength={2000}
                  />
                </label>
                <label className="check-row">
                  <input
                    name="complete"
                    type="checkbox"
                    key={selected}
                    defaultChecked={
                      data.entries.find((e) => e.assignment_id === selected)
                        ?.reported_complete
                    }
                  />{" "}
                  Report this work as complete
                </label>
                <button
                  className="button secondary"
                  disabled={a.busy || !selected}
                >
                  Save task entry
                </button>
              </form>
              <p>
                Submitting freezes this report. If you have no task entries,
                save an issue or note explaining the day first.
              </p>
              <button
                className="button primary"
                disabled={a.busy}
                onClick={() =>
                  void a.run(
                    path,
                    { action: "SUBMIT", expectedVersion: report.version },
                    "Report submitted.",
                  )
                }
              >
                Submit report
              </button>
            </>
          )}
        </section>
      )}
      {a.notice && (
        <p className="notice" role="status">
          {a.notice}
        </p>
      )}
    </>
  );
}

export function LiveWork({ initial, skip }: { initial: Live; skip: number }) {
  const [data, setData] = useState(initial);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let pending: ReturnType<typeof setTimeout>;
    let disposed = false;
    const abort = new AbortController();
    async function poll() {
      let interval = initial.pollSeconds;
      try {
        const response = await fetch("/api/time/live?skip=" + skip, {
          cache: "no-store",
          signal: abort.signal,
        });
        if (disposed) return;
        if (response.status === 401 || response.status === 403) {
          setError("Live access ended. Sign in again to refresh.");
          return;
        }
        if (!response.ok) throw new Error("Live update failed.");
        const next: Live = await response.json();
        if (disposed) return;
        setData(next);
        interval = next.pollSeconds;
        setError("");
      } catch {
        if (disposed) return;
        setError("Live update failed. Showing the last available snapshot.");
      }
      pending = setTimeout(poll, interval * 1000);
    }
    if (refresh > 0) void poll();
    else pending = setTimeout(poll, initial.pollSeconds * 1000);
    return () => {
      disposed = true;
      clearTimeout(pending);
      abort.abort();
    };
  }, [initial.pollSeconds, skip, refresh]);
  return (
    <>
      <div className="work-actions">
        <p>
          As of {manilaInput(data.asOf).replace("T", " ")} Manila · Refreshes
          every {data.pollSeconds}s
        </p>
        <button
          className="button secondary"
          onClick={() => setRefresh((n) => n + 1)}
        >
          Refresh now
        </button>
      </div>
      {error && (
        <p className="notice" role="status">
          {error}
        </p>
      )}
      <div className="card table-card table-scroll">
        <table>
          <thead>
            <tr>
              {[
                "Employee",
                "Duty Status",
                "Current Task",
                "Current Session",
                "Task Time Today",
                "Attendance Today",
                "Alerts",
              ].map((x) => (
                <th key={x}>{x}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.items.slice(0, 100).map((r) => (
              <tr key={r.employee_id}>
                <th scope="row">{r.employee}</th>
                <td>
                  {attendanceLabel(r.duty_status)}
                  {r.duty_date && (
                    <small className="block">{r.duty_date}</small>
                  )}
                </td>
                <td>
                  {r.current_task ?? "—"}
                  {r.current_project && (
                    <small className="block">{r.current_project}</small>
                  )}
                </td>
                <td>
                  {r.timer_state
                    ? `${attendanceLabel(r.timer_state)} · ${duration(r.current_seconds)}`
                    : "No active timer"}
                </td>
                <td>
                  {duration(r.original_seconds)} original
                  <br />
                  {duration(r.revision_seconds)} revision
                </td>
                <td>
                  {duration(r.attendance_seconds)} elapsed
                  <br />
                  {duration(r.paid_break_seconds)} paid break
                  <br />
                  {duration(r.unpaid_break_seconds)} unpaid break
                </td>
                <td>{r.alerts.map(attendanceLabel).join(", ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!data.items.length && <p>No employees on this page.</p>}
      {skip > 0 && (
        <Link href={`?skip=${Math.max(0, skip - 100)}`}>
          Previous employees
        </Link>
      )}
      {data.items.length > 100 && (
        <Link href={`?skip=${skip + 100}`}>Next employees</Link>
      )}
    </>
  );
}

export function TimeSettings({
  configuration,
  csrf,
}: {
  configuration: Ledger["configuration"];
  csrf: string;
}) {
  const a = useTimeAction(csrf);
  const fields = [
    ["weekStartsOn", "First weekday (1 = Monday)", 1, 7],
    ["pollSeconds", "Live refresh seconds", 10, 60],
    ["maxDays", "Maximum report days", 1, 31],
    ["maxRows", "Maximum report rows", 1, 50000],
    ["maxEntries", "Maximum entries per daily report", 1, 100],
  ] as const;
  return (
    <form
      key={configuration.policyId}
      className="card work-panel form-stack"
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        void a.run(
          "settings",
          {
            expectedPolicyId: configuration.policyId,
            reason: String(data.get("reason")),
            rules: {
              timers: { switchMode: String(data.get("switchMode")) },
              reports: Object.fromEntries(
                fields.map(([key]) => [key, Number(data.get(key))]),
              ),
            },
          },
          "Time policy updated.",
        );
      }}
    >
      <h2>Timer and report policy</h2>
      <label>
        Switch behavior
        <select
          name="switchMode"
          defaultValue={configuration.timers.switchMode}
        >
          <option value="ATOMIC_STOP_AND_START">Switch in one action</option>
          <option value="EXPLICIT_STOP_REQUIRED">
            Require a separate Stop
          </option>
        </select>
      </label>
      <div className="form-grid">
        {fields.map(([key, label, min, max]) => (
          <label key={key}>
            {label}
            <input
              type="number"
              name={key}
              defaultValue={configuration.reports[key]}
              min={min}
              max={max}
              required
            />
          </label>
        ))}
      </div>
      <label>
        Reason for policy change
        <textarea name="reason" required minLength={10} maxLength={2000} />
      </label>
      <p className="small muted">Recent MFA required.</p>
      <button className="button primary" disabled={a.busy}>
        Save policy
      </button>
      {a.notice && <p role="status">{a.notice}</p>}
    </form>
  );
}
