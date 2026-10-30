import "server-only";
import type { PoolClient } from "pg";
import { verify } from "@node-rs/argon2";
import { randomUUID } from "node:crypto";
import {
  transaction,
  throttle,
  event,
  securityPolicy,
  issueSession,
} from "./service";
import {
  digest,
  csrfForSession,
  verifyPassword,
  randomToken,
  HttpError,
} from "./security";
import { consumeTotp, AUTH_FAILURE } from "./mfa";
import { authPool } from "../db";
import { dutySessionExpiry } from "../../lib/config";
type Row = Record<string, any>;
const fail = () => new HttpError(401, AUTH_FAILURE);
async function policyLock(c: PoolClient) {
  await c.query("SELECT pg_advisory_xact_lock_shared(72426820::bigint)");
}
async function binding(
  c: PoolClient,
  token: string,
  purpose: "DUTY_LOGIN" | "DUTY_REAUTH",
) {
  const candidate = (
    await c.query("SELECT user_id FROM sessions WHERE token_hash=$1", [
      digest(token),
    ])
  ).rows[0];
  if (!candidate) return null;
  const u = (
    await c.query(
      "SELECT id,role,password_hash,disabled_at,must_change_password,authorization_version FROM users WHERE id=$1 FOR UPDATE",
      [candidate.user_id],
    )
  ).rows[0];
  const s = (
    await c.query(
      "SELECT * FROM sessions WHERE token_hash=$1 AND user_id=$2 FOR UPDATE",
      [digest(token), candidate.user_id],
    )
  ).rows[0];
  const clock = (
    await c.query(
      "SELECT private.security_now() now,private.current_security_policy_id() policy",
    )
  ).rows[0];
  if (
    !u ||
    !s ||
    u.role !== "EMPLOYEE" ||
    u.disabled_at ||
    u.must_change_password ||
    u.authorization_version !== s.authorization_version
  )
    return null;
  if (
    !(await c.query("SELECT private.employee_active($1) active", [u.id]))
      .rows[0].active
  )
    return null;
  if (purpose === "DUTY_LOGIN") {
    if (
      s.scope !== "ACCOUNT" ||
      s.revoked_at ||
      s.idle_expires_at <= clock.now ||
      s.absolute_expires_at <= clock.now
    )
      return null;
    // A revoked/expired DUTY row is only a reauthentication handle for the same
    // still-active grant. Current policy/factors are proved anew; it grants no access.
  } else if (
    s.scope !== "DUTY" ||
    (s.revoked_at &&
      ![
        "EXPIRED",
        "SECURITY_POLICY_CHANGED",
        "DUTY_CREDENTIAL_CHANGED",
      ].includes(s.revocation_reason))
  )
    return null;
  return { u, s, now: clock.now as Date, policy: clock.policy as string };
}
function validGrant(d: Row | undefined, now: Date, purpose: string, s: Row) {
  if (
    !d ||
    d.status !== "ACTIVATED" ||
    d.valid_from > now ||
    d.valid_until <= now
  )
    return false;
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const date = d.duty_day as string;
  return purpose === "DUTY_LOGIN"
    ? local === date
    : s.duty_id === d.id &&
        s.duty_authorization_version === d.authorization_version &&
        d.first_auth_version === d.authorization_version &&
        local >= date;
}
function answer(ch: Row, raw: string, bound: string) {
  return {
    challenge: raw,
    stage: ch.stage,
    expiresAt: ch.expires_at,
    csrf: csrfForSession(bound + ":" + raw),
  };
}
export async function startDuty(
  bound: string,
  date: string | undefined,
  password: string | undefined,
  reauth: boolean,
  network: string,
) {
  const purpose = reauth ? "DUTY_REAUTH" : "DUTY_LOGIN";
  const result = await transaction(async (c) => {
    await policyLock(c);
    // Throttle account before its row lock, consistent with password and MFA flows.
    const who = (
      await c.query("SELECT user_id FROM sessions WHERE token_hash=$1", [
        digest(bound),
      ])
    ).rows[0]?.user_id;
    const p = await securityPolicy(c),
      t = await throttle(
        c,
        [
          `${reauth ? "DUTY_START" : "LOGIN_ACCOUNT"}:${digest(who ?? digest(bound))}`,
          `${reauth ? "DUTY_START_NETWORK" : "LOGIN_NETWORK"}:${network}`,
        ],
        [p.accountLimit, p.networkLimit],
      );
    if (t.locked) return null;
    const ctx = await binding(c, bound, purpose);
    if (!ctx) {
      await t.fail();
      return null;
    }
    if (
      !reauth &&
      (!password || !(await verifyPassword(ctx.u.password_hash, password)))
    ) {
      await t.fail();
      await event(c, ctx.u.id, "DUTY_PASSWORD", "FAILED", network);
      return null;
    }
    const candidate = (
      await c.query(
        reauth
          ? "SELECT id FROM duty_authorizations WHERE id=$1 AND employee_id=$2"
          : "SELECT id FROM duty_authorizations WHERE duty_date=$1::date AND employee_id=$2",
        [reauth ? ctx.s.duty_id : date, ctx.u.id],
      )
    ).rows[0];
    const d = candidate
      ? (
          await c.query(
            "SELECT d.*,d.duty_date::text duty_day FROM private.lock_duty($1,$2) d",
            [candidate.id, ctx.u.id],
          )
        ).rows[0]
      : undefined;
    const e = (
      await c.query(
        "SELECT * FROM mfa_enrollments WHERE user_id=$1 AND state='CONFIRMED' FOR UPDATE",
        [ctx.u.id],
      )
    ).rows[0];
    const pin = (
      await c.query("SELECT version FROM employee_pins WHERE user_id=$1", [
        ctx.u.id,
      ])
    ).rows[0];
    if (
      !validGrant(d, ctx.now, purpose, ctx.s) ||
      !e ||
      (p.pinEnabled && !pin) ||
      (reauth &&
        (ctx.s.mfa_enrollment_id !== e.id ||
          ctx.s.mfa_generation !== e.generation))
    ) {
      await t.fail();
      await event(c, ctx.u.id, "DUTY_START", "FAILED", network);
      return null;
    }
    const id = randomUUID(),
      raw = randomToken(),
      stage = p.pinEnabled ? "PIN" : "TOTP";
    const ch = (
      await c.query(
        `INSERT INTO auth_challenges(id,user_id,bound_session_id,challenge_token_hash,purpose,stage,duty_id,duty_authorization_version,enrollment_id,enrollment_generation,pin_version,security_policy_id,user_authorization_version,password_verified_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,least($15::timestamptz+make_interval(mins=>$16),$17::timestamptz)) RETURNING stage,expires_at`,
        [
          id,
          ctx.u.id,
          ctx.s.id,
          digest(raw),
          purpose,
          stage,
          d.id,
          d.authorization_version,
          e.id,
          e.generation,
          p.pinEnabled ? pin.version : null,
          ctx.policy,
          ctx.u.authorization_version,
          reauth ? ctx.s.password_verified_at : ctx.now,
          ctx.now,
          p.setupMinutes,
          d.valid_until,
        ],
      )
    ).rows[0];
    await t.clearAccount();
    await event(c, ctx.u.id, "DUTY_CHALLENGE", "ISSUED", network, ctx.s.id);
    return answer(ch, raw, bound);
  });
  if (!result) throw fail();
  return result;
}
export async function completeDutyStage(
  bound: string,
  raw: string,
  stage: "PIN" | "TOTP",
  code: string,
  network: string,
) {
  const result = await transaction(async (c) => {
    await policyLock(c);
    // Do not touch a victim's account lockout when a challenge/session is foreign.
    const probe = (
      await c.query(
        "SELECT purpose,bound_session_id,user_id FROM auth_challenges WHERE challenge_token_hash=$1",
        [digest(raw)],
      )
    ).rows[0];
    const owner = (
      await c.query("SELECT id,user_id FROM sessions WHERE token_hash=$1", [
        digest(bound),
      ])
    ).rows[0];
    if (
      !probe ||
      probe.bound_session_id !== owner?.id ||
      probe.user_id !== owner.user_id
    ) {
      const p = await securityPolicy(c),
        t = await throttle(
          c,
          [`CHALLENGE_NETWORK:${network}`],
          [p.factorNetworkLimit],
        );
      if (!t.locked) await t.fail();
      return null;
    }
    const p = await securityPolicy(c),
      t = await throttle(
        c,
        [
          `${stage}:${digest(probe.user_id)}`,
          `${stage}_NETWORK:${network}`,
          `${stage}_CHALLENGE:${digest(raw)}`,
        ],
        [p.factorLimit, p.factorNetworkLimit, p.factorLimit],
      );
    if (t.locked) {
      await event(c, probe.user_id, stage, "LOCKED", network);
      return null;
    }
    const ctx = await binding(c, bound, probe.purpose);
    if (!ctx) return null;
    const hint = (
      await c.query(
        "SELECT duty_id FROM auth_challenges WHERE challenge_token_hash=$1",
        [digest(raw)],
      )
    ).rows[0];
    const d = hint
      ? (
          await c.query(
            "SELECT d.*,d.duty_date::text duty_day FROM private.lock_duty($1,$2) d",
            [hint.duty_id, ctx.u.id],
          )
        ).rows[0]
      : undefined;
    const e = (
      await c.query(
        "SELECT * FROM mfa_enrollments WHERE user_id=$1 AND state='CONFIRMED' FOR UPDATE",
        [ctx.u.id],
      )
    ).rows[0];
    const ch = (
      await c.query(
        "SELECT * FROM auth_challenges WHERE challenge_token_hash=$1 FOR UPDATE",
        [digest(raw)],
      )
    ).rows[0];
    const pin = (
      await c.query(
        "SELECT pin_hash,version FROM employee_pins WHERE user_id=$1",
        [ctx.u.id],
      )
    ).rows[0];
    const invalid =
      !ch ||
      ch.consumed_at ||
      ch.invalidated_at ||
      ch.expires_at <= ctx.now ||
      ch.user_authorization_version !== ctx.u.authorization_version ||
      ch.security_policy_id !== ctx.policy ||
      !validGrant(d, ctx.now, ch.purpose, ctx.s) ||
      ch.duty_authorization_version !== d?.authorization_version ||
      ch.enrollment_id !== e?.id ||
      ch.enrollment_generation !== e?.generation ||
      (p.pinEnabled && ch.pin_version !== pin?.version) ||
      (ch.purpose === "DUTY_LOGIN" &&
        ctx.now.getTime() - ch.password_verified_at.getTime() > 5 * 60000);
    if (
      invalid ||
      ch.stage !== stage ||
      (stage === "TOTP" && p.pinEnabled && !ch.pin_verified_at)
    ) {
      await t.fail();
      if (ch)
        await c.query(
          "UPDATE auth_challenges SET failed_attempts=failed_attempts+1,invalidated_at=CASE WHEN failed_attempts+1>=$2 THEN private.security_now() ELSE invalidated_at END WHERE id=$1",
          [ch.id, p.factorLimit],
        );
      await event(c, ctx.u.id, "DUTY_CHALLENGE", "FAILED", network);
      return null;
    }
    const good =
      stage === "PIN"
        ? pin && /^\d{6}$/.test(code) && (await verify(pin.pin_hash, code))
        : await consumeTotp(c, e, code, ctx.now);
    if (!good) {
      await t.fail();
      await c.query(
        "UPDATE auth_challenges SET failed_attempts=failed_attempts+1,invalidated_at=CASE WHEN failed_attempts+1>=$2 THEN private.security_now() ELSE invalidated_at END WHERE id=$1",
        [ch.id, p.factorLimit],
      );
      await event(c, ctx.u.id, stage, "FAILED", network);
      return null;
    }
    const finalContext = await binding(c, bound, ch.purpose);
    if (
      !finalContext ||
      finalContext.now >= ch.expires_at ||
      !validGrant(d, finalContext.now, ch.purpose, finalContext.s)
    )
      throw fail();
    const now = finalContext.now;
    await t.clearAccount();
    await event(c, ctx.u.id, stage, "SUCCESS", network, ctx.s.id);
    if (stage === "PIN") {
      const next = randomToken(),
        row = (
          await c.query(
            "UPDATE auth_challenges SET challenge_token_hash=$2,stage='TOTP',pin_verified_at=private.security_now(),version=version+1 WHERE id=$1 RETURNING stage,expires_at",
            [ch.id, digest(next)],
          )
        ).rows[0];
      return { kind: "CHALLENGE" as const, ...answer(row, next, bound) };
    }
    // Users/grant/policy remain locked; time and capability deadline are rechecked after expensive verification.
    await c.query("SELECT private.mark_duty_authenticated($1,$2,$3)", [
      d.id,
      ctx.u.id,
      d.authorization_version,
    ]);
    await c.query(
      "UPDATE auth_challenges SET consumed_at=private.security_now(),version=version+1 WHERE id=$1",
      [ch.id],
    );
    await c.query(
      "UPDATE sessions SET revoked_at=private.security_now(),revocation_reason='DUTY_AUTH_COMPLETE' WHERE id=$1",
      [ctx.s.id],
    );
    const account =
      ch.purpose === "DUTY_LOGIN"
        ? await issueSession(c, ctx.u.id, ctx.u.authorization_version, {
            enrollmentId: e.id,
            verified: true,
            passwordAt: ch.password_verified_at,
          })
        : undefined;
    const token = randomToken(),
      id = randomUUID(),
      expires = dutySessionExpiry(now, d.valid_until, p);
    await c.query(
      `INSERT INTO sessions(id,user_id,token_hash,csrf_token_hash,scope,authorization_version,created_at,last_seen_at,password_verified_at,mfa_enrollment_id,mfa_verified_at,security_policy_id,duty_id,duty_authorization_version,mfa_generation,pin_version,idle_expires_at,absolute_expires_at) VALUES($1,$2,$3,$4,'DUTY',$5,$6,$6,$7,$8,$6,$9,$10,$11,$12,$13,$14,$15)`,
      [
        id,
        ctx.u.id,
        digest(token),
        digest(csrfForSession(token)),
        ctx.u.authorization_version,
        now,
        ch.password_verified_at,
        e.id,
        ctx.policy,
        d.id,
        d.authorization_version,
        e.generation,
        p.pinEnabled ? pin.version : null,
        expires.idle,
        expires.absolute,
      ],
    );
    await event(c, ctx.u.id, "DUTY_LOGIN", "SUCCESS", network, id);
    return {
      kind: "SESSION" as const,
      token,
      maxAge: Math.max(
        1,
        Math.ceil((d.valid_until.getTime() - now.getTime()) / 1000),
      ),
      account,
    };
  });
  if (!result) throw fail();
  return result;
}
export async function dutyBinding(token: string | undefined) {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw fail();
  const result = await transaction(async (c) => {
    await policyLock(c);
    const ctx = await binding(c, token, "DUTY_REAUTH");
    if (!ctx) return null;
    const d = (
      await c.query(
        "SELECT *,duty_date::text duty_day FROM duty_authorizations WHERE id=$1 AND employee_id=$2",
        [ctx.s.duty_id, ctx.u.id],
      )
    ).rows[0];
    if (!validGrant(d, ctx.now, "DUTY_REAUTH", ctx.s)) return null;
    return {
      dutyId: d.id,
      date: d.duty_day,
      csrf: csrfForSession(token),
      validUntil: d.valid_until,
    };
  });
  if (!result) throw fail();
  return result;
}
export async function logoutDuty(token: string | undefined) {
  if (token && /^[a-f0-9]{64}$/.test(token))
    await authPool.query(
      "UPDATE sessions SET revoked_at=private.security_now(),revocation_reason='LOGOUT' WHERE token_hash=$1 AND scope='DUTY' AND (revoked_at IS NULL OR revocation_reason='EXPIRED')",
      [digest(token)],
    );
}
