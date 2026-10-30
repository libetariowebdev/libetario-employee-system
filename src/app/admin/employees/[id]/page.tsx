import { notFound } from "next/navigation";
import { z } from "zod";
import { pageSession } from "@/server/page-session";
import { employeeDetails } from "@/server/services/employees";
import {
  EmployeeEditor,
  RateEditor,
  ScheduleEditor,
  ResetIssuer,
} from "@/components/employee-editor";
import { ProfileHistory } from "@/components/profile-history";
import { HttpError } from "@/server/auth/security";
export default async function Employee({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const s = await pageSession(true),
    { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  let p;
  try {
    p = await employeeDetails(s, id);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) notFound();
    throw e;
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">EMPLOYEE PROFILE · {p.employee_number}</p>
          <h1>
            {p.display_name}
            <span className="heading-dot">.</span>
          </h1>
          <p className="muted">
            Profile changes and account actions are recorded in the audit trail.
          </p>
        </div>
        <span
          className={
            "status " +
            (p.employment_status === "ACTIVE" ? "active" : "inactive")
          }
        >
          {p.employment_status}
        </span>
      </div>
      <EmployeeEditor
        csrf={s.csrf}
        initial={{
          user_id: p.user_id,
          employee_number: p.employee_number,
          legal_name: p.legal_name,
          display_name: p.display_name,
          contact: p.contact,
          designation: p.designation,
          start_date: p.start_date.toISOString().slice(0, 10),
          employment_status: p.employment_status,
          version: p.version,
          email: p.users.email,
          username: p.users.username,
        }}
      />
      <ProfileHistory profile={p} />
      <div className="section-heading">
        <h2>Manage history & access</h2>
      </div>
      <div className="form-stack">
        <RateEditor csrf={s.csrf} id={p.user_id} />
        <ScheduleEditor csrf={s.csrf} id={p.user_id} />
        <ResetIssuer csrf={s.csrf} id={p.user_id} />
      </div>
    </>
  );
}
