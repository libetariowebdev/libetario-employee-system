import Link from "next/link";
import {
  LayoutDashboard,
  Users,
  Settings,
  ShieldCheck,
  CalendarDays,
  FileText,
  ArrowUpRight,
} from "lucide-react";
import { Logout } from "./forms";
import { DutyLogout } from "./duty-console";
export function Shell({
  admin,
  csrf,
  name,
  children,
  duty = false,
}: {
  admin: boolean;
  csrf: string;
  name: string;
  children: React.ReactNode;
  duty?: boolean;
}) {
  return (
    <div className="workspace">
      <aside className="sidebar">
        <Link className="wordmark" href={admin ? "/admin" : "/me"}>
          <span className="brand-mark">
            L<span>↗</span>
          </span>
          <span>
            libetario<span className="brand-sub">TEAM WORKSPACE</span>
          </span>
        </Link>
        <div className="workspace-label">
          <span className="workspace-dot" />
          {admin ? "ADMINISTRATOR" : "EMPLOYEE"} WORKSPACE
        </div>
        <nav aria-label="Main navigation">
          <p className="nav-label">WORKSPACE</p>
          <Link href={admin ? "/admin" : "/me"}>
            <LayoutDashboard size={18} />
            Overview
          </Link>
          {admin ? (
            <>
              <Link href="/admin/employees">
                <Users size={18} />
                Employees
              </Link>
              <Link href="/admin/settings">
                <Settings size={18} />
                Settings
              </Link>
              <Link href="/admin/audit">
                <ShieldCheck size={18} />
                Audit trail
              </Link>
            </>
          ) : (
            <Link href="/me/profile">
              <Users size={18} />
              My profile & rates
            </Link>
          )}
          <Link href={admin ? "/admin/security" : "/mfa/security"}>
            <ShieldCheck size={18} />
            Account security
          </Link>
          <Link href={admin ? "/admin/duty" : "/duty"}>
            <ShieldCheck size={18} />
            Duty access
          </Link>
          <Link
            href={admin ? "/admin/projects" : "/work/tasks"}
            prefetch={false}
          >
            <FileText size={18} />
            {admin ? "Projects" : "My tasks"}
          </Link>
          {admin && (
            <Link href="/admin/tasks">
              <FileText size={18} />
              Team tasks
            </Link>
          )}
          {admin && (
            <Link href="/admin/reviews">
              <FileText size={18} />
              Review submissions
            </Link>
          )}
          <Link
            href={admin ? "/admin/attendance" : "/work/attendance"}
            prefetch={false}
          >
            <CalendarDays size={18} />
            Attendance
          </Link>
          {admin ? (
            <Link href="/admin/time/live" prefetch={false}>
              <CalendarDays size={18} />
              Live work
            </Link>
          ) : (
            <Link href="/work/time" prefetch={false}>
              <CalendarDays size={18} />
              Task time
            </Link>
          )}
          <Link
            href={admin ? "/admin/time/reports" : "/work/time/reports"}
            prefetch={false}
          >
            <FileText size={18} />
            Time reports
          </Link>
          <Link href={admin ? "/admin/daily" : "/work/daily"} prefetch={false}>
            <FileText size={18} />
            {admin ? "Daily reports" : "Daily report"}
          </Link>
          <Link href={admin ? "/admin/payroll" : "/me/payroll"} prefetch={false}>
            <FileText size={18} />
            {admin ? "Payroll" : "My payroll"}
          </Link>
        </nav>
        <div className="sidebar-bottom">
          <div className="phase-label">
            <span>ACCOUNT SECURITY</span>
            <span>
              PHASE 5A <ArrowUpRight size={12} />
            </span>
          </div>
          <p>
            A clear foundation
            <br />
            for the work ahead.
          </p>
          <div className="sidebar-user">
            <span className="avatar">{name.slice(0, 1).toUpperCase()}</span>
            <div>
              <strong>{name}</strong>
              <small>{admin ? "Administrator" : "Employee"}</small>
            </div>
          </div>
          {duty ? <DutyLogout csrf={csrf} /> : <Logout csrf={csrf} />}
        </div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <span>
            Libetario <span className="slash">/</span> Team workspace
          </span>
          <div>
            <span className="timezone">Asia/Manila</span>
            <span className="pill">PHASE 5A</span>
            <span className="avatar small-avatar">
              {name.slice(0, 1).toUpperCase()}
            </span>
          </div>
        </header>
        <main className="content">{children}</main>
        <footer className="workspace-footer">
          Libetario Digital Marketing Services
          <span>Private workspace · Projects & tasks</span>
        </footer>
      </div>
    </div>
  );
}
