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
function comparable(file: string) {
  return process.platform === "win32" ? file.toLowerCase() : file;
}
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
  if (!input || !path.isAbsolute(input) || /^(?:\\\\|\/\/)/.test(input))
    throw new StorageError("Private storage configuration required");
  const root = path.resolve(input),
    cwd = path.resolve(".");
  if (
    [cwd, path.parse(root).root].map(comparable).includes(comparable(root)) ||
    ["public", "src", ".next", "node_modules"].some(
      (dir) =>
        comparable(root) === comparable(path.join(cwd, dir)) ||
        inside(path.join(cwd, dir), root),
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
type StoragePurpose = "work" | "payslip";
export async function storageRoot(purpose: StoragePurpose = "work") {
  const root = configuredRoot();
  await safeAncestors(root, true);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await safeAncestors(root);
  const canonical = await realpath(root);
  if (comparable(canonical) !== comparable(root))
    throw new StorageError("Unsafe storage root");
  for (const name of areas(purpose)) {
    const dir = path.join(root, name);
    await mkdir(dir, { mode: 0o700 }).catch(async (e) => {
      if (e.code !== "EEXIST") throw e;
    });
    await safeAncestors(dir);
  }
  return root;
}
function areas(purpose: StoragePurpose) {
  return purpose === "payslip"
    ? (["payslip-quarantine", "payslip-objects"] as const)
    : (["quarantine", "objects"] as const);
}
export async function storagePath(
  key: string,
  area: "quarantine" | "objects",
  purpose: StoragePurpose = "work",
) {
  if (!/^[a-f0-9]{64}$/.test(key))
    throw new StorageError("Invalid storage key");
  const root = await storageRoot(purpose),
    target = path.join(
      root,
      areas(purpose)[area === "quarantine" ? 0 : 1],
      key + ".bin",
    );
  if (!inside(root, target)) throw new StorageError("Storage path escaped");
  return target;
}
export async function createQuarantine(
  key: string,
  purpose: StoragePurpose = "work",
) {
  return open(
    await storagePath(key, "quarantine", purpose),
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
}
export async function openPrivate(
  key: string,
  area: "quarantine" | "objects" = "objects",
  purpose: StoragePurpose = "work",
) {
  const target = await storagePath(key, area, purpose),
    before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
    throw new StorageError("Unsafe file");
  const handle = await open(
    target,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  const after = await handle.stat();
  if (
    !after.isFile() ||
    after.nlink !== 1 ||
    after.ino !== before.ino ||
    after.dev !== before.dev
  ) {
    await handle.close();
    throw new StorageError("File changed");
  }
  return handle;
}
export async function promote(key: string, purpose: StoragePurpose = "work") {
  const source = await storagePath(key, "quarantine", purpose),
    dest = await storagePath(key, "objects", purpose);
  const h = await openPrivate(key, "quarantine", purpose);
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
export async function removeRejectedBytes(
  key: string,
  purpose: StoragePurpose = "work",
) {
  const q = await storagePath(key, "quarantine", purpose),
    o = await storagePath(key, "objects", purpose);
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
    const target = await storagePath(key, area, purpose);
    let h;
    try {
      h = await openPrivate(key, area, purpose);
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
