"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { mutation } from "./forms";
import {
  assignmentModes,
  priorities,
  projectStates,
  label,
  readOnlyReason,
} from "@/lib/work";
import type {
  Project,
  Task,
  Assignment,
  Comment,
  History,
} from "@/server/dal/tasks";
import type { Serialized } from "@/server/work-page";
type Staff = { id: string; display_name: string; employee_number: string };
type Options = { employees: Staff[]; policy: { id: string; cap: number } };
function time(value: string | null | undefined) {
  return value
    ? new Date(value).toLocaleString("en-PH", {
        timeZone: "Asia/Manila",
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "Not set";
}
function localDate(value: string) {
  return value ? new Date(value + "+08:00").toISOString() : null;
}
function dateInput(value: string | null) {
  if (!value) return "";
  return new Date(new Date(value).getTime() + 8 * 3600000)
    .toISOString()
    .slice(0, 16);
}
function linksInput(value: unknown) {
  const text = String(value ?? "").trim();
  return text ? text.split("\n").map((url) => ({ url: url.trim() })) : [];
}
function refs(links: { url: string; label?: string }[]) {
  return links.map((l) => (
    <li key={l.url}>
      <a
        className="text-link"
        href={l.url}
        rel="noreferrer noopener"
        target="_blank"
      >
        {l.label || l.url} ↗
      </a>
    </li>
  ));
}
function Status({ value }: { value: string }) {
  return (
    <span
      className={
        "status " +
        (value === "ACTIVE" || value === "IN_PROGRESS" ? "active" : "inactive")
      }
    >
      {label(value)}
    </span>
  );
}
function Result({ error, message }: { error: string; message?: string }) {
  return error ? (
    <p className="notice error" role="alert">
      {error}
    </p>
  ) : message ? (
    <p className="notice success" role="status">
      {message}
    </p>
  ) : null;
}
function References({ value }: { value: { url: string; label?: string }[] }) {
  return value.length ? (
    <ul className="reference-list">{refs(value)}</ul>
  ) : (
    <p className="muted small">No reference links.</p>
  );
}
export function ProjectForm({
  csrf,
  project,
}: {
  csrf: string;
  project?: Serialized<Project> | Record<string, any>;
}) {
  const router = useRouter(),
    key = useRef<string | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setBusy(true);
    const d = Object.fromEntries(new FormData(e.currentTarget));
    const input = {
      code: d.code,
      name: d.name,
      clientLabel: d.clientLabel || null,
      websiteUrl: d.websiteUrl || null,
      description: d.description,
      references: linksInput(d.references),
      startDate: d.startDate || null,
      deadlineAt: localDate(String(d.deadlineAt)),
      priority: d.priority,
      status: d.status,
    };
    try {
      const r = await mutation(
        project ? "work/projects/" + project.id : "work/projects",
        {
          ...input,
          ...(project
            ? { expectedVersion: project.version, reason: d.reason }
            : { creationKey: (key.current ??= crypto.randomUUID()) }),
        },
        csrf,
        project ? "PATCH" : "POST",
      );
      if (project) router.refresh();
      else router.push("/admin/projects/" + r.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="form-stack" onSubmit={submit}>
      <div className="form-grid">
        <label>
          Project code
          <input
            name="code"
            required
            maxLength={40}
            defaultValue={project?.code}
            placeholder="WEBSITE-01"
          />
        </label>
        <label>
          Project name
          <input
            name="name"
            required
            maxLength={200}
            defaultValue={project?.name}
          />
        </label>
        <label>
          Client label (optional)
          <input
            name="clientLabel"
            maxLength={200}
            defaultValue={project?.client_label ?? ""}
          />
        </label>
        <label>
          Website URL
          <input
            name="websiteUrl"
            type="url"
            defaultValue={project?.website_url ?? ""}
          />
        </label>
        <label>
          Start date
          <input
            type="date"
            name="startDate"
            defaultValue={project?.start_date?.slice(0, 10) ?? ""}
          />
        </label>
        <label>
          Deadline · Manila
          <input
            type="datetime-local"
            name="deadlineAt"
            defaultValue={dateInput(project?.deadline_at ?? null)}
          />
        </label>
        <label>
          Priority
          <select name="priority" defaultValue={project?.priority ?? "NORMAL"}>
            {priorities.map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <label>
          Status
          <select name="status" defaultValue={project?.status ?? "ACTIVE"}>
            {projectStates
              .filter((v) => v !== "COMPLETED")
              .map((v) => (
                <option key={v}>{v}</option>
              ))}
          </select>
        </label>
      </div>
      <label>
        Description
        <textarea
          name="description"
          maxLength={10000}
          rows={4}
          defaultValue={project?.description}
        />
      </label>
      <label>
        Reference URLs · one per line, up to ten
        <textarea
          name="references"
          rows={3}
          defaultValue={project?.reference_links
            ?.map((l: { url: string }) => l.url)
            .join("\n")}
        />
      </label>
      {project && (
        <label>
          Reason for changes
          <input name="reason" required minLength={10} maxLength={500} />
        </label>
      )}
      <Result error={error} />
      <button className="button primary" disabled={busy}>
        {busy ? "Saving…" : project ? "Save project" : "Create project"}
      </button>
    </form>
  );
}
export function Capacity({
  csrf,
  options,
}: {
  csrf: string;
  options: Options;
}) {
  const router = useRouter(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(false);
  return (
    <details className="card work-panel">
      <summary>Task recipient capacity · {options.policy.cap}</summary>
      <form
        className="form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          setDone(false);
          const d = Object.fromEntries(new FormData(e.currentTarget));
          try {
            await mutation(
              "work/task-policy",
              {
                expectedPolicyId: options.policy.id,
                maxRecipients: Number(d.cap),
                reason: d.reason,
              },
              csrf,
            );
            setDone(true);
            router.refresh();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="small muted">
          Versioned WORK setting. Recent administrator MFA is required. Existing
          assignments are retained.
        </p>
        <label>
          Maximum recipients
          <input
            name="cap"
            type="number"
            min={1}
            max={500}
            defaultValue={options.policy.cap}
            required
          />
        </label>
        <label>
          Reason
          <input name="reason" required minLength={10} maxLength={500} />
        </label>
        <Result error={error} message={done ? "Policy saved." : undefined} />
        <button className="button primary" disabled={busy}>
          Save capacity
        </button>
      </form>
    </details>
  );
}
export function CreateTask({
  csrf,
  projectId,
  options,
}: {
  csrf: string;
  projectId: string;
  options: Options;
}) {
  const router = useRouter(),
    key = useRef<string | null>(null),
    [mode, setMode] = useState("INDIVIDUAL"),
    [selected, setSelected] = useState<string[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const d = Object.fromEntries(new FormData(e.currentTarget));
    try {
      const r = await mutation(
        "work/tasks",
        {
          creationKey: (key.current ??= crypto.randomUUID()),
          projectId,
          title: d.title,
          instructions: d.instructions,
          references: linksInput(d.references),
          dueAt: localDate(String(d.dueAt)),
          priority: d.priority,
          assignmentMode: mode,
          collaborationMode: "SHARED",
          employeeIds: mode === "ALL_ACTIVE" ? [] : selected,
        },
        csrf,
      );
      router.push("/admin/tasks/" + r.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="card work-panel">
      <summary>Create a shared task</summary>
      <form className="form-stack" onSubmit={submit}>
        <label>
          Title
          <input name="title" required maxLength={200} />
        </label>
        <label>
          Instructions
          <textarea name="instructions" maxLength={10000} rows={5} />
        </label>
        <div className="form-grid">
          <label>
            Due · Manila
            <input name="dueAt" type="datetime-local" />
          </label>
          <label>
            Priority
            <select name="priority" defaultValue="NORMAL">
              {priorities.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <label>
            Assignment mode
            <select
              value={mode}
              onChange={(e) => {
                setMode(e.target.value);
                setSelected([]);
              }}
            >
              {assignmentModes.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
        </div>
        {mode === "ALL_ACTIVE" ? (
          <p className="notice">
            All eligible active employees are captured at creation. Later hires
            are added only by an administrator. Current recipient capacity:{" "}
            {options.policy.cap}.
          </p>
        ) : (
          <fieldset className="recipient-picker">
            <legend>Recipients · {selected.length} selected</legend>
            {options.employees.map((p) => (
              <label className="check-row" key={p.id}>
                <input
                  type={mode === "INDIVIDUAL" ? "radio" : "checkbox"}
                  name="recipient"
                  checked={selected.includes(p.id)}
                  onChange={(e) =>
                    setSelected(
                      mode === "INDIVIDUAL"
                        ? [p.id]
                        : e.target.checked
                          ? [...selected, p.id]
                          : selected.filter((id) => id !== p.id),
                    )
                  }
                />
                {p.display_name} <small>{p.employee_number}</small>
              </label>
            ))}
            {!options.employees.length && (
              <p>
                No eligible employees. Add an active employee before assigning
                work.
              </p>
            )}
          </fieldset>
        )}
        <label>
          Reference URLs · one per line
          <textarea name="references" rows={3} />
        </label>
        <p className="muted small">
          Shared collaboration. Each recipient has separate progress; the task
          counts once. Assigning work creates no paid time.
        </p>
        <Result error={error} />
        <button className="button primary" disabled={busy}>
          {busy ? "Assigning…" : "Create & assign"}
        </button>
      </form>
    </details>
  );
}
export function TaskList({
  data,
  admin,
  csrf,
  options,
}: {
  data: {
    tasks: Serialized<Task>[];
    total: number;
    page: number;
    fetchedAt: string;
    filterProject?: string | null;
    filters?: { q: string; status?: string; employee?: string };
  };
  admin: boolean;
  csrf: string;
  options?: Options;
}) {
  const router = useRouter(),
    [error, setError] = useState("");
  const observations = data.tasks
    .filter((t) => t.assignment_id)
    .map((t) => ({
      assignmentId: t.assignment_id,
      taskVersion: t.version,
      projectVersion: t.project_version,
      assignmentVersion: t.assignment_version,
    }));
  const observationKey = JSON.stringify(observations);
  useEffect(() => {
    if (!admin && observations.length)
      mutation(
        "work/seen",
        { observations: JSON.parse(observationKey) },
        csrf,
      ).catch((e) => setError(e.message));
  }, [admin, csrf, observationKey]); // Badges stay for this visit; acknowledgment affects the next visit.
  const base = admin ? "/admin/tasks" : "/work/tasks";
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">PROJECTS & CONTRIBUTIONS</p>
          <h1>{admin ? "Team tasks" : "My tasks"}.</h1>
          <p className="muted">
            {admin
              ? "Shared work, distinct employee contributions."
              : "Your assigned work. Progress changes do not record time."}
          </p>
        </div>
        <button className="button secondary" onClick={() => router.refresh()}>
          Refresh
        </button>
      </div>
      <form className="work-filters" action={base}>
        {data.filterProject && (
          <input type="hidden" name="project" value={data.filterProject} />
        )}
        <label>
          Search
          <input
            name="q"
            maxLength={100}
            placeholder="Title or task number"
            defaultValue={data.filters?.q ?? ""}
          />
        </label>
        <label>
          Status
          <select name="status" defaultValue={data.filters?.status ?? ""}>
            <option value="">All statuses</option>
            {["PENDING", "IN_PROGRESS", "CANCELLED"].map((v) => (
              <option key={v} value={v}>
                {label(v)}
              </option>
            ))}
          </select>
        </label>
        {admin && options && (
          <label>
            Assignee
            <select name="employee" defaultValue={data.filters?.employee ?? ""}>
              <option value="">All employees</option>
              {options.employees.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.display_name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button className="button secondary">Filter</button>
      </form>
      <Result error={error} />
      <p className="small muted">
        {data.total} matching tasks · Fetched {time(data.fetchedAt)} · Page{" "}
        {data.page}
      </p>
      <div className="card table-card">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>TASK / PROJECT</th>
                <th>OVERALL</th>
                {!admin && <th>MY PROGRESS</th>}
                <th>DUE · MANILA</th>
                <th>PRIORITY</th>
              </tr>
            </thead>
            <tbody>
              {data.tasks.map((t) => (
                <tr key={t.id}>
                  <td>
                    <Link
                      className="text-link"
                      href={base + "/" + t.id}
                      prefetch={false}
                    >
                      {t.title} ↗
                    </Link>
                    {t.indicator && (
                      <span className="work-indicator">
                        {t.indicator === "NEW" ? "New" : "Updated"}
                      </span>
                    )}
                    <small className="block muted">
                      {t.project_name} · {label(t.assignment_mode)}
                      {t.project_status !== "ACTIVE"
                        ? " · Read-only: " + label(t.project_status)
                        : ""}
                    </small>
                  </td>
                  <td>
                    <Status value={t.status} />
                  </td>
                  {!admin && <td>{label(t.own_status ?? "PENDING")}</td>}
                  <td>{time(t.due_at)}</td>
                  <td>{label(t.priority)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!data.tasks.length && (
            <p className="empty">No matching assigned tasks.</p>
          )}
        </div>
      </div>
      <Pagination page={data.page} hasNext={data.tasks.length === 50} />
      <p className="small muted">
        Submissions, reviews and attachments open in checkpoint 3b.
        Notifications and timers are deferred.
      </p>
    </>
  );
}
function Pagination({
  page,
  hasNext,
  param = "page",
}: {
  page: number;
  hasNext: boolean;
  param?: string;
}) {
  const router = useRouter();
  function go(p: number) {
    const u = new URL(window.location.href);
    u.searchParams.set(param, String(p));
    router.push(u.pathname + u.search);
  }
  return (
    <div className="work-pagination">
      <button
        className="button secondary"
        disabled={page <= 1}
        onClick={() => go(page - 1)}
      >
        Previous
      </button>
      <span>Page {page}</span>
      <button
        className="button secondary"
        disabled={!hasNext}
        onClick={() => go(page + 1)}
      >
        Next
      </button>
    </div>
  );
}
export function ProjectList({
  data,
}: {
  data: { projects: Serialized<Project>[]; total: number; page: number };
}) {
  return (
    <>
      <form action="/admin/projects" className="work-filters">
        <label>
          Search projects
          <input name="q" maxLength={100} />
        </label>
        <button className="button secondary">Search</button>
      </form>
      <p className="small muted">
        {data.total} matching projects · Counts include each shared task once.
      </p>
      <div className="card table-card">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>PROJECT</th>
                <th>STATUS</th>
                <th>APPROVED / TASKS</th>
                <th>CANCELLED</th>
                <th>DEADLINE</th>
              </tr>
            </thead>
            <tbody>
              {data.projects.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link
                      className="text-link"
                      href={"/admin/projects/" + p.id}
                    >
                      {p.name} ↗
                    </Link>
                    <small className="block muted">
                      {p.code} · {p.client_label ?? "No client label"}
                    </small>
                  </td>
                  <td>
                    <Status value={p.status} />
                  </td>
                  <td>
                    {p.task_count
                      ? `${p.approved_count} / ${p.task_count}`
                      : "No countable tasks"}
                  </td>
                  <td>{p.cancelled_count}</td>
                  <td>{time(p.deadline_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!data.projects.length && (
            <p className="empty">
              No projects yet. Create your first project below.
            </p>
          )}
        </div>
      </div>
      <Pagination page={data.page} hasNext={data.projects.length === 50} />
    </>
  );
}
export function ProjectInfo({
  project,
}: {
  project: Serialized<Project> | Record<string, any>;
}) {
  return (
    <section className="card work-panel">
      <div className="section-heading">
        <h2>{project.name}</h2>
        <Status value={project.status} />
      </div>
      <p className="small muted">
        {project.code} · {label(project.priority)} priority · Deadline{" "}
        {time(project.deadline_at)}
      </p>
      <p className="work-text">
        {project.description || "No project description."}
      </p>
      {project.website_url && (
        <a
          href={project.website_url}
          rel="noreferrer noopener"
          target="_blank"
          className="text-link"
        >
          Website ↗
        </a>
      )}
      <References value={project.reference_links} />
      <p className="small muted">
        {project.task_count
          ? `${project.approved_count} approved / ${project.task_count} countable tasks`
          : "No countable tasks"}{" "}
        · {project.cancelled_count} cancelled. Each shared task counts once.
      </p>
    </section>
  );
}
export function TaskDetail({
  data,
  admin,
  csrf,
  options,
}: {
  data: {
    task: Serialized<Task>;
    assignments: Serialized<Assignment>[];
    comments: Serialized<Comment>[];
    history: Serialized<History>[];
    commentsPage: number;
  };
  admin: boolean;
  csrf: string;
  options?: Options;
}) {
  const t = data.task,
    router = useRouter(),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    commentKey = useRef<string | null>(null),
    reason = readOnlyReason(t.project_status, t.status);
  async function run(path: string, input: unknown, method = "POST") {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await mutation("work/tasks/" + t.id + path, input, csrf, method);
      setMessage("Saved.");
      router.refresh();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">
            {t.project_name} · {label(t.assignment_mode)} · SHARED
          </p>
          <h1>{t.title}</h1>
          <p className="muted">
            Overall: {label(t.status)}
            {!admin
              ? " · My progress: " + label(t.own_status ?? "PENDING")
              : ""}
          </p>
        </div>
        <button className="button secondary" onClick={() => router.refresh()}>
          Refresh
        </button>
      </div>
      {reason && (
        <p className="notice" role="status">
          {reason}
        </p>
      )}
      <Result error={error} message={message} />
      <section className="card work-panel">
        <p className="mono small">{t.task_number}</p>
        <p className="muted small">
          Due {time(t.due_at)} · {label(t.priority)} priority · Created{" "}
          {time(t.created_at)}
        </p>
        <p className="work-text">
          {t.instructions || "No additional instructions."}
        </p>
        <References value={t.reference_links} />
        <Link
          className="text-link"
          href={(admin ? "/admin" : "/work") + "/projects/" + t.project_id}
        >
          View project ↗
        </Link>
      </section>
      {!admin && (
        <section className="card work-panel">
          <h2>My contribution</h2>
          <p>{label(t.own_status ?? "PENDING")}</p>
          <button
            className="button primary"
            disabled={busy || !!reason || t.own_status !== "PENDING"}
            onClick={() =>
              run("/progress", {
                expectedVersion: t.assignment_version,
                status: "IN_PROGRESS",
              })
            }
          >
            Mark in progress
          </button>
          <p className="small muted">
            This changes your contribution status. It does not start a timer or
            record paid time.
          </p>
        </section>
      )}
      {admin && (
        <>
          <details className="card work-panel">
            <summary>Edit task brief</summary>
            <form
              className="form-stack"
              onSubmit={(e) => {
                e.preventDefault();
                const d = Object.fromEntries(new FormData(e.currentTarget));
                void run(
                  "",
                  {
                    expectedVersion: t.version,
                    title: d.title,
                    instructions: d.instructions,
                    references: linksInput(d.references),
                    dueAt: localDate(String(d.dueAt)),
                    priority: d.priority,
                    reason: d.reason,
                  },
                  "PATCH",
                );
              }}
            >
              <label>
                Title
                <input
                  name="title"
                  required
                  maxLength={200}
                  defaultValue={t.title}
                />
              </label>
              <label>
                Instructions
                <textarea
                  name="instructions"
                  maxLength={10000}
                  defaultValue={t.instructions}
                  rows={4}
                />
              </label>
              <label>
                Reference URLs
                <textarea
                  name="references"
                  defaultValue={t.reference_links.map((l) => l.url).join("\n")}
                />
              </label>
              <div className="form-grid">
                <label>
                  Due · Manila
                  <input
                    name="dueAt"
                    type="datetime-local"
                    defaultValue={dateInput(t.due_at)}
                  />
                </label>
                <label>
                  Priority
                  <select name="priority" defaultValue={t.priority}>
                    {priorities.map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                Reason
                <input name="reason" required minLength={10} maxLength={500} />
              </label>
              <button className="button primary" disabled={busy}>
                Save brief
              </button>
            </form>
          </details>
          <section className="card work-panel">
            <h2>Contributions & membership</h2>
            <p className="small muted">
              Snapshot {time(t.recipient_snapshot_at)}. Late hires are never
              added automatically. Reassignment withdraws access and preserves
              history.
            </p>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>EMPLOYEE</th>
                    <th>PROGRESS</th>
                    <th>ACCESS</th>
                    <th>ORIGIN</th>
                  </tr>
                </thead>
                <tbody>
                  {data.assignments.map((a) => (
                    <tr key={a.id}>
                      <td>{a.display_name ?? a.employee_id}</td>
                      <td>{label(a.status)}</td>
                      <td>{a.access_revoked_at ? "Withdrawn" : "Assigned"}</td>
                      <td>{label(a.assignment_origin)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <form
              className="form-stack"
              onSubmit={(e) => {
                e.preventDefault();
                const d = new FormData(e.currentTarget);
                void run("/members", {
                  expectedVersion: t.version,
                  add: d.getAll("add"),
                  remove: d.getAll("remove"),
                  reason: d.get("reason"),
                });
              }}
            >
              <div className="form-grid">
                <fieldset className="recipient-picker">
                  <legend>Add / explicitly restore</legend>
                  {options?.employees
                    .filter(
                      (p) =>
                        !data.assignments.some(
                          (a) => a.employee_id === p.id && !a.access_revoked_at,
                        ),
                    )
                    .map((p) => (
                      <label className="check-row" key={p.id}>
                        <input type="checkbox" name="add" value={p.id} />
                        {p.display_name}
                      </label>
                    ))}
                </fieldset>
                <fieldset className="recipient-picker">
                  <legend>Withdraw</legend>
                  {data.assignments
                    .filter((a) => !a.access_revoked_at)
                    .map((a) => (
                      <label className="check-row" key={a.id}>
                        <input
                          type="checkbox"
                          name="remove"
                          value={a.employee_id}
                        />
                        {a.display_name ?? a.employee_id}
                      </label>
                    ))}
                </fieldset>
              </div>
              <label>
                Membership reason
                <input name="reason" required minLength={10} maxLength={500} />
              </label>
              <button
                className="button secondary"
                disabled={
                  busy ||
                  (t.status === "CANCELLED" &&
                    (t.project_status !== "ACTIVE" ||
                      data.assignments.some((a) => !a.access_revoked_at)))
                }
              >
                {t.status === "CANCELLED"
                  ? "Restore access & reopen task"
                  : "Apply membership changes"}
              </button>
            </form>
          </section>
          <section className="card work-panel">
            <h2>{t.status === "CANCELLED" ? "Restore task" : "Cancel task"}</h2>
            <form
              className="form-stack"
              onSubmit={(e) => {
                e.preventDefault();
                const d = new FormData(e.currentTarget);
                void run("/progress", {
                  expectedVersion: t.version,
                  status: t.status === "CANCELLED" ? "PENDING" : "CANCELLED",
                  reason: d.get("reason"),
                });
              }}
            >
              <label>
                Reason
                <input name="reason" required minLength={10} maxLength={500} />
              </label>
              <p className="small muted">
                History is retained. Restoration returns current contributions
                to Pending. Reviews and approvals are unavailable until 3b.
                {t.status === "CANCELLED" &&
                  data.assignments.every((a) => a.access_revoked_at) &&
                  " All access was withdrawn: select recipients in membership above to restore this task explicitly."}
              </p>
              <button
                className="button secondary"
                disabled={
                  busy ||
                  (t.status === "CANCELLED" &&
                    data.assignments.every((a) => a.access_revoked_at))
                }
              >
                {t.status === "CANCELLED"
                  ? "Restore to pending"
                  : "Cancel unfinished task"}
              </button>
            </form>
          </section>
        </>
      )}
      <section className="card work-panel">
        <h2>Shared comments</h2>
        <p className="small muted">
          Visible to current task participants. Plain text, append-only.
        </p>
        <form
          className="form-stack"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget,
              d = new FormData(form);
            if (
              await run("/comments", {
                body: d.get("body"),
                creationKey: (commentKey.current ??= crypto.randomUUID()),
              })
            ) {
              commentKey.current = null;
              form.reset();
            }
          }}
        >
          <label>
            Comment
            <textarea
              name="body"
              required
              maxLength={5000}
              rows={3}
              disabled={!!reason}
            />
          </label>
          <button className="button primary" disabled={busy || !!reason}>
            Add comment
          </button>
        </form>
        <div className="comments">
          {data.comments.map((c) => (
            <article key={c.id}>
              <strong>{c.author_label}</strong>
              <time className="muted small"> · {time(c.created_at)}</time>
              <p className="work-text">{c.body}</p>
            </article>
          ))}
          {!data.comments.length && <p className="muted">No comments yet.</p>}
        </div>
        <Pagination
          page={data.commentsPage}
          hasNext={data.comments.length === 50}
          param="commentsPage"
        />
      </section>
      <section className="card work-panel">
        <h2>Status history</h2>
        <p className="small muted">
          {admin
            ? "Task and contribution transitions."
            : "Shared task transitions and your own contribution history."}
        </p>
        {data.history.map((h, i) => (
          <p key={i} className="small">
            {time(h.occurred_at)} · {h.actor_label} ·{" "}
            {h.assignment_id ? "Contribution" : "Task"}:{" "}
            {h.from_status ? label(h.from_status) + " → " : ""}
            {h.to_status ? label(h.to_status) : h.action}
            {h.reason ? " · " + h.reason : ""}
          </p>
        ))}
      </section>
      <p className="notice">
        Submissions, revisions, reviews and private attachments arrive in
        checkpoint 3b. No timer, attendance or payable time is recorded here.
      </p>
    </>
  );
}
