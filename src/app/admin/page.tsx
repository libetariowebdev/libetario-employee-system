import Link from "next/link";
import {
  ArrowUpRight,
  Users,
  UserCheck,
  CalendarDays,
  ShieldCheck,
  Plus,
} from "lucide-react";
import { pageSession } from "@/server/page-session";
import { listEmployees } from "@/server/services/employees";
import { businessDate, formatDate } from "@/lib/time";
export default async function AdminHome() {
  const s = await pageSession(true),
    staff = await listEmployees(s);
  const active = staff.filter((p) => p.employment_status === "ACTIVE").length;
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR WORKSPACE, AT A GLANCE</p>
          <h1>
            Team overview<span className="heading-dot">.</span>
          </h1>
          <p className="muted">
            The people and foundations behind your next great project.
          </p>
        </div>
        <span className="date-label">
          <CalendarDays size={16} />
          {formatDate(new Date())}
        </span>
      </div>
      <section className="welcome-banner">
        <div>
          <span className="pill light-pill">PHASE 01 · FOUNDATION</span>
          <h2>Built around your people.</h2>
          <p>
            Manage employee accounts, schedules and individual rates
            <br className="desktop-only" /> from one secure workspace.
          </p>
          <Link className="button light-button" href="/admin/employees/new">
            Add an employee <Plus size={16} />
          </Link>
        </div>
        <div className="banner-art" aria-hidden>
          <span className="art-ring ring-one" />
          <span className="art-ring ring-two" />
          <span className="art-arrow">↗</span>
          <span className="art-caption">
            PEOPLE FIRST.
            <br />
            WORK FOLLOWS.
          </span>
        </div>
      </section>
      <div className="stat-grid">
        <Stat
          icon={<Users size={19} />}
          label="TOTAL EMPLOYEES"
          value={staff.length}
          note="Registered employee profiles"
        />
        <Stat
          icon={<UserCheck size={19} />}
          label="ACTIVE ACCOUNTS"
          value={active}
          note="Enabled to access their account"
        />
        <Stat
          icon={<ShieldCheck size={19} />}
          label="INACTIVE ACCOUNTS"
          value={staff.length - active}
          note="Access disabled, history retained"
        />
      </div>
      <div className="section-heading">
        <div>
          <h2>Your team</h2>
          <p className="muted small">People with a place in your workspace.</p>
        </div>
        <Link className="text-link" href="/admin/employees">
          View all employees <ArrowUpRight size={15} />
        </Link>
      </div>
      <div className="card table-card">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>EMPLOYEE</th>
                <th>EMPLOYEE ID</th>
                <th>DESIGNATION</th>
                <th>STATUS</th>
                <th>
                  <span className="sr-only">Profile</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {staff.slice(0, 5).map((p) => (
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
                  <td className="mono">{p.employee_number}</td>
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
                      className="arrow-link"
                      aria-label={"View " + p.display_name}
                      href={"/admin/employees/" + p.user_id}
                    >
                      <ArrowUpRight size={18} />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {staff.length === 0 && (
            <p className="empty">
              No employees yet. Add your first employee to get started.
            </p>
          )}
        </div>
      </div>
      <div className="foundation-note">
        <ShieldCheck size={21} />
        <div>
          <strong>A secure start.</strong>
          <p>
            Profile and secure duty access are available now. Projects,
            attendance and payroll open in later phases. Account login does not
            record paid time.
          </p>
        </div>
        <span className="mono">{businessDate(new Date())}</span>
      </div>
    </>
  );
}
function Stat({
  icon,
  label,
  value,
  note,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  note: string;
}) {
  return (
    <div className="stat-card">
      <div className="stat-top">
        <span>{label}</span>
        <span className="stat-icon">{icon}</span>
      </div>
      <strong>{String(value).padStart(2, "0")}</strong>
      <p>{note}</p>
    </div>
  );
}
