import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  timeFixture,
  assignment,
  clockAndStart,
  startTimer,
  timerAction,
} from "../time-helpers";
import {
  advance,
  clockIn,
  clockOut,
  freshAdmin,
  freshDuty,
  type AF,
} from "../attendance-helpers";
import { sharedTask } from "../work-helpers";
import { csrfForSession } from "../../src/server/auth/security";
import { db, authPool } from "../../src/server/db";
import * as time from "../../src/server/services/work-time";
import * as attendance from "../../src/server/services/attendance";
import { createDraft } from "../../src/server/services/submissions";
import { progress } from "../../src/server/services/work";

const origin = process.env.HTTP_TEST_ORIGIN ?? "http://127.0.0.1:3001";
if (!["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw Error("Local HTTP server required");
const key = () => randomUUID();
type Who = "a" | "b" | "admin";
function jar(f: AF, who: Who) {
  const token = who === "admin" ? f.tokens.admin : f.duty[who].token;
  return {
    token,
    cookie:
      (who === "admin" ? "libetario_session=" : "libetario_duty=") + token,
  };
}
function get(f: AF, path: string, who: Who = "a") {
  return fetch(origin + path, {
    headers: { cookie: jar(f, who).cookie },
    redirect: "manual",
  });
}
function post(f: AF, path: string, data: unknown, who: Who = "a") {
  const j = jar(f, who);
  return fetch(origin + path, {
    method: "POST",
    headers: { origin, cookie: j.cookie, "content-type": "application/json" },
    body: JSON.stringify({
      csrf: csrfForSession(j.token),
      ...(!path.startsWith("/api/work/") ? { operationKey: key() } : {}),
      ...(data as object),
    }),
  });
}
async function ok(response: Response) {
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
after(async () => {
  await db.$disconnect();
  await authPool.end();
});

test("HTTP timers require a shift, ignore client timestamps and record exact server data", async () => {
  const f = await timeFixture();
  try {
    const own = await assignment(f, f.task);
    const input = {
      command: "START",
      assignmentId: own.id,
      assignmentVersion: own.version,
      operationKey: key(),
      startedAt: "2000-01-01T00:00:00Z",
      duration: 9000,
      employeeId: f.ids.b,
    };
    assert.equal((await post(f, "/api/time/timer", input)).status, 409);
    const shift = await clockIn(f);
    const { id } = await ok(await post(f, "/api/time/timer", input));
    assert.equal(
      (await ok(await post(f, "/api/time/timer", { ...input, duration: 99 })))
        .id,
      id,
    );
    await advance(f, 23.125);
    const ledger = await ok(await get(f, "/api/time/ledger"));
    assert.equal(ledger.active.seconds, "23.125000");
    assert.equal(ledger.active.employee_id, f.ids.a);
    assert.equal(ledger.active.shift_id, shift);
    assert.equal(ledger.active.kind, "ORIGINAL");
    assert.equal(
      (await post(f, "/api/time/timer", { ...input, csrf: "invalid" })).status,
      403,
    );
    const page = await get(f, "/work/time");
    assert.equal(page.status, 200);
    assert.ok(
      (await page.text())
        .replaceAll("<!-- -->", "")
        .includes("0:00:23.125 recorded"),
    );
  } finally {
    await f.cleanup();
  }
});

test("HTTP segment, daily report and CSV ownership deny guessed peer identifiers", async () => {
  const f = await timeFixture();
  try {
    const { root } = await clockAndStart(f, f.task);
    await advance(f, 4);
    await ok(
      await post(f, "/api/time/daily/" + f.day, {
        action: "SAVE",
        expectedVersion: 0,
        notes: "Private test daily report",
      }),
    );
    for (const path of [
      "/api/time/ledger?segmentId=" + root,
      "/api/time/ledger?employeeId=" + f.ids.a,
      "/api/time/daily?date=" + f.day + "&employeeId=" + f.ids.a,
      "/api/time/report?from=" + f.day + "&employeeId=" + f.ids.a,
      "/api/time/export.csv?from=" + f.day + "&employeeId=" + f.ids.a,
      "/work/time/" + root,
    ])
      assert.equal((await get(f, path, "b")).status, 404, path);
    const response = await get(
      f,
      "/api/time/export.csv?from=" + f.day + "&view=segments",
    );
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("content-disposition") ?? "",
      /^attachment;/,
    );
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const csv = await response.text();
    assert.match(csv, new RegExp(root));
    assert.doesNotMatch(csv, /approved_payable|password|email/);
    assert.equal((await get(f, "/api/time/live", "b")).status, 403);
  } finally {
    await f.cleanup();
  }
});

test("HTTP live polling and export never slide idle expiry", async () => {
  const f = await timeFixture();
  try {
    const now = new Date(f.now.getTime() + 30_000);
    await f.owner.query(
      "UPDATE sessions SET idle_expires_at=$2 WHERE user_id=$1 AND scope='ACCOUNT'",
      [f.ids.admin, now],
    );
    const readExpiry = async () =>
      (
        await f.owner.query(
          "SELECT idle_expires_at FROM sessions WHERE user_id=$1 AND scope='ACCOUNT' AND revoked_at IS NULL",
          [f.ids.admin],
        )
      ).rows[0].idle_expires_at.toISOString();
    const original = await readExpiry();
    const live = await ok(await get(f, "/api/time/live", "admin"));
    assert.equal(live.pollSeconds, 15);
    assert.equal(Date.parse(live.asOf), f.now.getTime());
    const csv = await get(f, "/api/time/export.csv?from=" + f.day, "admin");
    assert.equal(csv.status, 200);
    await csv.text();
    assert.equal(await readExpiry(), original);
    await advance(f, 31);
    assert.equal((await get(f, "/api/time/live", "admin")).status, 401);
  } finally {
    await f.cleanup();
  }
});

test("HTTP Switch versus Clock Out never strands a running or paused root", async () => {
  const f = await timeFixture();
  try {
    const target = await sharedTask(f);
    const { root, shift } = await clockAndStart(f, f.task);
    await advance(f, 5);
    const next = await assignment(f, target);
    const punch = await attendance.attendanceDetail(f.a, shift);
    const [switched, out] = await Promise.all([
      post(f, "/api/time/timer", {
        command: "SWITCH",
        timerId: root,
        timerVersion: 1,
        assignmentId: next.id,
        assignmentVersion: next.version,
      }),
      post(f, `/api/attendance/shifts/${shift}/clock-out`, {
        expectedVersion: punch.shift.version,
      }),
    ]);
    assert.ok([200, 409].includes(switched.status), await switched.text());
    assert.equal(out.status, 200);
    assert.equal((await time.ledger(f.a)).active, null);
    const segments = await time.shiftSegments(f.a, shift);
    assert.ok(segments.every((s) => s.root_state === "STOPPED" && s.ended_at));
    assert.ok(segments.some((s) => s.timer_close_reason === "CLOCK_OUT"));
  } finally {
    await f.cleanup();
  }
});

test("HTTP Pause/Stop versus break start serializes and cannot accrue during the break", async () => {
  const f = await timeFixture();
  try {
    const { root, shift } = await clockAndStart(f, f.task);
    await advance(f, 9);
    const punch = await attendance.attendanceDetail(f.a, shift);
    const results = await Promise.all([
      post(f, "/api/time/timer", {
        command: "PAUSE",
        timerId: root,
        timerVersion: 1,
      }),
      post(f, "/api/time/timer", {
        command: "STOP",
        timerId: root,
        timerVersion: 1,
      }),
      post(f, `/api/attendance/shifts/${shift}/breaks`, {
        code: "MEAL",
        expectedVersion: punch.shift.version,
      }),
    ]);
    assert.ok(results.slice(0, 2).every((r) => [200, 409].includes(r.status)));
    assert.ok(results.slice(0, 2).filter((r) => r.status === 200).length <= 1);
    assert.equal(results[2].status, 201);
    await advance(f, 30);
    assert.equal((await time.segmentDetail(f.a, root)).seconds, "9.000000");
    assert.notEqual((await time.ledger(f.a)).active?.timer_state, "RUNNING");
  } finally {
    await f.cleanup();
  }
});

test("HTTP concurrent Start and Submit always leave the submitted contribution stopped", async () => {
  const f = await timeFixture();
  try {
    await clockIn(f);
    const own = await assignment(f, f.task);
    await progress(f.a, f.task, {
      status: "IN_PROGRESS",
      expectedVersion: own.version,
    });
    const draft = await createDraft(f.a, own.id, {
      creationKey: key(),
      notes: "Test deliverable",
    });
    const version = (await assignment(f, f.task)).version;
    const [start, submit] = await Promise.all([
      post(f, "/api/time/timer", {
        command: "START",
        assignmentId: own.id,
        assignmentVersion: version,
      }),
      post(f, `/api/work/submissions/${draft.id}/submit`, {
        expectedVersion: 1,
      }),
    ]);
    assert.ok([200, 409].includes(start.status), await start.clone().text());
    assert.equal(submit.status, 200, await submit.text());
    if (start.status === 200) {
      const id = (await start.json()).id;
      assert.equal(
        (await time.segmentDetail(f.a, id)).timer_close_reason,
        "SUBMITTED",
      );
    }
    assert.equal((await time.ledger(f.a)).active, null);
  } finally {
    await f.cleanup();
  }
});

test("15.7 HTTP report, rendered table and CSV keep 8h attendance, 6h task and 2h review gap separate", async () => {
  const f = await timeFixture();
  try {
    const shift = await clockIn(f);
    await startTimer(f, f.task);
    await advance(f, 21600);
    await freshDuty(f);
    await timerAction(f, "STOP");
    await advance(f, 7200);
    await clockOut(f, shift);
    await freshAdmin(f);
    const query = "?from=" + f.day + "&employeeId=" + f.ids.a;
    const [row] = (await ok(await get(f, "/api/time/report" + query, "admin")))
      .rows;
    assert.deepEqual(
      [row.attendance_seconds, row.task_seconds, row.gap_seconds],
      ["28800.000000", "21600.000000", "7200.000000"],
    );
    const page = await get(f, "/admin/time/reports" + query, "admin");
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Unallocated gap \(review only\)/);
    for (const label of ["8:00:00", "6:00:00", "2:00:00"])
      assert.ok(html.includes(label), label);
    const csv = await (
      await get(f, "/api/time/export.csv" + query, "admin")
    ).text();
    assert.match(csv, /"7200\.000000"/);
    assert.equal(
      (await attendance.attendanceDetail(f.admin, shift)).shift
        .approved_payable_seconds,
      null,
    );
  } finally {
    await f.cleanup();
  }
});
