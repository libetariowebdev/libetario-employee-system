import "server-only";
import { z } from "zod";
import { type Prisma } from "../../generated/prisma/client";
import { HttpError } from "../auth/security";
import { workScoped, type WorkSession } from "../dal/work";
import {
  dailyInput,
  segmentReview,
  timeFilters,
  timerInput,
  timeSettings,
  csvCell,
  type TimeRules,
  type TimeFilters,
} from "../../lib/work-time";

export type Segment = {
  id: string;
  timer_id: string;
  employee_id: string;
  assignment_id: string;
  shift_id: string;
  task_label: string;
  project_label: string;
  timer_state: "RUNNING" | "PAUSED" | "STOPPED" | null;
  timer_version: number | null;
  timer_close_reason: string | null;
  started_at: string;
  ended_at: string | null;
  recorded_start: string;
  recorded_end: string | null;
  end_reason: string | null;
  observed_end: string | null;
  version: number;
  seconds: string;
  root_version: number;
  root_state: string;
  shift_version: number;
  shift_closed_at: string | null;
  kind: "ORIGINAL" | "REVISION";
  revision_review_id: string | null;
  duty_date: string;
};
export type Ledger = {
  asOf: string;
  active: Segment | null;
  items: Segment[];
  adjustments: {
    id: string;
    reason: string;
    before_start: string;
    before_end: string;
    after_start: string;
    after_end: string;
    created_at: string;
  }[];
  configuration: TimeRules & { policyId: string };
};
export type EntryOption = {
  assignment_id: string;
  task_label: string;
  project_label: string;
  captured_status: string;
};
export type Daily = {
  date: string;
  report: null | {
    id: string;
    state: string;
    version: number;
    work_in_progress: string;
    issues: string;
    notes: string;
    next_steps: string;
    submitted_at: string | null;
  };
  options: EntryOption[];
  entries: (EntryOption & {
    id: string;
    description: string;
    reported_complete: boolean;
    included: boolean;
  })[];
};
export type Report = {
  asOf: string;
  from: string;
  to: string;
  grain: TimeFilters["grain"];
  view: TimeFilters["view"];
  rows: Record<string, string | number | string[] | null>[];
};
export type Live = {
  asOf: string;
  date: string;
  pollSeconds: number;
  items: {
    employee: string;
    employee_id: string;
    duty_status: string;
    duty_date: string | null;
    current_task: string | null;
    current_project: string | null;
    timer_state: string | null;
    current_seconds: string | null;
    original_seconds: string;
    revision_seconds: string;
    attendance_seconds: string;
    paid_break_seconds: string;
    unpaid_break_seconds: string;
    alerts: string[];
  }[];
};

function query<T>(
  w: WorkSession,
  run: (tx: Prisma.TransactionClient) => Promise<{ data: T }[]>,
) {
  return workScoped(w, async (tx) => (await run(tx))[0].data);
}
const uuid = (value?: string) => (value == null ? null : z.uuid().parse(value));
const offset = (value: unknown) =>
  z.coerce
    .number()
    .int()
    .min(0)
    .max(50000)
    .parse(value ?? 0);

