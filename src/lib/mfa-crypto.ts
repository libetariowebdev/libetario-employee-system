import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import * as OTPAuth from "otpauth";
export type MfaOwner = { id: string; user_id: string; generation: number };
export type Envelope = MfaOwner & {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  tag: Uint8Array;
  encryption_key_id: string;
};
export function mfaKeyring(
  env: Record<string, string | undefined> = process.env,
) {
  try {
    const keys = JSON.parse(env.MFA_ENCRYPTION_KEYS ?? "null") as Record<
      string,
      string
    >;
    const active = env.MFA_ACTIVE_KEY_ID;
    if (!keys || Array.isArray(keys) || !active || !keys[active])
      throw new Error();
    const parsed = new Map<string, Buffer>();
    for (const [id, value] of Object.entries(keys)) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || typeof value !== "string")
        throw new Error();
      const key = Buffer.from(value, "base64");
      if (key.length !== 32 || key.toString("base64") !== value)
        throw new Error();
      parsed.set(id, key);
    }
    return { active, keys: parsed };
  } catch {
    throw new Error("MFA keyring is unavailable or invalid");
  }
}
function aad(owner: MfaOwner, keyId: string) {
  return Buffer.from(
    JSON.stringify([
      "libetario-mfa",
      1,
      owner.user_id,
      owner.id,
      owner.generation,
      keyId,
      "SHA1",
      6,
      30,
    ]),
  );
}
export function sealSecret(
  secret: Uint8Array,
  owner: MfaOwner,
  ring = mfaKeyring(),
) {
  if (secret.length !== 32) throw new Error("Invalid secret size");
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", ring.keys.get(ring.active)!, nonce, {
      authTagLength: 16,
    });
  cipher.setAAD(aad(owner, ring.active));
  return {
    ciphertext: Buffer.concat([cipher.update(secret), cipher.final()]),
    nonce,
    tag: cipher.getAuthTag(),
    encryption_key_id: ring.active,
  };
}
export function openSecret(e: Envelope, ring = mfaKeyring()) {
  try {
    const key = ring.keys.get(e.encryption_key_id);
    if (!key) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key, e.nonce, {
      authTagLength: 16,
    });
    decipher.setAAD(aad(e, e.encryption_key_id));
    decipher.setAuthTag(Buffer.from(e.tag));
    const secret = Buffer.concat([
      decipher.update(e.ciphertext),
      decipher.final(),
    ]);
    if (secret.length !== 32) throw new Error();
    return secret;
  } catch {
    throw new Error("MFA encrypted payload could not be verified");
  }
}
export function otp(secret: Uint8Array, timestamp: number, digits = 6) {
  return new OTPAuth.TOTP({
    secret: new OTPAuth.Secret({ buffer: Uint8Array.from(secret).buffer }),
    algorithm: "SHA1",
    digits,
    period: 30,
  }).generate({ timestamp });
}
export function acceptedStep(
  secret: Uint8Array,
  code: string,
  now: Date,
  last: bigint | null,
): bigint | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now.getTime() / 30000),
    matches: bigint[] = [];
  // Evaluate the complete permitted window; selecting the earliest match also
  // rejects an overlapping-window digit collision with an already consumed step.
  for (const delta of [-1, 0, 1]) {
    const step = current + delta;
    if (step < 0) continue;
    const expected = otp(secret, step * 30000);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(code)))
      matches.push(BigInt(step));
  }
  const match = matches[0];
  return match !== undefined && (last === null || match > last) ? match : null;
}
export function provisioningUri(secret: Uint8Array, label: string) {
  return new OTPAuth.TOTP({
    issuer: "Libetario",
    label,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: new OTPAuth.Secret({ buffer: Uint8Array.from(secret).buffer }),
  }).toString();
}
