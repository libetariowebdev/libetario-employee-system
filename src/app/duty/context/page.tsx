import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireDuty } from "@/server/dal/duty";
import { HttpError, csrfForSession } from "@/server/auth/security";
import { DutyLogout } from "@/components/duty-console";
export const dynamic = "force-dynamic";
export default async function ContextPage() {
  const token = (await cookies()).get("libetario_duty")?.value;
  const d = await requireDuty(token).catch((e) => {
    if (e instanceof HttpError) redirect("/duty/reauth");
    throw e;
  });
  return (
    <main className="simple-auth">
      <a className="text-brand" href="/me">
        libetario ↗
      </a>
      <section className="card form-stack">
        <p className="eyebrow">DUTY-PROTECTED CONTEXT</p>
        <h1>Duty access verified.</h1>
        <p className="notice success">
          Authorized duty date: {d.duty_date.toISOString().slice(0, 10)} ·
          version {d.authorization_version}
        </p>
        <p>
          Grant valid until{" "}
          {d.valid_until.toLocaleString("en-PH", { timeZone: "Asia/Manila" })}.
        </p>
        <p className="small muted">
          This page uses the shared server and database duty guard. It does not
          clock you in, create attendance, run a timer or record paid time.
        </p>
        <a href="/duty/reauth">Reauthenticate same grant</a>
        <a href="/duty">Duty status & sign-in</a>
        <a href="/work/tasks">Open my assigned tasks →</a>
        <a href="/me">← Account workspace</a>
        <DutyLogout csrf={csrfForSession(token!)} />
      </section>
    </main>
  );
}
