import { randomUUID } from "node:crypto";
import { attendanceFixture, clockIn, type AF } from "./attendance-helpers";
import { sharedTask } from "./work-helpers";
import { timer, ledger } from "../src/server/services/work-time";

export async function timeFixture(date?: string) {
  const f = await attendanceFixture(date);
  try {
    const task = await sharedTask(f);
    return { ...f, task };
  } catch (e) {
    await f.cleanup();
    throw e;
  }
}
export async function assignment(
  f: AF,
  task: string,
  who: "a" | "b" | "c" = "a",
) {
  return (
    await f.owner.query(
      "SELECT id,version FROM task_assignments WHERE task_id=$1 AND employee_id=$2",
      [task, f.ids[who]],
    )
  ).rows[0] as { id: string; version: number };
}
export async function startTimer(
  f: AF,
  task: string,
  who: "a" | "b" | "c" = "a",
  key = randomUUID(),
) {
  const a = await assignment(f, task, who);
  return timer(f[who], {
    command: "START",
    assignmentId: a.id,
    assignmentVersion: a.version,
    operationKey: key,
  });
}
export async function timerAction(
  f: AF,
  command: "PAUSE" | "RESUME" | "STOP",
  who: "a" | "b" | "c" = "a",
) {
  const root = (await ledger(f[who])).active!;
  return timer(f[who], {
    command,
    timerId: root.id,
    timerVersion: root.timer_version,
    operationKey: randomUUID(),
  });
}
export async function clockAndStart(
  f: AF,
  task: string,
  who: "a" | "b" | "c" = "a",
) {
  const shift = await clockIn(f, who);
  const root = await startTimer(f, task, who);
  return { shift, root };
}
