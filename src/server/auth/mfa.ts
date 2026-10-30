import "server-only";
import type { PoolClient } from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import QRCode from "qrcode";
import { authPool, scoped } from "../db";
import {
  transaction,
  throttle,
  event,
  securityPolicy,
  issueSession,
  type Session,
} from "./service";
import {
  digest,
  verifyPassword,
  hashPassword,
  randomToken,
  HttpError,
} from "./security";
import {
  acceptedStep,
  openSecret,
  sealSecret,
  provisioningUri,
} from "../../lib/mfa-crypto";
export const AUTH_FAILURE = "Authentication failed or temporarily unavailable";
const costs = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
const dummy = hashPassword("Unused-" + randomToken());
type Context = {
  user: Record<string, any>;
  binding: Record<string, any>;
  now: Date;
};
async function context(c: PoolClient, s: Session): Promise<Context | null> {
  const user = (
    await c.query(
      "SELECT id,email,role,password_hash,authorization_version,must_change_password FROM users WHERE id=$1 AND disabled_at IS NULL FOR UPDATE",
      [s.user_id],
    )
  ).rows[0];
  if (!user || user.must_change_password) return null;
  await c.query("SELECT set_config('app.session_hash',$1,true)", [s.hash]);
  const valid = (await c.query("SELECT * FROM private.auth_context()")).rows[0];
  if (
    !valid ||
    valid.user_id !== s.user_id ||
    valid.session_id !== s.session_id
  )
    return null;
  const binding = (
    await c.query(
      "SELECT * FROM sessions WHERE id=$1 AND token_hash=$2 FOR UPDATE",
      [s.session_id, s.hash],
    )
  ).rows[0];
  if (!binding) return null;
  const current = (
    await c.query(
      "SELECT private.current_security_policy_id() id,private.security_now() now",
    )
  ).rows[0];
  if (binding.scope === "SETUP" && binding.security_policy_id !== current.id)
    return null;
  return { user, binding, now: current.now };
}
async function factor<T>(
  s: Session,
  network: string,
  kind: string,
  fn: (c: PoolClient, ctx: Context) => Promise<T | null>,
): Promise<T> {
  const outcome = await transaction(async (c) => {
    const p = await securityPolicy(c),
      t = await throttle(
        c,
        [
          `${kind}:${digest(s.user_id)}`,
          `${kind}_NETWORK:${network}`,
          `${kind}_SESSION:${digest(s.session_id)}`,
        ],
        [p.factorLimit, p.factorNetworkLimit, p.factorLimit],
      );
    if (t.locked) {
      await event(c, s.user_id, kind, "LOCKED", network, s.session_id);
      return null;
    }
    const ctx = await context(c, s);
    const result = ctx ? await fn(c, ctx) : null;
    if (!result) {
      await t.fail();
      await c.query(
        "UPDATE sessions SET setup_failures=setup_failures+1,revoked_at=CASE WHEN scope='SETUP' AND setup_failures+1>=$2 THEN private.security_now() ELSE revoked_at END,revocation_reason=CASE WHEN scope='SETUP' AND setup_failures+1>=$2 THEN 'MFA_LOCKOUT' ELSE revocation_reason END WHERE id=$1",
        [s.session_id, p.factorLimit],
      );
      await event(c, s.user_id, kind, "FAILED", network, s.session_id);
      return null;
    }
    await t.clearAccount();
    await event(c, s.user_id, kind, "SUCCESS", network, s.session_id);
    return result;
  });
  if (!outcome) throw new HttpError(401, AUTH_FAILURE);
  return outcome;
}
async function confirmed(c: PoolClient, userId: string) {
  return (
    await c.query(
      "SELECT * FROM mfa_enrollments WHERE user_id=$1 AND state='CONFIRMED' FOR UPDATE",
      [userId],
    )
  ).rows[0];
}
async function consumeTotp(
  c: PoolClient,
  enrollment: Record<string, any> | undefined,
  code: string,
  now: Date,
) {
  if (!enrollment || enrollment.state !== "CONFIRMED") return false;
  let secret: Buffer;
  try {
    secret = openSecret(enrollment as any);
  } catch {
    throw new HttpError(
      503,
      "Authenticator verification unavailable; contact your administrator",
    );
  }
  try {
    const step = acceptedStep(
      secret,
      code,
      now,
      enrollment.last_accepted_step === null
        ? null
        : BigInt(enrollment.last_accepted_step),
    );
    if (step === null) return false;
    const updated = await c.query(
      "UPDATE mfa_enrollments SET last_accepted_step=$2,updated_at=private.security_now(),version=version+1 WHERE id=$1 AND (last_accepted_step IS NULL OR last_accepted_step<$2)",
      [enrollment.id, step.toString()],
    );
    return updated.rowCount === 1;
  } finally {
    secret.fill(0);
  }
}
async function codeBatch(c: PoolClient, enrollmentId: string, batch: number) {
  const codes: string[] = [];
  await c.query(
    "UPDATE recovery_codes SET revoked_at=private.security_now() WHERE enrollment_id=$1 AND revoked_at IS NULL",
    [enrollmentId],
  );
  for (let i = 0; i < 10; i++) {
    const id = randomUUID(),
      secret = randomBytes(20).toString("hex");
    await c.query(
      "INSERT INTO recovery_codes(id,enrollment_id,batch_version,code_hash) VALUES($1,$2,$3,$4)",
      [id, enrollmentId, batch, await hash(secret, costs)],
    );
    codes.push(id + "." + secret);
  }
  await c.query(
    "UPDATE mfa_enrollments SET recovery_batch_version=$2 WHERE id=$1",
    [enrollmentId, batch],
  );
  return codes;
}
async function finalBindingCheck(c: PoolClient, ctx: Context) {
  const row = (
    await c.query(
      "SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.revoked_at IS NULL AND u.disabled_at IS NULL AND s.authorization_version=u.authorization_version AND s.idle_expires_at>private.security_now() AND s.absolute_expires_at>private.security_now() AND (s.scope<>'SETUP' OR s.security_policy_id=private.current_security_policy_id())",
      [ctx.binding.id],
    )
  ).rows[0];
  if (!row) throw new HttpError(401, AUTH_FAILURE);
}
async function revokeAll(c: PoolClient, userId: string, reason: string) {
  await c.query(
    "UPDATE credential_resets SET consumed_at=private.security_now() WHERE user_id=$1 AND consumed_at IS NULL",
    [userId],
  );
  await c.query(
    "UPDATE mfa_enrollments SET state='REVOKED',revoked_at=private.security_now(),ciphertext=NULL,nonce=NULL,tag=NULL,encryption_key_id=NULL,version=version+1,updated_at=private.security_now() WHERE user_id=$1 AND state IN ('PENDING','CONFIRMED')",
    [userId],
  );
  await c.query(
    "UPDATE recovery_codes SET revoked_at=private.security_now() WHERE enrollment_id IN (SELECT id FROM mfa_enrollments WHERE user_id=$1) AND revoked_at IS NULL",
    [userId],
  );
  const user = (
    await c.query(
      "UPDATE users SET authorization_version=authorization_version+1,updated_at=private.security_now(),version=version+1 WHERE id=$1 RETURNING authorization_version",
      [userId],
    )
  ).rows[0];
  await c.query(
    "UPDATE sessions SET revoked_at=private.security_now(),revocation_reason=$2 WHERE user_id=$1 AND revoked_at IS NULL",
    [userId, reason],
  );
  return user.authorization_version as number;
}
export async function mfaStatus(s: Session) {
  const e = (
    await authPool.query(
      "SELECT id,state,generation,confirmed_at,pending_expires_at FROM mfa_enrollments WHERE user_id=$1 ORDER BY generation DESC LIMIT 1",
      [s.user_id],
    )
  ).rows[0];
  const pin = (
    await authPool.query(
      "SELECT changed_at FROM employee_pins WHERE user_id=$1",
      [s.user_id],
    )
  ).rows[0];
  const count = e
    ? (
        await authPool.query(
          "SELECT count(*)::int n FROM recovery_codes WHERE enrollment_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL",
          [e.id],
        )
      ).rows[0].n
    : 0;
  return {
    scope: s.scope,
    purpose: s.setup_purpose,
    enrollment: e ?? null,
    pinConfigured: Boolean(pin),
    remainingCodes: count,
    pinEnabled: (await securityPolicy()).pinEnabled,
  };
}
export async function beginEnrollment(
  s: Session,
  password: string,
  replace: boolean,
  network: string,
) {
  return factor(s, network, "MFA_PASSWORD", async (c, ctx) => {
    if (!(await verifyPassword(ctx.user.password_hash, password))) return null;
    const current = (
      await c.query(
        "SELECT * FROM mfa_enrollments WHERE user_id=$1 AND state IN ('PENDING','CONFIRMED') FOR UPDATE",
        [s.user_id],
      )
    ).rows[0];
    if (current?.state === "CONFIRMED")
      throw new HttpError(409, "An authenticator is already enrolled");
    const history = (
      await c.query(
        "SELECT 1 FROM mfa_enrollments WHERE user_id=$1 AND (confirmed_at IS NOT NULL OR reset_id IS NOT NULL) LIMIT 1",
        [s.user_id],
      )
    ).rowCount;
    const allowedRecovery =
      ctx.binding.scope === "SETUP" &&
      ctx.binding.setup_purpose === "MFA_RECOVERY";
    if (history && !allowedRecovery) return null;
    if (
      ctx.binding.scope === "SETUP" &&
      !["MFA_ENROLL", "MFA_RECOVERY"].includes(ctx.binding.setup_purpose)
    )
      return null;
    if (current) {
      if (!replace && current.pending_expires_at > ctx.now)
        throw new HttpError(
          409,
          "Pending enrollment exists. Replace it explicitly if its QR was lost.",
        );
      await c.query(
        "UPDATE mfa_enrollments SET state='EXPIRED',ciphertext=NULL,nonce=NULL,tag=NULL,encryption_key_id=NULL,version=version+1 WHERE id=$1",
        [current.id],
      );
    }
    const generation = (
      await c.query(
        "SELECT coalesce(max(generation),0)+1 generation FROM mfa_enrollments WHERE user_id=$1",
        [s.user_id],
      )
    ).rows[0].generation;
    const id = randomUUID(),
      secret = randomBytes(32),
      owner = { id, user_id: s.user_id, generation },
      p = await securityPolicy(c),
      sealed = sealSecret(secret, owner);
    try {
      const qr = await QRCode.toDataURL(
        provisioningUri(secret, ctx.user.email),
        { errorCorrectionLevel: "M", width: 320, margin: 2 },
      );
      await c.query(
        `INSERT INTO mfa_enrollments(id,user_id,generation,state,ciphertext,nonce,tag,encryption_key_id,enrollment_session_id,reset_id,recovered_from_id,pending_expires_at) VALUES($1,$2,$3,'PENDING',$4,$5,$6,$7,$8,$9,$10,private.security_now()+make_interval(mins=>$11))`,
        [
          id,
          s.user_id,
          generation,
          sealed.ciphertext,
          sealed.nonce,
          sealed.tag,
          sealed.encryption_key_id,
          s.session_id,
          ctx.binding.reset_id,
          ctx.binding.recovery_enrollment_id,
          p.setupMinutes,
        ],
      );
      return { enrollmentId: id, qr };
    } finally {
      secret.fill(0);
    }
  });
}
export async function confirmEnrollment(
  s: Session,
  enrollmentId: string,
  code: string,
  network: string,
) {
  return factor(s, network, "TOTP", async (c, ctx) => {
    const e = (
      await c.query(
        "SELECT * FROM mfa_enrollments WHERE id=$1 AND user_id=$2 AND enrollment_session_id=$3 AND state='PENDING' FOR UPDATE",
        [enrollmentId, s.user_id, s.session_id],
      )
    ).rows[0];
    if (!e || e.pending_expires_at <= ctx.now) return null;
    let secret: Buffer;
    try {
      secret = openSecret(e);
    } catch {
      throw new HttpError(503, "Authenticator verification unavailable");
    }
    try {
      const step = acceptedStep(secret, code, ctx.now, null);
      if (step === null) return null;
      await c.query(
        "UPDATE mfa_enrollments SET state='CONFIRMED',confirmed_at=private.security_now(),last_accepted_step=$2,version=version+1 WHERE id=$1",
        [e.id, step.toString()],
      );
      const codes = await codeBatch(c, e.id, 1);
      await finalBindingCheck(c, ctx);
      await c.query(
        "UPDATE sessions SET revoked_at=private.security_now(),revocation_reason='MFA_ENROLLMENT_COMPLETE' WHERE id=$1",
        [s.session_id],
      );
      const issued = await issueSession(
        c,
        s.user_id,
        ctx.user.authorization_version,
        {
          enrollmentId: e.id,
          verified: true,
          passwordAt: ctx.binding.password_verified_at,
        },
      );
      return { ...issued, codes };
    } finally {
      secret.fill(0);
    }
  });
}
export async function verifyAdminMfa(
  s: Session,
  code: string,
  network: string,
) {
  return factor(s, network, "TOTP", async (c, ctx) => {
    if (
      ctx.user.role !== "ADMINISTRATOR" ||
      ctx.binding.scope !== "SETUP" ||
      ctx.binding.setup_purpose !== "MFA_LOGIN"
    )
      return null;
    const e = await confirmed(c, s.user_id);
    if (
      e?.id !== ctx.binding.mfa_enrollment_id ||
      !(await consumeTotp(c, e, code, ctx.now))
    )
      return null;
    await finalBindingCheck(c, ctx);
    await c.query(
      "UPDATE sessions SET revoked_at=private.security_now(),revocation_reason='MFA_LOGIN_COMPLETE' WHERE id=$1",
      [s.session_id],
    );
    return issueSession(c, s.user_id, ctx.user.authorization_version, {
      enrollmentId: e.id,
      verified: true,
      passwordAt: ctx.binding.password_verified_at,
    });
  });
}
export async function reauthenticateMfa(
  s: Session,
  code: string,
  network: string,
) {
  return factor(s, network, "TOTP", async (c, ctx) => {
    if (ctx.binding.scope !== "ACCOUNT") return null;
    const e = await confirmed(c, s.user_id);
    if (!(await consumeTotp(c, e, code, ctx.now))) return null;
    await c.query(
      "UPDATE sessions SET mfa_enrollment_id=$2,mfa_verified_at=private.security_now() WHERE id=$1",
      [s.session_id, e.id],
    );
    return { ok: true };
  });
}
export async function recoverAuthenticator(
  identifier: string,
  password: string,
  recoveryCode: string,
  network: string,
) {
  const outcome = await transaction(async (c) => {
    const canonical = identifier.trim().toLowerCase(),
      u = (
        await c.query(
          "SELECT id,password_hash,disabled_at,must_change_password,authorization_version FROM users WHERE email=$1 OR username=$1",
          [canonical],
        )
      ).rows[0],
      p = await securityPolicy(c);
    const t = await throttle(
      c,
      [`RECOVERY:${digest(u?.id ?? canonical)}`, `RECOVERY_NETWORK:${network}`],
      [p.factorLimit, p.recoveryNetworkLimit],
    );
    if (t.locked) {
      await event(c, u?.id ?? null, "RECOVERY", "LOCKED", network);
      return null;
    }
    const validPassword = await verifyPassword(
      u?.password_hash ?? (await dummy),
      password,
    );
    if (!u || u.disabled_at || u.must_change_password || !validPassword) {
      await t.fail();
      await event(c, u?.id ?? null, "RECOVERY", "FAILED", network);
      return null;
    }
    const live = (
      await c.query(
        "SELECT id FROM users WHERE id=$1 AND disabled_at IS NULL AND authorization_version=$2 FOR UPDATE",
        [u.id, u.authorization_version],
      )
    ).rows[0];
    if (!live) return null;
    const [id, secret] = recoveryCode.split(".");
    const record =
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        id ?? "",
      )
        ? (
            await c.query(
              "SELECT r.id,r.code_hash,r.enrollment_id FROM recovery_codes r JOIN mfa_enrollments e ON e.id=r.enrollment_id WHERE r.id=$1 AND e.user_id=$2 AND e.state='CONFIRMED' AND r.batch_version=e.recovery_batch_version AND r.consumed_at IS NULL AND r.revoked_at IS NULL FOR UPDATE OF r,e",
              [id, u.id],
            )
          ).rows[0]
        : null;
    if (!record || !secret || !(await verify(record.code_hash, secret))) {
      await t.fail();
      await event(c, u.id, "RECOVERY", "FAILED", network);
      return null;
    }
    await c.query(
      "UPDATE recovery_codes SET consumed_at=private.security_now() WHERE id=$1",
      [record.id],
    );
    const version = await revokeAll(c, u.id, "RECOVERY_CODE_USED");
    const issued = await issueSession(c, u.id, version, {
      purpose: "MFA_RECOVERY",
      recoveryId: record.enrollment_id,
    });
    await t.clearAccount();
    await event(c, u.id, "RECOVERY", "ENROLLMENT_ONLY", network, issued.id);
    return issued;
  });
  if (!outcome) throw new HttpError(401, AUTH_FAILURE);
  return outcome;
}
export async function redeemAuthenticatorReset(
  identifier: string,
  password: string,
  token: string,
  network: string,
) {
  const outcome = await transaction(async (c) => {
    const canonical = identifier.trim().toLowerCase(),
      u = (
        await c.query(
          "SELECT id,password_hash,disabled_at,authorization_version,must_change_password FROM users WHERE email=$1 OR username=$1",
          [canonical],
        )
      ).rows[0],
      p = await securityPolicy(c);
    const t = await throttle(
      c,
      [
        `MFA_RESET:${digest(u?.id ?? canonical)}`,
        `MFA_RESET_NETWORK:${network}`,
        `MFA_RESET_TOKEN:${digest(token)}`,
      ],
      [p.factorLimit, p.recoveryNetworkLimit, p.factorLimit],
    );
    if (t.locked) return null;
    if (
      !(await verifyPassword(u?.password_hash ?? (await dummy), password)) ||
      !u ||
      u.disabled_at ||
      u.must_change_password
    ) {
      await t.fail();
      return null;
    }
    const locked = (
      await c.query(
        "SELECT authorization_version FROM users WHERE id=$1 AND disabled_at IS NULL AND authorization_version=$2 FOR UPDATE",
        [u.id, u.authorization_version],
      )
    ).rows[0];
    if (!locked) return null;
    const reset = (
      await c.query(
        "SELECT id,target_enrollment_id FROM credential_resets WHERE token_hash=$1 AND user_id=$2 AND kind='AUTHENTICATOR' AND consumed_at IS NULL AND expires_at>private.security_now() FOR UPDATE",
        [digest(token), u.id],
      )
    ).rows[0];
    if (!reset) {
      await t.fail();
      await event(c, u.id, "MFA_RESET", "FAILED", network);
      return null;
    }
    await c.query(
      "UPDATE credential_resets SET consumed_at=private.security_now() WHERE id=$1",
      [reset.id],
    );
    const issued = await issueSession(c, u.id, locked.authorization_version, {
      purpose: "MFA_RECOVERY",
      resetId: reset.id,
      recoveryId: reset.target_enrollment_id,
    });
    await t.clearAccount();
    await event(c, u.id, "MFA_RESET", "REDEEMED", network, issued.id);
    return issued;
  });
  if (!outcome) throw new HttpError(401, AUTH_FAILURE);
  return outcome;
}
export async function setPin(
  s: Session,
  password: string,
  code: string,
  pin: string,
  network: string,
) {
  if (!/^\d{6}$/.test(pin))
    throw new HttpError(400, "PIN must be exactly six digits");
  return factor(s, network, "TOTP", async (c, ctx) => {
    if (
      ctx.binding.scope !== "ACCOUNT" ||
      ctx.user.role !== "EMPLOYEE" ||
      !(await verifyPassword(ctx.user.password_hash, password)) ||
      !(await consumeTotp(c, await confirmed(c, s.user_id), code, ctx.now))
    )
      return null;
    await c.query(
      "INSERT INTO employee_pins(user_id,pin_hash) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET pin_hash=excluded.pin_hash,changed_at=private.security_now(),version=employee_pins.version+1",
      [s.user_id, await hash(pin, costs)],
    );
    return { ok: true };
  });
}
export async function verifyPin(s: Session, pin: string, network: string) {
  return factor(s, network, "PIN", async (c, ctx) => {
    if (ctx.binding.scope !== "ACCOUNT" || ctx.user.role !== "EMPLOYEE")
      return null;
    const row = (
      await c.query("SELECT pin_hash FROM employee_pins WHERE user_id=$1", [
        s.user_id,
      ])
    ).rows[0];
    return row && /^\d{6}$/.test(pin) && (await verify(row.pin_hash, pin))
      ? { ok: true }
      : null;
  });
}
export async function regenerateCodes(
  s: Session,
  password: string,
  code: string,
  network: string,
) {
  return factor(s, network, "TOTP", async (c, ctx) => {
    if (
      ctx.binding.scope !== "ACCOUNT" ||
      !(await verifyPassword(ctx.user.password_hash, password))
    )
      return null;
    const e = await confirmed(c, s.user_id);
    if (!(await consumeTotp(c, e, code, ctx.now))) return null;
    return { codes: await codeBatch(c, e.id, e.recovery_batch_version + 1) };
  });
}
export async function requestMfaReset(
  s: Session,
  userId: string,
  note: string,
  reason: string,
) {
  if (s.role !== "ADMINISTRATOR" || s.scope !== "ACCOUNT")
    throw new HttpError(403, "Administrator access required");
  const token = randomToken();
  await scoped(s.hash, async (tx) => {
    await tx.$queryRaw`SELECT private.admin_reset_mfa(${userId}::uuid,${digest(token)},${note},${reason})`;
  });
  return token;
}
