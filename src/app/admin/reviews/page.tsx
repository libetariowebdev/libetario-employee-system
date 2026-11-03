import Link from "next/link";
import { workPage } from "@/server/work-page";
import { reviewQueue } from "@/server/services/submissions";
export default async function Reviews({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const w = await workPage(true),
    page = Number((await searchParams).page ?? 1),
    items = await reviewQueue(w, page);
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">LATEST SUBMITTED REVISIONS</p>
          <h1>Review queue.</h1>
          <p className="muted">
            Review each required contribution. Shared tasks count once.
          </p>
        </div>
      </div>
      <div className="card table-card">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>TASK / PROJECT</th>
                <th>EMPLOYEE</th>
                <th>REVISION</th>
                <th>SUBMITTED · MANILA</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Link
                      className="text-link"
                      href={"/admin/tasks/" + s.task_id}
                    >
                      {s.task_title} ↗
                    </Link>
                    <small className="block muted">{s.project_name}</small>
                  </td>
                  <td>{s.display_name}</td>
                  <td>{s.revision_number}</td>
                  <td>
                    {s.submitted_at?.toLocaleString("en-PH", {
                      timeZone: "Asia/Manila",
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!items.length && (
            <p className="empty">No current submissions awaiting review.</p>
          )}
        </div>
      </div>
      <div className="work-pagination">
        {page > 1 && <Link href={"?page=" + (page - 1)}>← Previous</Link>}
        <span>Page {page}</span>
        {items.length === 50 && (
          <Link href={"?page=" + (page + 1)}>Next →</Link>
        )}
      </div>
    </>
  );
}
