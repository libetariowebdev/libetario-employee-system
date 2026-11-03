"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { mutation } from "./forms";
import { label, readOnlyReason } from "@/lib/work";
import { supportedTypes, type UploadPolicy } from "@/lib/uploads";
import type { Submission } from "@/server/services/submissions";
import type { Serialized } from "@/server/work-page";
export type FileView = {
  id: string;
  display_name: string;
  state: string;
  size_bytes: number | null;
  excluded_at?: string | null;
};
export function PrivateFiles({
  files,
  kind,
  parent,
  csrf,
  upload = false,
  draft = false,
  disabled = false,
}: {
  files: FileView[];
  kind: "projects" | "tasks" | "submissions";
  parent: string;
  csrf: string;
  upload?: boolean;
  draft?: boolean;
  disabled?: boolean;
}) {
  const router = useRouter(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const file = input.current?.files?.[0];
      if (!file || !file.size) throw new Error("Choose a non-empty file");
      const r = await fetch("/api/work/" + kind + "/" + parent + "/files", {
        method: "POST",
        headers: {
          "content-type": file.type,
          "x-file-name": encodeURIComponent(file.name),
          "x-upload-size": String(file.size),
          "x-csrf-token": csrf,
        },
        body: file,
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "Upload failed");
      if (input.current) input.current.value = "";
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="form-stack">
      <ul className="file-list">
        {files.map((f) => (
          <li key={f.id}>
            <div>
              <strong>{f.display_name}</strong>
              <small className="block muted">
                {f.excluded_at
                  ? "Excluded from this submission"
                  : label(f.state)}
                {f.size_bytes !== null
                  ? " · " + f.size_bytes.toLocaleString() + " bytes"
                  : ""}
              </small>
            </div>
            {f.state === "AVAILABLE" && !f.excluded_at && (
              <a className="button secondary" href={"/api/work/files/" + f.id}>
                Download
              </a>
            )}
            {draft && !f.excluded_at && (
              <button
                className="button secondary"
                disabled={busy || disabled}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    await mutation(
                      "work/draft-files/" + f.id + "/exclude",
                      {},
                      csrf,
                    );
                    router.refresh();
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Exclude
              </button>
            )}
          </li>
        ))}
      </ul>
      {!files.length && <p className="small muted">No attached files.</p>}
      {upload && (
        <form className="form-stack" onSubmit={send}>
          <label>
            Private file
            <input
              ref={input}
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.webp"
              required
              disabled={busy || disabled}
            />
          </label>
          <p className="small muted">
            PDF, PNG, JPEG or WebP, up to 10 MiB, subject to the company
            allow-list and quotas. Files are validated before download becomes
            available. Use one filename extension.
          </p>
          <button className="button secondary" disabled={busy || disabled}>
            {busy ? "Validating upload…" : "Validate & attach file"}
          </button>
        </form>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
export function DraftStart({
  assignmentId,
  csrf,
  disabled,
}: {
  assignmentId: string;
  csrf: string;
  disabled: boolean;
}) {
  const key = useRef<string | null>(null),
    router = useRouter(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <>
      <button
        className="button primary"
        disabled={busy || disabled}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await mutation(
              "work/assignments/" + assignmentId + "/drafts",
              { creationKey: (key.current ??= crypto.randomUUID()) },
              csrf,
            );
            router.refresh();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        Create submission draft
      </button>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <p className="small muted">
        Start your contribution or requested revision first. Each submitted
        revision keeps its own content and review.
      </p>
    </>
  );
}
export function SubmissionCard({
  s,
  files,
  csrf,
  admin,
  locked,
  employeeLabel,
}: {
  s: Serialized<Submission>;
  files: FileView[];
  csrf: string;
  admin: boolean;
  locked: boolean;
  employeeLabel?: string;
}) {
  const router = useRouter(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function run(action: string, data: unknown, method = "POST") {
    setBusy(true);
    setError("");
    try {
      await mutation("work/submissions/" + s.id + action, data, csrf, method);
      router.refresh();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  const draft = s.state === "DRAFT" && !admin;
  return (
    <article className="card work-panel">
      <h3>
        Revision {s.revision_number} · {label(s.state)}
      </h3>
      <p className="small muted">
        {s.submitted_at
          ? "Submitted " +
            new Date(s.submitted_at).toLocaleString("en-PH", {
              timeZone: "Asia/Manila",
            })
          : "Created " +
            new Date(s.created_at).toLocaleString("en-PH", {
              timeZone: "Asia/Manila",
            })}
        {admin ? " · " + (employeeLabel ?? "Employee contribution") : ""}
      </p>
      {draft ? (
        <form
          className="form-stack"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget,
              d = new FormData(form),
              content = {
                notes: String(d.get("notes")),
                urls: String(d.get("urls")).trim()
                  ? String(d.get("urls"))
                      .trim()
                      .split("\n")
                      .map((url) => ({ url: url.trim() }))
                  : [],
              };
            const submit =
              (e.nativeEvent as SubmitEvent).submitter?.getAttribute(
                "value",
              ) === "submit";
            await run(
              submit ? "/submit" : "",
              {
                expectedVersion: s.version,
                ...(submit ? { content } : content),
              },
              submit ? "POST" : "PATCH",
            );
          }}
        >
          <label>
            Submission notes
            <textarea
              name="notes"
              rows={5}
              maxLength={10000}
              defaultValue={s.notes}
              disabled={locked || busy}
            />
          </label>
          <label>
            Deliverable URLs · one per line
            <textarea
              name="urls"
              rows={3}
              defaultValue={s.urls.map((u) => u.url).join("\n")}
              disabled={locked || busy}
            />
          </label>
          <div className="work-actions">
            <button
              className="button secondary"
              name="action"
              value="save"
              disabled={locked || busy}
            >
              Save draft
            </button>
            <button
              className="button primary"
              name="action"
              value="submit"
              disabled={locked || busy}
            >
              Submit for review
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={locked || busy}
              onClick={() =>
                run("", { expectedVersion: s.version, abandon: true }, "PATCH")
              }
            >
              Abandon draft
            </button>
          </div>
          <p className="small muted">
            Submit saves and freezes these notes, URLs and included attachments
            together. Exclude rejected files before submitting. Submitted
            content cannot be edited.
          </p>
        </form>
      ) : (
        <>
          <p className="work-text">{s.notes || "No notes."}</p>
          <ul className="reference-list">
            {s.urls.map((u) => (
              <li key={u.url}>
                <a
                  className="text-link"
                  href={u.url}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {u.label || u.url} ↗
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
      <PrivateFiles
        files={files}
        parent={s.id}
        kind="submissions"
        csrf={csrf}
        draft={draft}
        upload={draft}
        disabled={locked || busy}
      />
      {s.decision && (
        <div className="notice">
          <strong>{label(s.decision)}</strong>
          {s.reason && <p className="work-text">{s.reason}</p>}
          <p className="small">
            Reviewed{" "}
            {new Date(s.reviewed_at!).toLocaleString("en-PH", {
              timeZone: "Asia/Manila",
            })}
          </p>
        </div>
      )}
      {admin &&
        s.state === "SUBMITTED" &&
        !s.decision &&
        s.assignment_status === "SUBMITTED" &&
        s.is_current && (
          <form
            className="form-stack"
            onSubmit={(e) => {
              e.preventDefault();
              const d = new FormData(e.currentTarget);
              void run("/review", {
                expectedVersion: s.version,
                decision: d.get("decision"),
                reason: d.get("reason"),
              });
            }}
          >
            <label>
              Decision
              <select
                name="decision"
                defaultValue="REVISION_REQUIRED"
                disabled={locked || busy}
              >
                <option value="REVISION_REQUIRED">Revision required</option>
                <option value="APPROVED">Approved / Completed</option>
              </select>
            </label>
            <label>
              Review note / revision reason
              <textarea
                name="reason"
                rows={3}
                maxLength={2000}
                disabled={locked || busy}
              />
            </label>
            <p className="small muted">
              A revision request needs 10–2,000 characters. Approval is terminal
              and covers this exact submitted revision.
            </p>
            <button className="button primary" disabled={locked || busy}>
              Record review
            </button>
          </form>
        )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
export function UploadSettings({
  policy,
  csrf,
}: {
  policy: UploadPolicy & { policyId: string };
  csrf: string;
}) {
  const router = useRouter(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const fields: Record<string, string> = {
    maxFileBytes: "Maximum file bytes",
    maxFilesPerDraft: "Included files per draft",
    dailyBytes: "Daily bytes per uploader",
    projectBytes: "Total project bytes",
    appBytes: "Total private storage bytes",
    maxDimension: "Maximum image dimension",
    maxPixels: "Maximum image pixels",
    maxPdfPages: "Maximum PDF pages",
    validationTimeoutMs: "Validation timeout (milliseconds)",
    uploadAttempts: "Upload attempts per 15 minutes",
    downloadAttempts: "Downloads per 15 minutes",
  };
  return (
    <details className="card work-panel">
      <summary>Upload types & limits</summary>
      <form
        className="form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          const d = new FormData(e.currentTarget),
            configuration = Object.fromEntries(
              Object.keys(fields).map((key) => [key, Number(d.get(key))]),
            );
          try {
            await mutation(
              "work/upload-policy",
              {
                expectedPolicyId: policy.policyId,
                reason: d.get("reason"),
                configuration: {
                  ...configuration,
                  allowedTypes: d.getAll("allowedTypes"),
                },
              },
              csrf,
            );
            router.refresh();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="small muted">
          Recent administrator MFA is required. Changes preserve other work
          settings and invalidate pending upload publication. The four supported
          validators can be enabled or disabled here.
        </p>
        <fieldset>
          <legend>Allowed formats</legend>
          {supportedTypes.map((type) => (
            <label className="check-row" key={type}>
              <input
                type="checkbox"
                name="allowedTypes"
                value={type}
                defaultChecked={policy.allowedTypes.includes(type)}
              />
              {type}
            </label>
          ))}
        </fieldset>
        <div className="form-grid">
          {Object.entries(fields).map(([key, title]) => (
            <label key={key}>
              {title}
              <input
                type="number"
                name={key}
                defaultValue={policy[key as keyof UploadPolicy] as number}
                required
                min={1}
              />
            </label>
          ))}
        </div>
        <label>
          Reason
          <input name="reason" required minLength={10} maxLength={500} />
        </label>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <button className="button primary" disabled={busy}>
          Save upload policy
        </button>
      </form>
    </details>
  );
}
