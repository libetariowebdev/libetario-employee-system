import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReleaseTarget } from "./release-db";

export async function privateDirectory(input: string | undefined) {
  if (
    !input ||
    !path.isAbsolute(input) ||
    path.normalize(input) !== input ||
    input === "/"
  )
    throw new Error("Expected an absolute, canonical private directory");
  const stat = await lstat(input);
  if (
    (await realpath(input)) !== input ||
    !stat.isDirectory() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error(
      "Expected a real private directory with no group or public access",
    );
  return input;
}

export const releaseChildEnv = {
  PATH: "/usr/bin:/bin",
  LANG: "C.UTF-8",
  NODE_ENV: "production" as const,
};

export function run(
  file: string,
  args: string[],
  timeout: number,
  env: NodeJS.ProcessEnv = releaseChildEnv,
) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(file, args, {
      env,
      stdio: ["ignore", "pipe", "ignore"],
      signal: AbortSignal.timeout(timeout),
      killSignal: "SIGKILL",
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      if (output.length < 65536) output += chunk;
    });
    let failed = false;
    child.once("error", () => {
      failed = true;
    });
    child.once("close", (status) => {
      if (status === 0 && !failed) resolve(output.trim());
      else reject(new Error(path.basename(file) + " failed or timed out"));
    });
  });
}

export async function shaFile(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function pgEnvironment(target: ReleaseTarget, scratch: string) {
  const pgpass = path.join(scratch, "pgpass");
  const quote = (value: string) =>
    value.replaceAll("\\", "\\\\").replaceAll(":", "\\:");
  const password = decodeURIComponent(target.url.password);
  if (/[\r\n]/.test(password))
    throw new Error("Invalid migration password format");
  await writeFile(
    pgpass,
    [
      target.url.hostname,
      target.port,
      target.database,
      target.url.username,
      password,
    ]
      .map(quote)
      .join(":") + "\n",
    { mode: 0o600, flag: "wx" },
  );
  return {
    ...releaseChildEnv,
    PGHOST: target.url.hostname,
    PGPORT: target.port,
    PGDATABASE: target.database,
    PGUSER: target.url.username,
    PGPASSFILE: pgpass,
    PGCONNECT_TIMEOUT: "5",
  };
}

export const postgresBin = "/usr/lib/postgresql/18/bin/";
