import { pageSession } from "@/server/page-session";
import { employeeDetails } from "@/server/services/employees";
import { ProfileHistory } from "@/components/profile-history";
import { formatDate } from "@/lib/time";
export default async function MyProfile() {
  const s = await pageSession(),
    p = await employeeDetails(s, s.user_id);
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR DETAILS, IN ONE PLACE</p>
          <h1>
            My profile<span className="heading-dot">.</span>
          </h1>
          <p className="muted">
            Only you and authorized administrators can view this information.
          </p>
        </div>
      </div>
      <section className="card">
        <div className="profile-title">
          <span className="avatar large-avatar">{p.display_name[0]}</span>
          <div>
            <h2>{p.display_name}</h2>
            <p className="muted">
              {p.designation} · {p.employee_number}
            </p>
          </div>
        </div>
        <dl className="facts">
          <div>
            <dt>Legal name</dt>
            <dd>{p.legal_name}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{p.users.email}</dd>
          </div>
          <div>
            <dt>Username</dt>
            <dd>{p.users.username}</dd>
          </div>
          <div>
            <dt>Contact</dt>
            <dd>{p.contact || "Not provided"}</dd>
          </div>
          <div>
            <dt>Start date</dt>
            <dd>{formatDate(p.start_date)}</dd>
          </div>
        </dl>
        <p className="muted small">
          Need a correction? Contact your administrator.
        </p>
        <a className="text-link" href="/change-password">
          Change my password ↗
        </a>
      </section>
      <ProfileHistory profile={p} />
    </>
  );
}
