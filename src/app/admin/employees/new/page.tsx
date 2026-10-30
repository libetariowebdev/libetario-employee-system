import { EmployeeEditor } from "@/components/employee-editor";
import { pageSession } from "@/server/page-session";
export default async function NewEmployee() {
  const s = await pageSession(true);
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">GROW YOUR TEAM</p>
          <h1>
            Add an employee<span className="heading-dot">.</span>
          </h1>
          <p className="muted">
            Create a personal account with Employee permissions.
          </p>
        </div>
      </div>
      <EmployeeEditor csrf={s.csrf} />
    </>
  );
}
