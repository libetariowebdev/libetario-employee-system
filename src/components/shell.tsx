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
          <p className="nav-label later-label">COMING IN LATER PHASES</p>
          <span className="nav-disabled">
            <CalendarDays size={18} />
            Time & attendance <small>04</small>
          </span>
          <span className="nav-disabled">
            <FileText size={18} />
            Payroll & payslips <small>05</small>
          </span>
        </nav>
        <div className="sidebar-bottom">
          <div className="phase-label">
            <span>ACCOUNT SECURITY</span>
            <span>
              PHASE 3B <ArrowUpRight size={12} />
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
            <span className="pill">PHASE 3A</span>
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
