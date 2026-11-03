import "server-only";
import { z } from "zod";
import { taskFields } from "../../lib/work";
import { uploadPolicySchema } from "../../lib/uploads";
import { workScoped, type WorkSession } from "../dal/work";
import { HttpError } from "../auth/security";
const payload = z.strictObject({
  notes: z.string().max(10000).default(""),
  urls: taskFields.shape.references.default([]),
});
export const draftSchema = payload.extend({ creationKey: z.uuid() });
export const editDraftSchema = payload.extend({
  expectedVersion: z.number().int().positive(),
  abandon: z.boolean().default(false),
});
export const submitSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  content: payload.optional(),
});
export const reviewSchema = z
  .strictObject({
    expectedVersion: z.number().int().positive(),
    decision: z.enum(["APPROVED", "REVISION_REQUIRED"]),
    reason: z.string().trim().max(2000).default(""),
  })
  .refine(
    (b) => b.decision !== "REVISION_REQUIRED" || b.reason.length >= 10,
    "Revision reason requires 10–2000 characters",
  );
function employee(w: WorkSession) {
  if (w.admin) throw new HttpError(403, "Employees submit their own work");
}
export async function createDraft(w: WorkSession, id: string, input: unknown) {
  employee(w);
  z.uuid().parse(id);
  const b = draftSchema.parse(input);
  return workScoped(
    w,
    async (tx) =>
      (
        await tx.$queryRaw<
          { id: string }[]
        >`SELECT private.create_submission(${id}::uuid,${JSON.stringify(b)}::jsonb) AS id`
      )[0],
  );
}
export async function editDraft(w: WorkSession, id: string, input: unknown) {
  employee(w);
  z.uuid().parse(id);
  const { expectedVersion, abandon, ...data } = editDraftSchema.parse(input);
  return workScoped(w, async (tx) => {
    await tx.$queryRaw`SELECT private.edit_submission(${id}::uuid,${expectedVersion},${JSON.stringify(data)}::jsonb,${abandon})::text`;
    return { ok: true };
  });
}
export async function submitDraft(w: WorkSession, id: string, input: unknown) {
  employee(w);
  z.uuid().parse(id);
  const b = submitSchema.parse(input);
  return workScoped(w, async (tx) => {
    await tx.$queryRaw`SELECT private.submit_submission_content(${id}::uuid,${b.expectedVersion},${b.content ? JSON.stringify(b.content) : null}::jsonb)::text`;
    return { ok: true };
  });
}
export async function review(w: WorkSession, id: string, input: unknown) {
  if (!w.admin) throw new HttpError(403, "Administrator required");
  z.uuid().parse(id);
  const b = reviewSchema.parse(input);
  return workScoped(
    w,
    async (tx) =>
      (
        await tx.$queryRaw<
          { id: string }[]
        >`SELECT private.review_submission(${id}::uuid,${b.expectedVersion},${b.decision},${b.reason}) AS id`
      )[0],
  );
}
export type Submission = {
  id: string;
  assignment_id: string;
  revision_number: number;
  state: string;
  notes: string;
  urls: { url: string; label?: string }[];
  version: number;
  created_at: Date;
  submitted_at: Date | null;
  decision: string | null;
  reason: string | null;
  reviewed_at: Date | null;
  assignment_status: string;
  is_current: boolean;
  task_id: string;
  task_title: string;
  employee_id: string;
};
export async function submissions(w: WorkSession, taskId: string) {
  z.uuid().parse(taskId);
  return workScoped(w, async (tx) => {
    const found = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM tasks WHERE id=${taskId}::uuid`;
    if (!found[0]) throw new HttpError(404, "Not found");
    return tx.$queryRaw<
      Submission[]
    >`SELECT s.id,s.assignment_id,s.revision_number,s.state,s.notes,s.urls,s.version,s.created_at,s.submitted_at,r.decision,r.reason,r.reviewed_at,a.status AS assignment_status,coalesce(a.current_submission_id=s.id,false) AS is_current,t.id AS task_id,t.title AS task_title,a.employee_id FROM task_submissions s JOIN task_assignments a ON a.id=s.assignment_id JOIN tasks t ON t.id=a.task_id LEFT JOIN task_reviews r ON r.submission_id=s.id WHERE t.id=${taskId}::uuid ORDER BY s.revision_number DESC,s.id`;
  });
}
export async function submission(w: WorkSession, id: string) {
  z.uuid().parse(id);
  return workScoped(w, async (tx) => {
    const [s] = await tx.$queryRaw<
      Submission[]
    >`SELECT s.id,s.assignment_id,s.revision_number,s.state,s.notes,s.urls,s.version,s.created_at,s.submitted_at,r.decision,r.reason,r.reviewed_at,a.status AS assignment_status,coalesce(a.current_submission_id=s.id,false) AS is_current,t.id AS task_id,t.title AS task_title,a.employee_id FROM task_submissions s JOIN task_assignments a ON a.id=s.assignment_id JOIN tasks t ON t.id=a.task_id LEFT JOIN task_reviews r ON r.submission_id=s.id WHERE s.id=${id}::uuid`;
    if (!s) throw new HttpError(404, "Not found");
    return s;
  });
}
export async function reviewQueue(w: WorkSession, page = 1) {
  if (!w.admin) throw new HttpError(403, "Administrator required");
  z.number().int().min(1).max(2000).parse(page);
  return workScoped(
    w,
    async (tx) =>
      tx.$queryRaw<
        (Submission & { display_name: string; project_name: string })[]
      >`SELECT s.id,s.assignment_id,s.revision_number,s.state,s.notes,s.urls,s.version,s.created_at,s.submitted_at,r.decision,r.reason,r.reviewed_at,a.status AS assignment_status,coalesce(a.current_submission_id=s.id,false) AS is_current,t.id AS task_id,t.title AS task_title,a.employee_id,p.display_name,pr.name AS project_name FROM task_submissions s JOIN task_assignments a ON a.current_submission_id=s.id AND a.id=s.assignment_id JOIN tasks t ON t.id=a.task_id JOIN projects pr ON pr.id=t.project_id JOIN employee_profiles p ON p.user_id=a.employee_id LEFT JOIN task_reviews r ON r.submission_id=s.id WHERE a.status='SUBMITTED' AND a.access_revoked_at IS NULL AND s.state='SUBMITTED' AND r.id IS NULL ORDER BY s.submitted_at,s.id LIMIT 50 OFFSET ${(page - 1) * 50}`,
  );
}
export async function uploadPolicy(w: WorkSession) {
  return workScoped(w, async (tx) => {
    const [r] = await tx.$queryRaw<
      { policy: Record<string, unknown> }[]
    >`SELECT private.upload_policy() AS policy`;
    const { policyId, ...data } = r.policy;
    return {
      policyId: z.uuid().parse(policyId),
      ...uploadPolicySchema.parse(data),
    };
  });
}
export async function updateUploadPolicy(w: WorkSession, input: unknown) {
  if (!w.admin) throw new HttpError(403, "Administrator required");
  const b = z
    .strictObject({
      expectedPolicyId: z.uuid(),
      reason: z.string().trim().min(10).max(500),
      configuration: uploadPolicySchema,
    })
    .parse(input);
  return workScoped(w, async (tx) => {
    await tx.$queryRaw`SELECT private.set_upload_policy(${b.expectedPolicyId}::uuid,${JSON.stringify(b.configuration)}::jsonb,${b.reason})::text`;
    return { ok: true };
  });
}
