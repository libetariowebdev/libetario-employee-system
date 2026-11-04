import "server-only";
import { scoped } from "../db";
import { requireDuty } from "./duty";
import { session } from "../auth/service";
import { csrfForSession, digest, HttpError } from "../auth/security";
import type { Prisma } from "../../generated/prisma/client";
export type WorkSession = {
  hash: string;
  token: string;
  user_id: string;
  admin: boolean;
  name: string;
  csrf: string;
};
type Identity = {
  user_id: string;
  role: string;
  scope: string;
  must_change_password: boolean;
};
export async function workSession(
  accountToken?: string,
  dutyToken?: string,
  adminOnly = false,
): Promise<WorkSession> {
  const account =
    accountToken && /^[a-f0-9]{64}$/.test(accountToken)
      ? (
          await scoped(
            digest(accountToken),
            (tx) =>
              tx.$queryRaw<Identity[]>`SELECT * FROM private.auth_context()`,
          )
        )[0]
      : undefined;
  const duty = dutyToken
    ? await requireDuty(dutyToken, false).catch((e) => {
        if (e instanceof HttpError) return null;
        throw e;
      })
    : null;
  if (account && duty && account.user_id !== duty.user_id)
    throw new HttpError(
      403,
      "Conflicting sign-in identities; sign out and sign in again",
    );
  const admin =
    account?.role === "ADMINISTRATOR" &&
    account.scope === "ACCOUNT" &&
    !account.must_change_password;
  if (adminOnly && !admin)
    throw new HttpError(403, "Administrator access required");
  let token: string;
  if (admin) {
    await session(accountToken);
    token = accountToken!;
  } else {
    await requireDuty(dutyToken);
    token = dutyToken!;
  }
  const hash = digest(token);
  const context = (
    await scoped(
      hash,
      (tx) =>
        tx.$queryRaw<
          { user_id: string; administrator: boolean; display_name: string }[]
        >`SELECT * FROM private.work_context()`,
    )
  )[0];
  if (!context) throw new HttpError(401, "Valid work access required");
  return {
    hash,
    token,
    user_id: context.user_id,
    admin: context.administrator,
    name: context.display_name,
    csrf: csrfForSession(token),
  };
}
export function workError(e: unknown): never {
  if (e instanceof HttpError) throw e;
  const err = e as {
    code?: string;
    cause?: { originalCode?: string };
    meta?: {
      code?: string;
      driverAdapterError?: { cause?: { originalCode?: string } };
    };
  };
  const code =
    err.meta?.code ??
    err.meta?.driverAdapterError?.cause?.originalCode ??
    err.cause?.originalCode ??
    err.code;
  if (code === "P0002" || code === "P2025")
    throw new HttpError(404, "Not found");
  if (code === "42501")
    throw new HttpError(403, "Valid work permission required");
  if (code === "P0413") throw new HttpError(413, "Upload quota exceeded");
  if (["40001", "40P01", "P2034"].includes(code ?? ""))
    throw new HttpError(409, "The record changed; refresh and try again");
  if (["22023", "23514", "23502", "22P02", "22007"].includes(code ?? ""))
    throw new HttpError(
      400,
      "Change is not permitted by the current work rules",
    );
  if (
    ["23505", "23503", "23P01", "P0409", "P2002", "P2003"].includes(code ?? "")
  )
    throw new HttpError(409, "Change conflicts with an existing record");
  throw e;
}
export async function workScoped<T>(
  w: WorkSession,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  try {
    return await scoped(w.hash, async (tx) => {
      const row = (
        await tx.$queryRaw<
          { actor: string | null; admin: boolean }[]
        >`SELECT private.work_actor() AS actor,private.is_admin() AS admin`
      )[0];
      if (!row.actor || row.actor !== w.user_id || row.admin !== w.admin)
        throw new HttpError(401, "Valid work access required");
      return fn(tx);
    });
  } catch (e) {
    return workError(e);
  }
}
