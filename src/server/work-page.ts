import "server-only";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { workSession } from "./dal/work";
import { HttpError } from "./auth/security";
import { ZodError } from "zod";
export async function workPage(admin = false) {
  const jar = await cookies();
  try {
    return await workSession(
      jar.get("libetario_session")?.value,
      jar.get("libetario_duty")?.value,
      admin,
    );
  } catch (e) {
    if (e instanceof HttpError) {
      if (e.status === 401) redirect(admin ? "/login" : "/duty/reauth");
      throw e;
    }
    throw e;
  }
}
export async function pageRecord<T>(operation: Promise<T>) {
  try {
    return await operation;
  } catch (e) {
    if ((e instanceof HttpError && e.status === 404) || e instanceof ZodError)
      notFound();
    throw e;
  }
}
export function workSearch(
  input: Record<string, string | string[] | undefined>,
) {
  return Object.fromEntries(
    Object.entries(input).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && entry[1] !== "",
    ),
  );
}
export type Serialized<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? Serialized<U>[]
    : T extends object
      ? { [K in keyof T]: Serialized<T[K]> }
      : T;
export function serialized<T>(data: T): Serialized<T> {
  return JSON.parse(JSON.stringify(data));
}
