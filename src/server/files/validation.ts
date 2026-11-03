import "server-only";
import { spawn } from "node:child_process";
import path from "node:path";
import type { UploadPolicy } from "../../lib/uploads";
export function validateBytes(
  bytes: Buffer,
  media: string,
  policy: UploadPolicy,
  signal?: AbortSignal,
): Promise<{ media: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--max-old-space-size=192",
        path.resolve("scripts/validate-upload.mjs"),
        media,
        JSON.stringify(policy),
      ],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          NODE_ENV: process.env.NODE_ENV,
        },
      },
    );
    let output = "",
      error = "",
      settled = false;
    const done = (reason?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (reason) {
        child.kill();
        reject(reason);
      } else {
        try {
          const result = JSON.parse(output);
          if (result.media !== media) throw new Error();
          resolve(result);
        } catch {
          reject(new Error("File validation failed"));
        }
      }
    };
    const abort = () => done(new Error("Upload aborted"));
    const timer = setTimeout(
      () => done(new Error("File validation timed out")),
      policy.validationTimeoutMs,
    );
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (b) => {
      output += b.toString();
      if (output.length > 4096) done(new Error("Invalid parser output"));
    });
    child.stderr.on("data", (b) => {
      if (error.length < 4096) error += b.toString();
    });
    child.on("error", () => done(new Error("File validator unavailable")));
    child.on("close", (code) =>
      code === 0 ? done() : done(new Error("File validation failed")),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(bytes);
  });
}
