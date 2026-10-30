import { cookies } from "next/headers";
import { dutyBinding } from "@/server/auth/duty";
import { DutySignIn } from "@/components/duty-console";
import { HttpError } from "@/server/auth/security";
export const dynamic = "force-dynamic";
export default async function ReauthPage() {
  let b;
  try {
    b = await dutyBinding((await cookies()).get("libetario_duty")?.value);
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
  }
  return (
    <main className="simple-auth">
      <a href="/me" className="text-brand">
        libetario ↗
      </a>
      <section className="card form-stack">
        <p className="eyebrow">SAME-GRANT REAUTHENTICATION</p>
        <h1>Resume secure access.</h1>
        {b ? (
          <DutySignIn csrf={b.csrf} date={b.date} reauth />
        ) : (
          <>
            <p className="notice">
              No eligible prior duty authorization. It may be revoked, expired
              or require fresh account sign-in.
            </p>
            <a className="button secondary" href="/duty">
              Account sign-in & duty status
            </a>
          </>
        )}
      </section>
    </main>
  );
}
