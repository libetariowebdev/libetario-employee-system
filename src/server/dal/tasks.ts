import "server-only";
import { z } from "zod";
import { Prisma } from "../../generated/prisma/client";
import { workScoped, type WorkSession } from "./work";
import { HttpError } from "../auth/security";
const listQuery = z.strictObject({
  q: z.string().trim().max(100).default(""),
  project: z.uuid().optional(),
  status: z
    .enum([
      "PENDING",
      "IN_PROGRESS",
      "SUBMITTED",
      "REVISION_REQUIRED",
      "APPROVED",
      "CANCELLED",
    ])
    .optional(),
  employee: z.uuid().optional(),
  page: z.coerce.number().int().min(1).max(2000).default(1),
});
export type Project = {
  id: string;
  code: string;
  name: string;
  client_label: string | null;
  website_url: string | null;
  description: string;
  reference_links: { url: string; label?: string }[];
  start_date: Date | null;
  deadline_at: Date | null;
  priority: string;
  status: string;
  version: number;
  created_at: Date;
  updated_at: Date;
  task_count: number;
  approved_count: number;
  cancelled_count: number;
};
export type Task = {
  id: string;
  task_number: string;
  project_id: string;
  title: string;
  instructions: string;
  reference_links: { url: string; label?: string }[];
  due_at: Date | null;
  priority: string;
  status: string;
  assignment_mode: string;
  collaboration_mode: string;
  version: number;
  membership_version: number;
  recipient_snapshot_at: Date;
  created_at: Date;
  updated_at: Date;
  project_name: string;
  project_status: string;
  project_version: number;
  assignment_id: string | null;
  own_status: string | null;
  assignment_version: number | null;
  indicator: "NEW" | "UPDATED" | null;
};
const taskProjection = Prisma.sql`t.id,t.task_number,t.project_id,t.title,t.instructions,t.reference_links,t.due_at,t.priority,t.status,t.assignment_mode,t.collaboration_mode,t.version,t.membership_version,t.recipient_snapshot_at,t.created_at,t.updated_at,p.name AS project_name,p.status AS project_status,p.version AS project_version,a.id AS assignment_id,a.status AS own_status,a.version AS assignment_version,CASE WHEN a.id IS NULL THEN NULL WHEN a.last_list_seen_at IS NULL THEN 'NEW' WHEN a.seen_task_version<t.version OR a.seen_project_version<p.version OR a.seen_assignment_version<a.version THEN 'UPDATED' ELSE NULL END AS indicator`;
export async function listTasks(w: WorkSession, input: unknown = {}) {
  const b = listQuery.parse(input);
  if (b.employee && !w.admin)
    throw new HttpError(403, "Administrator access required");
  return workScoped(w, async (tx) => {
    const filter = Prisma.sql`(${b.q}='' OR strpos(lower(t.title||' '||t.task_number),lower(${b.q}))>0) AND (${b.project ?? null}::uuid IS NULL OR t.project_id=${b.project ?? null}::uuid) AND (${b.status ?? null}::text IS NULL OR t.status=${b.status ?? null}) AND (${b.employee ?? null}::uuid IS NULL OR EXISTS(SELECT 1 FROM task_assignments x WHERE x.task_id=t.id AND x.employee_id=${b.employee ?? null}::uuid AND x.access_revoked_at IS NULL))`;
    const rows = await tx.$queryRaw<
      (Task & { total: number })[]
    >`SELECT ${taskProjection},count(*) OVER()::int AS total FROM tasks t JOIN projects p ON p.id=t.project_id LEFT JOIN task_assignments a ON a.task_id=t.id AND a.employee_id=${w.user_id}::uuid AND a.access_revoked_at IS NULL WHERE ${filter} ORDER BY t.updated_at DESC,t.id LIMIT 50 OFFSET ${(b.page - 1) * 50}`;
    const total =
      rows[0]?.total ??
      (
        await tx.$queryRaw<
          { total: number }[]
        >`SELECT count(*)::int AS total FROM tasks t JOIN projects p ON p.id=t.project_id WHERE ${filter}`
      )[0].total;
    const [clock] = await tx.$queryRaw<
      { now: Date }[]
    >`SELECT private.security_now() AS now`;
    return {
      tasks: rows.map(({ total: _total, ...row }) => row),
      total,
      filterProject: b.project ?? null,
      filters: { q: b.q, status: b.status, employee: b.employee },
      page: b.page,
      fetchedAt: clock.now,
    };
  });
}
export async function listProjects(
  w: WorkSession,
  input: { q?: string; page?: number } = {},
) {
  const b = z
    .strictObject({
      q: z.string().trim().max(100).default(""),
      page: z.coerce.number().int().min(1).max(2000).default(1),
    })
    .parse(input);
  return workScoped(w, async (tx) => {
    const rows = await tx.$queryRaw<
      (Project & { total: number })[]
    >`WITH counts AS(SELECT project_id,count(*) FILTER(WHERE status<>'CANCELLED')::int AS task_count,count(*) FILTER(WHERE status='APPROVED')::int AS approved_count,count(*) FILTER(WHERE status='CANCELLED')::int AS cancelled_count FROM tasks GROUP BY project_id) SELECT p.id,p.code,p.name,p.client_label,p.website_url,p.description,p.reference_links,p.start_date,p.deadline_at,p.priority,p.status,p.version,p.created_at,p.updated_at,coalesce(c.task_count,0) AS task_count,coalesce(c.approved_count,0) AS approved_count,coalesce(c.cancelled_count,0) AS cancelled_count,count(*) OVER()::int AS total FROM projects p LEFT JOIN counts c ON c.project_id=p.id WHERE (${b.q}='' OR strpos(lower(p.name||' '||p.code),lower(${b.q}))>0) ORDER BY p.updated_at DESC,p.id LIMIT 50 OFFSET ${(b.page - 1) * 50}`;
    return {
      projects: rows.map(({ total: _total, ...row }) => row),
      total:
        rows[0]?.total ??
        (
          await tx.$queryRaw<
            { total: number }[]
          >`SELECT count(*)::int AS total FROM projects p WHERE (${b.q}='' OR strpos(lower(p.name||' '||p.code),lower(${b.q}))>0)`
        )[0].total,
      page: b.page,
    };
  });
}
export async function projectDetail(w: WorkSession, id: string) {
  z.uuid().parse(id);
  return workScoped(w, async (tx) => {
    const p = await tx.projects.findUnique({
      where: { id },
      select: {
        id: true,
        code: true,
        name: true,
        client_label: true,
        website_url: true,
        description: true,
        reference_links: true,
        start_date: true,
        deadline_at: true,
        priority: true,
        status: true,
        version: true,
        created_at: true,
        updated_at: true,
      },
    });
    if (!p) throw new HttpError(404, "Not found");
    const [counts] = await tx.$queryRaw<
      { task_count: number; approved_count: number; cancelled_count: number }[]
    >`SELECT count(*) FILTER(WHERE status<>'CANCELLED')::int AS task_count,count(*) FILTER(WHERE status='APPROVED')::int AS approved_count,count(*) FILTER(WHERE status='CANCELLED')::int AS cancelled_count FROM tasks WHERE project_id=${id}::uuid`;
    return { ...p, ...counts };
  });
}
export type Assignment = {
  id: string;
  employee_id: string;
  display_name: string | null;
  status: string;
  version: number;
  assigned_at: Date;
  assignment_origin: string;
  access_revoked_at: Date | null;
  counts_for_completion: boolean;
  status_changed_at: Date;
};
export type Comment = {
  id: string;
  body: string;
  created_at: Date;
  author_label: string;
};
export type History = {
  action: string;
  occurred_at: Date;
  actor_label: string;
  from_status: string | null;
  to_status: string | null;
  reason: string | null;
  assignment_id: string | null;
};
export async function taskDetail(w: WorkSession, id: string, commentsPage = 1) {
  z.uuid().parse(id);
  z.number().int().min(1).max(2000).parse(commentsPage);
  return workScoped(w, async (tx) => {
    const [task] = await tx.$queryRaw<
      Task[]
    >`SELECT ${taskProjection} FROM tasks t JOIN projects p ON p.id=t.project_id LEFT JOIN task_assignments a ON a.task_id=t.id AND a.employee_id=${w.user_id}::uuid AND a.access_revoked_at IS NULL WHERE t.id=${id}::uuid`;
    if (!task) throw new HttpError(404, "Not found");
    const assignments = await tx.$queryRaw<
      Assignment[]
    >`SELECT a.id,a.employee_id,p.display_name,a.status,a.version,a.assigned_at,a.assignment_origin,a.access_revoked_at,a.counts_for_completion,a.status_changed_at FROM task_assignments a LEFT JOIN employee_profiles p ON p.user_id=a.employee_id WHERE a.task_id=${id}::uuid ORDER BY a.assigned_at,a.id`;
    const comments = await tx.$queryRaw<
      Comment[]
    >`SELECT * FROM private.work_comments(${id}::uuid,${(commentsPage - 1) * 50})`;
    const history = await tx.$queryRaw<
      History[]
    >`SELECT * FROM private.work_history(${id}::uuid)`;
    return { task, assignments, comments, history, commentsPage };
  });
}
export async function workAdminOptions(w: WorkSession) {
  if (!w.admin) throw new HttpError(403, "Administrator access required");
  return workScoped(w, async (tx) => {
    const employees = await tx.$queryRaw<
      { id: string; display_name: string; employee_number: string }[]
    >`SELECT p.user_id AS id,p.display_name,p.employee_number FROM employee_profiles p JOIN users u ON u.id=p.user_id WHERE u.role='EMPLOYEE' AND u.disabled_at IS NULL AND p.employment_status='ACTIVE' AND p.start_date<=(private.security_now() AT TIME ZONE 'Asia/Manila')::date ORDER BY p.display_name,p.user_id`;
    const [policy] = await tx.$queryRaw<
      { id: string; cap: number }[]
    >`SELECT p.id,coalesce((p.configuration->'tasks'->>'maxRecipients')::int,500) AS cap FROM company_settings s JOIN policy_versions p ON p.id=s.work_policy_id WHERE s.id=1`;
    return { employees, policy };
  });
}
