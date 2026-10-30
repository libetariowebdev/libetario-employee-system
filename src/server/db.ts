import "server-only";
import { PrismaClient, type Prisma } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { randomUUID } from "node:crypto";

// Only runtime credentials enter the DAL. Migration credentials are never imported here.
const globalDb = globalThis as unknown as {
  runtime?: PrismaClient;
  authPool?: pg.Pool;
};
export const db = (globalDb.runtime ??= new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.DATABASE_URL,
    max: 8,
    options: "-c timezone=UTC",
  }),
}));
// Authentication authority has a separate narrowly granted database role.
export const authPool = (globalDb.authPool ??= new pg.Pool({
  connectionString: process.env.AUTH_DATABASE_URL,
  options: "-c timezone=UTC",
  max: 5,
}));
export async function scoped<T>(
  hash: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.session_hash', ${hash}, true)`;
    await tx.$queryRaw`SELECT set_config('app.request_id', ${randomUUID()}, true)`;
    return fn(tx);
  });
}
