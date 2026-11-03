import "server-only";
import {
  lstat,
  mkdir,
  realpath,
  open,
  link,
  unlink,
  chmod,
} from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
export class StorageError extends Error {}
function inside(root: string, target: string) {
  const relative = path.relative(root, target);
  return (
    relative !== "" &&
    !relative.startsWith(".." + path.sep) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}
export function configuredRoot() {
  const input = process.env.PRIVATE_UPLOAD_ROOT;
  if (!input || !path.isAbsolute(input) || input.startsWith("\\\\"))
    throw new StorageError("Private storage configuration required");
  const root = path.resolve(input),
    cwd = path.resolve(".");
  if (
    [cwd, path.parse(root).root].includes(root) ||
    ["public", "src", ".next", "node_modules"].some(
      (dir) =>
        root === path.join(cwd, dir) || inside(path.join(cwd, dir), root),
    )
  )
    throw new StorageError("Unsafe private storage configuration");
  return root;
}
async function safeAncestors(target: string, missing = false) {
  let current = path.parse(target).root;
  for (const part of path
    .relative(current, target)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);
    const stat = await lstat(current).catch((e) => {
      if (missing && e.code === "ENOENT") return null;
      throw e;
    });
    if (!stat) return;
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new StorageError("Unsafe storage path");
  }
}
export async function storageRoot() {
  const root = configuredRoot();
  await safeAncestors(root, true);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await safeAncestors(root);
  const canonical = await realpath(root);
  if (canonical.toLowerCase() !== root.toLowerCase())
    throw new StorageError("Unsafe storage root");
  for (const name of ["quarantine", "objects"]) {
    const dir = path.join(root, name);
    await mkdir(dir, { mode: 0o700 }).catch(async (e) => {
      if (e.code !== "EEXIST") throw e;
    });
    await safeAncestors(dir);
  }
  return root;
}
export async function storagePath(key: string, area: "quarantine" | "objects") {
  if (!/^[a-f0-9]{64}$/.test(key))
    throw new StorageError("Invalid storage key");
  const root = await storageRoot(),
    target = path.join(root, area, key + ".bin");
  if (!inside(root, target)) throw new StorageError("Storage path escaped");
  return target;
}
export async function createQuarantine(key: string) {
  return open(
    await storagePath(key, "quarantine"),
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
}
export async function openPrivate(
  key: string,
  area: "quarantine" | "objects" = "objects",
) {
  const target = await storagePath(key, area),
    before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
    throw new StorageError("Unsafe file");
  const handle = await open(
    target,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  const after = await handle.stat();
  if (!after.isFile() || after.ino !== before.ino || after.dev !== before.dev) {
    await handle.close();
    throw new StorageError("File changed");
  }
  return handle;
}
export async function promote(key: string) {
  const source = await storagePath(key, "quarantine"),
    dest = await storagePath(key, "objects");
  const h = await openPrivate(key, "quarantine");
  try {
    await link(source, dest);
    const moved = await lstat(dest),
      original = await h.stat();
    if (
      moved.ino !== original.ino ||
      moved.dev !== original.dev ||
      moved.isSymbolicLink()
    )
      throw new StorageError("Unsafe promotion");
    await unlink(source);
    await chmod(dest, 0o400);
  } finally {
    await h.close();
  }
}
export async function removeRejectedBytes(key: string) {
  const q = await storagePath(key, "quarantine"),
    o = await storagePath(key, "objects");
  const stats = await Promise.all(
    [q, o].map((p) =>
      lstat(p).catch((e) => {
        if (e.code === "ENOENT") return null;
        throw e;
      }),
    ),
  );
  if ((stats[0] && stats[1]) || stats.some((s) => s && s.nlink > 1)) {
    if (
      !stats[0] ||
      !stats[1] ||
      !stats.every(
        (s) => !!s && s.isFile() && !s.isSymbolicLink() && s.nlink === 2,
      ) ||
      stats[0].ino !== stats[1].ino ||
      stats[0].dev !== stats[1].dev
    )
      throw new StorageError("Unrecognized file links");
    await chmod(q, 0o600);
    await unlink(q);
  }
  for (const area of ["quarantine", "objects"] as const) {
    const target = await storagePath(key, area);
    let h;
    try {
      h = await openPrivate(key, area);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    try {
      await chmod(target, 0o600);
      await unlink(target);
    } finally {
      await h.close();
    }
  }
}
