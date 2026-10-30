import { z } from "zod";
export const securitySchema = z
  .object({
    idleMinutes: z.number().int().min(1).max(60).default(15),
    absoluteMinutes: z.number().int().min(5).max(480).default(60),
    accountLimit: z.number().int().min(3).max(10).default(5),
    networkLimit: z.number().int().min(5).max(100).default(30),
    windowMinutes: z.number().int().min(1).max(60).default(15),
    lockMinutes: z.number().int().min(1).max(60).default(15),
    resetMinutes: z.number().int().min(5).max(30).default(15),
    pinEnabled: z.boolean().default(false),
    adminTotpRequired: z.literal(true).default(true),
    dutyTotpRequired: z.literal(true).default(true),
    setupMinutes: z.number().int().min(1).max(5).default(5),
    factorLimit: z.number().int().min(3).max(10).default(5),
    factorNetworkLimit: z.number().int().min(5).max(100).default(30),
    recoveryNetworkLimit: z.number().int().min(3).max(10).default(5),
    sensitiveReauthMinutes: z.number().int().min(1).max(5).default(5),
    dutyIdleMinutes: z.number().int().min(5).max(120).default(30),
    dutyMaxHours: z.number().int().min(1).max(12).default(12),
  })
  .refine(
    (p) => p.idleMinutes <= p.absoluteMinutes,
    "Idle timeout exceeds absolute timeout",
  );
// Policy calculation only in 2a. No DUTY session can be issued until 2b.
export function dutySessionExpiry(
  now: Date,
  validUntil: Date,
  policy: ReturnType<typeof securitySchema.parse>,
) {
  if (
    !Number.isFinite(now.getTime()) ||
    !Number.isFinite(validUntil.getTime()) ||
    validUntil <= now
  )
    throw new Error("Duty window expired");
  const absolute = new Date(
    Math.min(
      validUntil.getTime(),
      now.getTime() + policy.dutyMaxHours * 3600000,
    ),
  );
  return {
    absolute,
    idle: new Date(
      Math.min(
        absolute.getTime(),
        now.getTime() + policy.dutyIdleMinutes * 60000,
      ),
    ),
  };
}
export function environment() {
  const e = z
    .object({
      APP_ORIGIN: z.url(),
      SESSION_SECRET: z.string().min(64),
      DATABASE_URL: z.string().min(1),
      AUTH_DATABASE_URL: z.string().min(1),
      TRUST_PROXY: z.enum(["true", "false"]).default("false"),
    })
    .parse(process.env);
  if (new URL(e.APP_ORIGIN).origin !== e.APP_ORIGIN)
    throw new Error("APP_ORIGIN must be an origin without path/trailing slash");
  if (
    process.env.NODE_ENV === "production" &&
    !e.APP_ORIGIN.startsWith("https://")
  )
    throw new Error("Production requires HTTPS");
  if (
    new URL(e.DATABASE_URL).username !== "libetario_runtime" ||
    new URL(e.AUTH_DATABASE_URL).username !== "libetario_auth"
  )
    throw new Error("Restricted database roles required");
  return e;
}
