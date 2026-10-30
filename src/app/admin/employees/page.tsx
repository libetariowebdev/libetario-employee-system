import Link from "next/link";
import { Plus, ArrowUpRight } from "lucide-react";
import { pageSession } from "@/server/page-session";
import { listEmployees } from "@/server/services/employees";
export default async function Employees() {
  const staff = await listEmployees(await pageSession(true));
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">PEOPLE & ACCOUNTS</p>
          <h1>
            Your employees<span className="heading-dot">.</span>
          </h1>
          <p className="muted">
            Manage profiles, account access, schedules and rates.
          </p>
        </div>
        <Link className="button primary" href="/admin/employees/new">
          <Plus size={16} />
          Add employee
        </Link>
      </div>
      <div className="card table-card">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>EMPLOYEE</th>
                <th>ID / USERNAME</th>
                <th>DESIGNATION</th>
                <th>STATUS</th>
                <th>PROFILE</th>
              </tr>
            </thead>
            <tbody>
              {staff.map((p) => (
                <tr key={p.user_id}>
                  <td>
                    <div className="person-cell">
                      <span className="avatar">{p.display_name[0]}</span>
                      <div>
                        <strong>{p.display_name}</strong>
                        <small>{p.users.email}</small>
                      </div>
                    </div>
                  </td>
                  <td>
                    {p.employee_number}
                    <small className="rate-precision">{p.users.username}</small>
                  </td>
                  <td>{p.designation}</td>
                  <td>
                    <span
                      className={
                        "status " +
                        (p.employment_status === "ACTIVE"
                          ? "active"
                          : "inactive")
                      }
                    >
                      {p.employment_status === "ACTIVE" ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td>
                    <Link
                      className="text-link"
                      href={"/admin/employees/" + p.user_id}
                    >
                      Manage <ArrowUpRight size={15} />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!staff.length && <p className="empty">No employee profiles yet.</p>}
        </div>
      </div>
    </>
  );
}
