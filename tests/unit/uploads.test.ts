import { test } from "node:test";
import assert from "node:assert/strict";
import { safeFileName, uploadPolicySchema } from "../../src/lib/uploads";
test("upload policy is a validated allow-list with hard byte/resource ceilings, integer quotas and no arbitrary flags", () => {
  const p = uploadPolicySchema.parse({ allowedTypes: ["image/png"] });
  assert.equal(p.maxFileBytes, 10485760);
  assert.equal(p.validationTimeoutMs, 30000);
  assert.equal(p.appBytes, 5368709120);
  for (const b of [
    { allowedTypes: ["text/html"] },
    { allowedTypes: [] },
    { allowedTypes: ["image/png", "image/png"] },
    { allowedTypes: ["image/png"], maxFileBytes: 10485761 },
    { allowedTypes: ["image/png"], dailyBytes: 1.1 },
    { allowedTypes: ["image/png"], validationTimeoutMs: 30001 },
    { allowedTypes: ["image/png"], worker: true },
  ])
    assert.equal(uploadPolicySchema.safeParse(b).success, false);
});
test("filename normalization preserves safe display names but forbids ambiguous Windows names, streams and extension spoofing", () => {
  assert.equal(safeFileName("Ｓｃｒｅｅｎ.png", "image/png"), "Screen.png");
  assert.equal(safeFileName("screen.JPEG", "image/jpeg"), "screen.JPEG");
  for (const name of [
    "../file.png",
    "C:\\file.png",
    "file.png:secret",
    "image.exe.png",
    "file.jpg",
    "LPT9.png",
    "file?.png",
    "file\u202e.png",
    "file\u0085.png",
  ])
    assert.throws(() => safeFileName(name, "image/png"));
});