export function timer(w: WorkSession, input: unknown) {
  const b = timerInput.parse(input);
  const a = "assignmentId" in b ? b.assignmentId : null;
  const av = "assignmentVersion" in b ? b.assignmentVersion : null;
  const id = "timerId" in b ? b.timerId : null;
  const v = "timerVersion" in b ? b.timerVersion : null;
  return query<string>(
    w,
    (tx) =>
      tx.$queryRaw`SELECT private.timer_command(${b.command},${a}::uuid,${av}::integer,${id}::uuid,${v}::integer,${b.operationKey}::uuid) AS data`,
  );
}
export function ledger(
  w: WorkSession,
  employee?: string,
  skip?: unknown,
  segment?: string,
) {
  return query<Ledger>(
    w,
    (tx) =>
      tx.$queryRaw`SELECT private.time_ledger(${uuid(employee)}::uuid,${offset(skip)}::integer,${uuid(segment)}::uuid) AS data`,
  );
}
export function shiftSegments(w: WorkSession, shift: string, skip?: unknown) {
  return query<Segment[]>(
    w,
    (tx) =>
      tx.$queryRaw`SELECT private.time_shift_segments(${uuid(shift)}::uuid,${offset(skip)}::integer) AS data`,
  );
}
export function segmentDetail(w: WorkSession, id: string) {
  return workScoped(w, async (tx) => {
    const [result] = await tx.$queryRaw<{ data: Segment }[]>`
      SELECT (to_jsonb(s)-'operation_receipts')||jsonb_build_object(
        'root_version',r.timer_version,'root_state',r.timer_state,'shift_version',a.version,
        'shift_closed_at',a.clocked_out_at,'duty_date',a.duty_date,
        'seconds',greatest(0,extract(epoch FROM coalesce(s.ended_at,least(private.security_now(),a.grant_until))-s.started_at))::text
      ) AS data FROM task_time_segments s JOIN task_time_segments r ON r.id=s.timer_id
      JOIN attendance_shifts a ON a.id=s.shift_id WHERE s.id=${uuid(id)}::uuid`;
    if (!result) throw new HttpError(404, "Not found");
    return result.data;
  });
}
export function reportOptions(w: WorkSession) {
  return workScoped(w, async (tx) => ({
    employees: w.admin
      ? await tx.$queryRaw<
          { id: string; name: string }[]
        >`SELECT user_id AS id,display_name AS name FROM employee_profiles ORDER BY display_name,user_id`
      : [],
    projects: await tx.$queryRaw<{ id: string; name: string }[]>`
      SELECT DISTINCT ON (id) id,name FROM (
        SELECT id,name,0 AS rank FROM projects
        UNION ALL SELECT t.project_id,s.project_label,1 FROM task_time_segments s JOIN tasks t ON t.id=s.task_id
      ) q ORDER BY id,rank,name`,
  }));
}
export function correctSegment(w: WorkSession, id: string, input: unknown) {
  const b = segmentReview.parse(input);
  return query<string>(
    w,
    (tx) =>
      tx.$queryRaw`SELECT private.review_task_segment(${uuid(id)}::uuid,${JSON.stringify(b)}::jsonb) AS data`,
  );
}
export function changeTimeSettings(w: WorkSession, input: unknown) {
  const b = timeSettings.parse(input);
  return query<Ledger["configuration"]>(
    w,
    (tx) =>
      tx.$queryRaw`SELECT private.time_settings(${b.expectedPolicyId}::uuid,${JSON.stringify(b.rules)}::jsonb,${b.reason}) AS data`,
  );
}
export function readDaily(w: WorkSession, date: string, employee?: string) {
  return query<Daily>(
    w,
    (tx) =>
      tx.$queryRaw`SELECT private.daily_read(${z.iso.date().parse(date)}::date,${uuid(employee)}::uuid) AS data`,
  );
}
export function dailyCatalog(w: WorkSession, date: string, skip?: unknown) {
  return query<
    { id: string; employee_id: string; employee_name: string; state: string }[]
  >(
    w,
    (tx) =>
      tx.$queryRaw`SELECT private.daily_catalog(${z.iso.date().parse(date)}::date,${offset(skip)}::integer) AS data`,
  );
}
export function changeDaily(w: WorkSession, date: string, input: unknown) {
  const { action, ...b } = dailyInput.parse(input);
  return query<string>(
    w,
    (tx) =>
      tx.$queryRaw`SELECT private.daily_command(${z.iso.date().parse(date)}::date,${action},${JSON.stringify(b)}::jsonb) AS data`,
  );
}
export function live(w: WorkSession, skip?: unknown) {
  return query<Live>(
    w,
    (tx) =>
      tx.$queryRaw`SELECT private.time_live(${offset(skip)}::integer) AS data`,
  );
}
export function report(w: WorkSession, input: unknown) {
  const filters = timeFilters.parse(input);
  return query<Report>(
    w,
    (tx) =>
      tx.$queryRaw`SELECT private.time_report(${JSON.stringify(filters)}::jsonb) AS data`,
  );
}
export const reportColumns: Record<Report["view"], readonly string[]> = {
  summary: [
    "period",
    "employee",
    "attendance_seconds",
    "paid_break_seconds",
    "unpaid_break_seconds",
    "original_seconds",
    "revision_seconds",
    "task_seconds",
    "gap_seconds",
  ],
  tasks: [
    "period",
    "employee",
    "project_label",
    "task_label",
    "task_id",
    "assignment_id",
    "original_seconds",
    "revision_seconds",
    "task_seconds",
  ],
  segments: [
    "period",
    "employee",
    "project_label",
    "task_label",
    "kind",
    "review_id",
    "status",
    "duty_date",
    "source_id",
    "shift_id",
    "source_start",
    "source_end",
    "slice_start",
    "slice_end",
    "seconds",
    "version",
  ],
  attendance: [
    "period",
    "employee",
    "kind",
    "status",
    "duty_date",
    "source_id",
    "shift_id",
    "source_start",
    "source_end",
    "slice_start",
    "slice_end",
    "seconds",
    "version",
    "flags",
  ],
  approvals: [
    "duty_date",
    "employee",
    "shift_id",
    "clocked_in_at",
    "clocked_out_at",
    "approval_status",
    "approved_seconds",
    "version",
    "flags",
  ],
};

export async function reportCsv(w: WorkSession, input: unknown) {
  const snapshot = await report(w, input);
  const columns = reportColumns[snapshot.view];
  const encoder = new TextEncoder();
  let index = 0;
  let wroteHeader = false;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        // Do not keep a transaction or refresh a session across a network write.
        try {
          await workScoped(w, async () => undefined);
        } catch {
          if (!cancelled)
            controller.error(new HttpError(401, "Export access expired"));
          return;
        }
        if (cancelled) return;
        let block = "";
        if (!wroteHeader) {
          block = [...columns, "as_of"].map(csvCell).join(",") + "\r\n";
          wroteHeader = true;
        }
        const stop = Math.min(index + 32, snapshot.rows.length);
        while (index < stop) {
          const row = snapshot.rows[index++];
          block +=
            [...columns.map((column) => row[column]), snapshot.asOf]
              .map(csvCell)
              .join(",") + "\r\n";
        }
        if (block) controller.enqueue(encoder.encode(block));
        if (index === snapshot.rows.length) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="libetario-${snapshot.view}-${snapshot.from}.csv"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
