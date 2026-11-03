import { UploadSettings } from "@/components/submission-console";
import { uploadPolicy } from "@/server/services/submissions";
import { workPage, serialized, workSearch } from "@/server/work-page";
import { listProjects, workAdminOptions } from "@/server/dal/tasks";
import { Capacity, ProjectList, ProjectForm } from "@/components/work-console";
export default async function Projects({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const w = await workPage(true),
    data = await listProjects(w, workSearch(await searchParams)),
    options = await workAdminOptions(w);
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">SHARED WORK, CLEAR CONTRIBUTIONS</p>
          <h1>Projects.</h1>
          <p className="muted">Manage standalone projects and assign work.</p>
        </div>
      </div>
      <ProjectList data={serialized(data)} />
      <details className="card work-panel">
        <summary>New project</summary>
        <ProjectForm csrf={w.csrf} />
      </details>
      <Capacity csrf={w.csrf} options={options} />
      <UploadSettings policy={await uploadPolicy(w)} csrf={w.csrf} />
    </>
  );
}
