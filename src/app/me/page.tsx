import Link from "next/link";
import {
  ShieldCheck,
  ArrowUpRight,
  UserRound,
  CalendarDays,
} from "lucide-react";
import { pageSession } from "@/server/page-session";
import { employeeDetails } from "@/server/services/employees";
import { formatDate } from "@/lib/time";
export default async function MyOverview() {
  const s = await pageSession(),
    p = await employeeDetails(s, s.user_id);
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR PERSONAL WORKSPACE</p>
          <h1>
            Hello, {p.display_name}
            <span className="heading-dot">.</span>
          </h1>
          <p className="muted">Your people, your work, your next chapter.</p>
        </div>
        <span className="date-label">
          <CalendarDays size={16} />
          {formatDate(new Date())}
        </span>
      </div>
      <section className="welcome-banner">
        <div>
          <span className="pill light-pill">YOUR ACCOUNT IS READY</span>
          <h2>A good day starts here.</h2>
          <p>
            Your profile, schedule and individual rate history
            <br className="desktop-only" /> are in one private place.
          </p>
          <Link className="button light-button" href="/me/profile">
            View my profile <ArrowUpRight size={16} />
          </Link>
        </div>
        <div className="banner-art" aria-hidden>
          <span className="art-ring ring-one" />
          <span className="art-arrow">↗</span>
          <span className="art-caption">
            MAKE SPACE
            <br />
            FOR GOOD WORK.
          </span>
        </div>
      </section>
      <div className="two-col">
        <section className="card">
          <p className="eyebrow">MY PROFILE</p>
          <div className="profile-title">
            <span className="avatar large-avatar">
              <UserRound size={24} />
            </span>
            <div>
              <h2>{p.display_name}</h2>
              <p className="muted">
                {p.designation} · {p.employee_number}
              </p>
            </div>
          </div>
          <dl className="facts">
            <div>
              <dt>Email</dt>
              <dd>{p.users.email}</dd>
            </div>
            <div>
              <dt>Started</dt>
              <dd>{formatDate(p.start_date)}</dd>
            </div>
            <div>
              <dt>Account status</dt>
              <dd>
                <span className="status active">Active</span>
              </dd>
            </div>
          </dl>
          <Link className="text-link" href="/me/profile">
            Profile, rates & schedule <ArrowUpRight size={15} />
          </Link>
        </section>
        <section className="card duty-card">
          <span className="stat-icon">
            <ShieldCheck size={24} />
          </span>
          <Link className="pill" href="/duty">
            OPEN DUTY ACCESS →
          </Link>
          <h2>
            Your working day,
            <br />
            securely authorized.
          </h2>
          <p className="muted">
            View your authorization and complete secure sign-in from Duty
            access. Work tools and attendance arrive in later phases. Signing in
            does not clock you in or record paid time.
          </p>
        </section>
      </div>
    </>
  );
}
