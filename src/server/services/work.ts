import "server-only";
import { z } from "zod";
import {
  createProjectSchema,
  editProjectSchema,
  createTaskSchema,
  editTaskSchema,
  progressSchema,
  membershipSchema,
  commentSchema,
  seenSchema,
  reasonSchema,
} from "../../lib/work";
import { workScoped, type WorkSession } from "../dal/work";
import { HttpError } from "../auth/security";
function admin(w: WorkSession) {
  if (!w.admin) throw new HttpError(403, "Administrator access required");
}
function explicitFields(parsed: Record<string, unknown>, input: unknown) {
  // Partial schemas can contain nested defaults; absent PATCH fields must remain unchanged.
  return Object.fromEntries(
    Object.entries(parsed).filter(([key]) =>
      Object.hasOwn(input as object, key),
    ),
  );
}
export async function createProject(w: WorkSession, input: unknown) {
  admin(w);
  const b = createProjectSchema.parse(input);
  if (b.status === "COMPLETED")
    throw new HttpError(
      400,
      "Reviews are required before completing a project",
    );
  return workScoped(
    w,
    async (tx) =>
      (
        await tx.$queryRaw<
          { id: string }[]
        >`SELECT private.create_project(${JSON.stringify(b)}::jsonb) AS id`
      )[0],
  );
}
export async function editProject(w: WorkSession, id: string, input: unknown) {
  admin(w);
  z.uuid().parse(id);
  const b = editProjectSchema.parse(input);
  const { expectedVersion, reason, ...fields } = b;
  const data = explicitFields(fields, input);
  return workScoped(w, async (tx) => {
    await tx.$queryRaw`SELECT private.edit_project(${id}::uuid,${expectedVersion},${JSON.stringify(data)}::jsonb,${reason})::text`;
    return { ok: true };
  });
}
export async function createTask(w: WorkSession, input: unknown) {
  admin(w);
  const b = createTaskSchema.parse(input);
  b.employeeIds.sort();
  return workScoped(
    w,
    async (tx) =>
      (
        await tx.$queryRaw<
          { id: string }[]
        >`SELECT private.create_task(${JSON.stringify(b)}::jsonb) AS id`
      )[0],
  );
}
export async function editTask(w: WorkSession, id: string, input: unknown) {
  admin(w);
  z.uuid().parse(id);
  const { expectedVersion, reason, ...fields } = editTaskSchema.parse(input);
  return workScoped(w, async (tx) => {
    await tx.$queryRaw`SELECT private.edit_task(${id}::uuid,${expectedVersion},${JSON.stringify(explicitFields(fields, input))}::jsonb,${reason})::text`;
    return { ok: true };
  });
}
export async function progress(w: WorkSession, id: string, input: unknown) {
  z.uuid().parse(id);
  const b = progressSchema.parse(input);
  if (w.admin) reasonSchema.parse(b.reason);
  if (
    w.admin
      ? !["PENDING", "CANCELLED"].includes(b.status)
      : b.status !== "IN_PROGRESS"
  )
    throw new HttpError(
      400,
      "Use the submission and review workflow for this transition",
    );
  return workScoped(w, async (tx) => {
    await tx.$queryRaw`SELECT private.task_progress(${id}::uuid,${b.expectedVersion},${b.status},${b.reason ?? null})::text`;
    return { ok: true };
  });
}
export async function membership(w: WorkSession, id: string, input: unknown) {
  admin(w);
  z.uuid().parse(id);
  const b = membershipSchema.parse(input);
  return workScoped(w, async (tx) => {
    await tx.$queryRaw`SELECT private.task_membership(${id}::uuid,${b.expectedVersion},${b.add}::uuid[],${b.remove}::uuid[],${b.reason})::text`;
    return { ok: true };
  });
}
export async function comment(w: WorkSession, id: string, input: unknown) {
  z.uuid().parse(id);
  const b = commentSchema.parse(input);
  return workScoped(
    w,
    async (tx) =>
      (
        await tx.$queryRaw<
          { id: string }[]
        >`SELECT private.add_task_comment(${id}::uuid,${JSON.stringify(b)}::jsonb) AS id`
      )[0],
  );
}
export async function seen(w: WorkSession, input: unknown) {
  const b = seenSchema.parse(input);
  if (w.admin) throw new HttpError(403, "Employee duty access required");
  return workScoped(w, async (tx) => {
    await tx.$queryRaw`SELECT private.task_list_seen(${JSON.stringify(b.observations)}::jsonb)::text`;
    return { ok: true };
  });
}
export async function updateTaskPolicy(w: WorkSession, input: unknown) {
  admin(w);
  const b = z
    .strictObject({
      expectedPolicyId: z.uuid(),
      maxRecipients: z.number().int().min(1).max(500),
      reason: reasonSchema,
    })
    .parse(input);
  return workScoped(w, async (tx) => {
    await tx.$queryRaw`SELECT private.set_task_policy(${b.expectedPolicyId}::uuid,${b.maxRecipients},${b.reason})::text`;
    return { ok: true };
  });
}
