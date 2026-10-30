import type { PoolClient } from "pg";
import { authPool, scoped } from "../db";
import { securitySchema } from "../../lib/config";
import {
  csrfForSession,
  digest,
  hashPassword,
  passwordValid,
  HttpError,
  randomToken,
  verifyPassword,
} from "./security";
import { randomUUID } from "node:crypto";

type Identity = {
  user_id: string;
  role: "ADMINISTRATOR" | "EMPLOYEE";
  must_change_password: boolean;
  session_id: string;
};
export type Session = Identity & { token: string; hash: string; csrf: string };
const dummyHash = hashPassword(`Unused-${randomToken()}`);
async function transaction<T>(fn: (c: PoolClient) => Promise<T>) {
  const c = await authPool.connect();
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
export async function securityPolicy(c?: PoolClient) {
  const result = await (c ?? authPool).query(
    "SELECT private.security_policy() AS policy",
  );
  return securitySchema.parse(result.rows[0].policy);
}
async function throttle(c: PoolClient, keys: string[], limits: number[]) {
  const p = await securityPolicy(c);
  for (const key of [...keys].sort())
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      key,
    ]);
  let locked = false;
  for (let i = 0; i < keys.length; i++) {
    const [scope, subject] = keys[i].split(":");
    await c.query(
      "INSERT INTO security_throttles(scope,subject_digest) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [scope, subject],
    );
    // A lock survives a window rollover. After its expiry a fresh window starts.
    await c.query(
      "UPDATE security_throttles SET failure_count=0,window_started_at=clock_timestamp(),locked_until=NULL WHERE scope=$1 AND subject_digest=$2 AND (locked_until IS NULL OR locked_until<=clock_timestamp()) AND (window_started_at<=clock_timestamp()-make_interval(mins=>$3) OR locked_until IS NOT NULL)",
      [scope, subject, p.windowMinutes],
    );
    const row = (
      await c.query(
        "SELECT failure_count,locked_until>clock_timestamp() AS locked FROM security_throttles WHERE scope=$1 AND subject_digest=$2",
        [scope, subject],
      )
    ).rows[0];
    if (row.locked || row.failure_count >= limits[i]) locked = true;
  }
  return {
    p,
    locked,
    async fail() {
      for (let i = 0; i < keys.length; i++) {
        const [scope, subject] = keys[i].split(":");
        await c.query(
          "UPDATE security_throttles SET failure_count=failure_count+1,locked_until=CASE WHEN failure_count+1>=$3 THEN clock_timestamp()+make_interval(mins=>$4) ELSE locked_until END,updated_at=clock_timestamp() WHERE scope=$1 AND subject_digest=$2",
          [scope, subject, limits[i], p.lockMinutes],
        );
      }
    },
    async clearAccount() {
      const [scope, subject] = keys[0].split(":");
      await c.query(
        "UPDATE security_throttles SET failure_count=0,locked_until=NULL,window_started_at=clock_timestamp() WHERE scope=$1 AND subject_digest=$2",
        [scope, subject],
      );
    },
  };
}
async function event(
  c: PoolClient,
  user: string | null,
  type: string,
  outcome: string,
  network: string,
  sessionId: string | null = null,
) {
  await c.query(
    "INSERT INTO auth_events(user_id,session_id,event_type,outcome,network_digest) VALUES($1,$2,$3,$4,$5)",
    [user, sessionId, type, outcome, network],
  );
}
export async function login(
  identifier: string,
  password: string,
  network: string,
) {
  const outcome = await transaction(async (c) => {
    const canonical = identifier.trim().toLowerCase();
    const u = (
      await c.query(
        "SELECT id,password_hash,authorization_version,disabled_at FROM users WHERE email=$1 OR username=$1",
        [canonical],
      )
    ).rows[0];
    const p = await securityPolicy(c);
    const t = await throttle(
      c,
      [
        `LOGIN_ACCOUNT:${digest(u?.id ?? canonical)}`,
        `LOGIN_NETWORK:${network}`,
      ],
      [p.accountLimit, p.networkLimit],
    );
    if (t.locked) {
      await event(c, u?.id ?? null, "LOGIN", "LOCKED", network);
      return null;
    }
    const valid = await verifyPassword(
      u?.password_hash ?? (await dummyHash),
      password,
    );
    if (!u || !valid || u.disabled_at) {
      await t.fail();
      await event(c, u?.id ?? null, "LOGIN", "FAILED", network);
      return null;
    }
    const token = randomToken(),
      csrf = csrfForSession(token),
      id = randomUUID();
    // Lock account before issuing a session so disabling/reset cannot race login.
    const live = (
      await c.query(
        "SELECT id FROM users WHERE id=$1 AND disabled_at IS NULL AND authorization_version=$2 FOR UPDATE",
        [u.id, u.authorization_version],
      )
    ).rows[0];
    if (!live) {
      await event(c, u.id, "LOGIN", "FAILED", network);
      return null;
    }
    await c.query(
      "INSERT INTO sessions(id,user_id,token_hash,csrf_token_hash,authorization_version,idle_expires_at,absolute_expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+make_interval(mins=>$6),clock_timestamp()+make_interval(mins=>$7))",
      [
        id,
        u.id,
        digest(token),
        digest(csrf),
        u.authorization_version,
        t.p.idleMinutes,
        t.p.absoluteMinutes,
      ],
    );
    await t.clearAccount();
    await event(c, u.id, "LOGIN", "SUCCESS", network, id);
    return { token, maxAge: t.p.absoluteMinutes * 60 };
  });
  if (!outcome)
    throw new HttpError(
      401,
      "Sign-in failed. Check your credentials or try again after the lockout period.",
    );
  return outcome;
}
export async function session(
  token: string | undefined,
  allowPasswordChange = false,
): Promise<Session> {
  if (!token || !/^[a-f0-9]{64}$/.test(token))
    throw new HttpError(401, "Sign in required");
  const hash = digest(token);
  const rows = await scoped(
    hash,
    (tx) => tx.$queryRaw<Identity[]>`SELECT * FROM private.identity()`,
  );
  const u = rows[0];
  if (!u) {
    await transaction(async (c) => {
      const expired = (
        await c.query(
          "UPDATE sessions SET revoked_at=clock_timestamp(),revocation_reason='EXPIRED' WHERE token_hash=$1 AND revoked_at IS NULL AND (idle_expires_at<=clock_timestamp() OR absolute_expires_at<=clock_timestamp()) RETURNING id,user_id",
          [hash],
        )
      ).rows[0];
      if (expired)
        await event(
          c,
          expired.user_id,
          "SESSION_EXPIRED",
          "SUCCESS",
          "",
          expired.id,
        );
    });
    throw new HttpError(401, "Sign in required");
  }
  if (u.must_change_password && !allowPasswordChange)
    throw new HttpError(428, "Change your temporary password first");
  const p = await securityPolicy();
  await authPool.query(
    "UPDATE sessions SET last_seen_at=clock_timestamp(),idle_expires_at=least(absolute_expires_at,clock_timestamp()+make_interval(mins=>$2)) WHERE id=$1 AND revoked_at IS NULL AND idle_expires_at>clock_timestamp() AND absolute_expires_at>clock_timestamp()",
    [u.session_id, p.idleMinutes],
  );
  return { ...u, token, hash, csrf: csrfForSession(token) };
}
export async function logout(s: Session) {
  await transaction(async (c) => {
    await c.query(
      "UPDATE sessions SET revoked_at=clock_timestamp(),revocation_reason='LOGOUT' WHERE id=$1 AND revoked_at IS NULL",
      [s.session_id],
    );
    await event(c, s.user_id, "LOGOUT", "SUCCESS", "", s.session_id);
  });
}
export async function changePassword(
  s: Session,
  current: string,
  next: string,
  network: string,
) {
  if (!passwordValid(next))
    throw new HttpError(
      400,
      "Password must have 12–128 characters, a letter and a non-letter.",
    );
  const success = await transaction(async (c) => {
    const p = await securityPolicy(c);
    const t = await throttle(
      c,
      [`PASSWORD_CHANGE:${digest(s.user_id)}`, `CHANGE_NETWORK:${network}`],
      [p.accountLimit, p.networkLimit],
    );
    if (t.locked) return false;
    const u = (
      await c.query(
        "SELECT password_hash,authorization_version FROM users WHERE id=$1 AND disabled_at IS NULL FOR UPDATE",
        [s.user_id],
      )
    ).rows[0];
    const active = (
      await c.query(
        "SELECT id FROM sessions WHERE id=$1 AND revoked_at IS NULL AND idle_expires_at>clock_timestamp() AND absolute_expires_at>clock_timestamp() AND authorization_version=$2",
        [s.session_id, u?.authorization_version],
      )
    ).rows[0];
    if (
      !u ||
      !active ||
      !(await verifyPassword(u.password_hash, current)) ||
      (await verifyPassword(u.password_hash, next))
    ) {
      await t.fail();
      await event(
        c,
        s.user_id,
        "PASSWORD_CHANGE",
        "FAILED",
        network,
        s.session_id,
      );
      return false;
    }
    const nextHash = await hashPassword(next);
    await c.query("SELECT set_config('app.session_hash',$1,true)", [s.hash]);
    await c.query(
      "UPDATE users SET password_hash=$2,must_change_password=false,password_changed_at=clock_timestamp(),authorization_version=authorization_version+1,updated_at=clock_timestamp(),version=version+1 WHERE id=$1",
      [s.user_id, nextHash],
    );
    await c.query(
      "UPDATE sessions SET revoked_at=clock_timestamp(),revocation_reason='PASSWORD_CHANGED' WHERE user_id=$1 AND revoked_at IS NULL",
      [s.user_id],
    );
    await t.clearAccount();
    await event(
      c,
      s.user_id,
      "PASSWORD_CHANGE",
      "SUCCESS",
      network,
      s.session_id,
    );
    return true;
  });
  if (!success)
    throw new HttpError(
      400,
      "Password change failed. Verify the current password and use a different new password, or try after lockout.",
    );
}
export async function requestReset(s: Session, userId: string, note: string) {
  if (s.role !== "ADMINISTRATOR" || s.must_change_password)
    throw new HttpError(403, "Administrator access required");
  const token = randomToken();
  await scoped(s.hash, async (tx) => {
    await tx.$queryRaw`SELECT private.request_password_reset(${userId}::uuid,${digest(token)},${note})::text`;
  });
  return token;
}
export async function completeReset(
  token: string,
  next: string,
  network: string,
) {
  if (!passwordValid(next))
    throw new HttpError(
      400,
      "Password must have 12–128 characters, a letter and a non-letter.",
    );
  const success = await transaction(async (c) => {
    const p = await securityPolicy(c);
    const t = await throttle(
      c,
      [`RESET_TOKEN:${digest(token)}`, `RESET_NETWORK:${network}`],
      [5, 5],
    );
    if (t.locked) return false;
    // Lock user first (same ordering as login/reset issuance), then reset row.
    const candidate = (
      await c.query(
        "SELECT user_id FROM credential_resets WHERE token_hash=$1",
        [digest(token)],
      )
    ).rows[0];
    const u = candidate
      ? (
          await c.query(
            "SELECT id,password_hash FROM users WHERE id=$1 AND disabled_at IS NULL FOR UPDATE",
            [candidate.user_id],
          )
        ).rows[0]
      : null;
    const reset = (
      await c.query(
        "SELECT id,user_id FROM credential_resets WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE",
        [digest(token)],
      )
    ).rows[0];
    if (!u || !reset || (await verifyPassword(u.password_hash, next))) {
      await t.fail();
      await event(c, u?.id ?? null, "PASSWORD_RESET", "FAILED", network);
      return false;
    }
    const passwordHash = await hashPassword(next);
    await c.query(
      "UPDATE users SET password_hash=$2,must_change_password=false,password_changed_at=clock_timestamp(),authorization_version=authorization_version+1,updated_at=clock_timestamp(),version=version+1 WHERE id=$1",
      [u.id, passwordHash],
    );
    await c.query(
      "UPDATE credential_resets SET consumed_at=clock_timestamp() WHERE user_id=$1 AND consumed_at IS NULL",
      [u.id],
    );
    await c.query(
      "UPDATE sessions SET revoked_at=clock_timestamp(),revocation_reason='PASSWORD_RESET' WHERE user_id=$1 AND revoked_at IS NULL",
      [u.id],
    );
    await t.clearAccount();
    await event(c, u.id, "PASSWORD_RESET", "SUCCESS", network);
    return true;
  });
  if (!success)
    throw new HttpError(
      400,
      "Reset failed. The token may be invalid, expired, already used, or temporarily locked.",
    );
}
