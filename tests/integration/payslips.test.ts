import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { digest } from "../helpers";
import {
  addDays,
  fixturePay,
  payrollFixture,
  payReason,
} from "../payroll-helpers";
import { authPool, db, scoped } from "../../src/server/db";
import { session } from "../../src/server/auth/service";
import { storagePath, storageRoot } from "../../src/server/files/storage";
import {
  downloadPayslip,
  issuePayslip,
  payslipLocator,
  readDelivery,
  recordPayment,
} from "../../src/server/payslips/service";
import { sha256 } from "../../src/server/payslips/pdf";
import { changePayroll } from "../../src/server/services/payroll";
import { createProject } from "../../src/server/services/work";
import { workSession } from "../../src/server/dal/work";
import { exportPayroll } from "../../src/server/payslips/export";

after(async () => {
  await db.$disconnect();
  await authPool.end();
});
const status = (expected: number) => (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "status" in error &&
  error.status === expected;
const reason = {
  reason: payReason,
  evidence: "Synthetic evidence for the acceptance test",
};

async function positivePeriod(
  f: Awaited<ReturnType<typeof payrollFixture>>,
  both = false,
  method = "TEST_BANK",
) {
  for (const person of both ? (["a", "b"] as const) : (["a"] as const))
    await f.shift(
      person,
      f.start,
      f.start + "T00:00:00Z",
      f.start + "T02:00:00Z",
      "7200",
    );
  const { id } = await f.prepare(both ? ["a", "b"] : ["a"]);
  await f.approve(id);
  const p = await f.period(id);
  const a = await f.line(p.lines.find((l) => l.employeeId === f.ids.a)!.id);
  const b = p.lines.find((l) => l.employeeId === f.ids.b);
  const date = addDays(f.end, 2);
  const input = {
    expectedVersion: a.version,
    expectedPeriodVersion: p.version,
    date,
    reason: payReason,
    operationKey: randomUUID(),
    method,
    reference: Date.now().toString(),
    amount: a.net,
  };
  await f.at(date + "T02:00:00Z");
  return { p, a, b, input };
}

test("payment is idempotent, exact, frozen, and unique across lines after ASCII reference normalization", async () => {
  const f = await payrollFixture({
    ...fixturePay,
    paymentMethods: [
      {
        code: "TEST_UPPER",
        reference: "UPPER_ALNUM",
        dateRule: "ON_OR_AFTER_PAYDAY",
      },
    ],
  });
  try {
    const { a, b, input } = await positivePeriod(f, true, "TEST_UPPER");
    const data = { ...input, reference: " Batch-" + input.reference + " " };
    const attempts = await Promise.all([
      recordPayment(f.admin, a.id, data),
      recordPayment(f.admin, a.id, {
        ...data,
        reference: data.reference.toUpperCase(),
      }),
    ]);
    assert.equal(attempts[0].id, attempts[1].id);
    await assert.rejects(
      () =>
        recordPayment(f.admin, a.id, {
          ...data,
          reason: payReason + " changed",
        }),
      status(409),
    );
    await assert.rejects(
      () =>
        recordPayment(f.admin, a.id, { ...data, operationKey: randomUUID() }),
      status(409),
    );
    await assert.rejects(
      () =>
        recordPayment(f.admin, b!.id, {
          ...data,
          operationKey: randomUUID(),
          expectedVersion: b!.version,
          amount: b!.net,
        }),
      status(409),
    );
    const paid = await f.line(a.id);
    assert.equal(paid.state, "PAID");
    assert.equal(paid.version, a.version + 1);
    assert.equal(paid.snapshotDigest, a.snapshotDigest);
    assert.deepEqual(paid.snapshot, a.snapshot);
    assert.equal((await f.line(b!.id)).state, "APPROVED");
    const ledger = (
      await f.owner.query(
        "SELECT method,normalized_reference,amount::text FROM payments WHERE line_id=$1",
        [a.id],
      )
    ).rows;
    assert.deepEqual(ledger, [
      {
        method: "TEST_UPPER",
        normalized_reference: data.reference.trim().toUpperCase(),
        amount: a.net,
      },
    ]);
    assert.equal(
      (
        await f.owner.query(
          "SELECT count(*)::int n FROM audit_log WHERE action='payroll.payment_recorded' AND payload->>'lineId'=$1",
          [a.id],
        )
      ).rows[0].n,
      1,
    );
    await assert.rejects(
      () =>
        scoped(
          f.admin.hash,
          (tx) =>
            tx.$executeRaw`UPDATE payments SET amount=1 WHERE line_id=${a.id}::uuid`,
        ),
      /permission denied/,
    );
    await assert.rejects(
      () => f.owner.query("DELETE FROM payments WHERE line_id=$1", [a.id]),
      /Append-only record/,
    );
  } finally {
    await f.cleanup();
  }
});

test("payment rejects invalid rules, dates, references, amount, stale versions and a superseded line", async () => {
  const f = await payrollFixture();
  try {
    const { a, input } = await positivePeriod(f);
    for (const fields of [
      { method: "UNKNOWN" },
      { reference: "ABC" },
      { amount: "0.00" },
      { amount: "1.00" },
      { date: f.end },
      { date: addDays(input.date, 1) },
    ])
      await assert.rejects(
        () => recordPayment(f.admin, a.id, { ...input, ...fields }),
        status(400),
      );
    for (const fields of [{ expectedVersion: 1 }, { expectedPeriodVersion: 1 }])
      await assert.rejects(
        () => recordPayment(f.admin, a.id, { ...input, ...fields }),
        status(409),
      );
    await f.owner.query(
      "UPDATE sessions SET mfa_verified_at=private.security_now()-interval '20 min' WHERE token_hash=$1",
      [digest(f.tokens.admin)],
    );
    await assert.rejects(
      () => recordPayment(f.admin, a.id, input),
      status(403),
    );
    await f.at(input.date + "T02:00:00Z");
    const replacement = await f.command(a.id, a.version, "REPLACE", reason);
    const draft = await f.line(replacement.id);
    await f.command(draft.id, draft.version, "APPROVE_REPLACEMENT", reason);
    assert.equal((await f.line(a.id)).state, "ADJUSTED");
    await assert.rejects(
      () => recordPayment(f.admin, a.id, input),
      status(409),
    );
    const incomplete = { ...fixturePay };
    Reflect.deleteProperty(incomplete, "paymentMethods");
    await f.publish(incomplete, input.date);
    const active = await f.line(draft.id);
    await assert.rejects(
      () =>
        recordPayment(f.admin, draft.id, {
          ...input,
          expectedVersion: active.version,
        }),
      status(422),
    );
    assert.equal(
      (
        await f.owner.query(
          "SELECT count(*)::int n FROM payments WHERE line_id=ANY($1)",
          [[a.id, draft.id]],
        )
      ).rows[0].n,
      0,
    );
  } finally {
    await f.cleanup();
  }
});

test("a reviewed zero net is approved with no disbursement and cannot create a payment", async () => {
  const f = await payrollFixture();
  try {
    const { id } = await f.prepare();
    const draft = (await f.period(id)).lines[0];
    await f.command(draft.id, draft.version, "ZERO_REVIEW", reason);
    await f.approve(id);
    const l = await f.line(draft.id);
    const p = await f.period(id);
    await f.at(addDays(f.end, 2) + "T02:00:00Z");
    await assert.rejects(
      () =>
        recordPayment(f.admin, l.id, {
          expectedVersion: l.version,
          expectedPeriodVersion: p.version,
          date: addDays(f.end, 2),
          reason: payReason,
          operationKey: randomUUID(),
          method: "TEST_BANK",
          reference: "943",
          amount: "0.00",
        }),
      status(400),
    );
    assert.equal(l.state, "APPROVED");
    assert.equal((await readDelivery(f.admin, l.id)).paymentDate, null);
  } finally {
    await f.cleanup();
  }
});

test("two PDF versions survive concurrent publication, payment, and a later-period paid correction", async () => {
  const f = await payrollFixture();
  try {
    const { a, input } = await positivePeriod(f);
    const [slip, duplicate] = await Promise.all([
      issuePayslip(f.admin, a.id, "APPROVAL"),
      issuePayslip(f.admin, a.id, "APPROVAL"),
    ]);
    assert.deepEqual(slip, duplicate);
    const person = await session(f.tokens.a);
    const peer = await session(f.tokens.b);
    const get = async (ref: string) => {
      const r = await downloadPayslip(
        person,
        ref,
        new Request("http://localhost"),
      );
      return Buffer.from(await r.arrayBuffer());
    };
    const original = await get(slip.reference);
    const locator = await payslipLocator(person, slip.reference);
    assert.equal(sha256(original), locator.sha256);
    assert.equal(original.length, Number(locator.size_bytes));
    assert.notEqual(locator.storage_key, slip.reference);
    const fileId = (
      await f.owner.query("SELECT file_id FROM payslips WHERE reference=$1", [
        slip.reference,
      ])
    ).rows[0].file_id;
    await assert.rejects(
      () =>
        scoped(
          f.admin.hash,
          (tx) =>
            tx.$executeRaw`UPDATE payslips SET file_id=${fileId}::uuid WHERE reference=${slip.reference}`,
        ),
      /permission denied/,
    );
    const { id: project } = await createProject(
      await workSession(f.tokens.admin),
      {
        creationKey: randomUUID(),
        code: "R-" + f.suffix.toUpperCase(),
        name: "Synthetic payslip relink",
      },
    );
    await assert.rejects(
      () =>
        f.owner.query(
          "INSERT INTO project_files(project_id,file_id,linked_by) VALUES($1,$2,$3)",
          [project, fileId, f.ids.admin],
        ),
      /Exactly one matching typed file owner/,
    );
    assert.equal((await readDelivery(person)).length, 1);
    assert.deepEqual(await readDelivery(peer), []);
    await assert.rejects(
      () => payslipLocator(peer, slip.reference),
      status(404),
    );
    assert.deepEqual(
      await scoped(peer.hash, (tx) => tx.$queryRaw`SELECT id FROM payslips`),
      [],
    );
    assert.deepEqual(
      await scoped(person.hash, (tx) => tx.$queryRaw`SELECT id FROM payments`),
      [],
    );
    await assert.rejects(
      () =>
        scoped(
          person.hash,
          (tx) => tx.$queryRaw`SELECT storage_key FROM file_objects`,
        ),
      /permission denied/,
    );
    const { id: paymentId } = await recordPayment(f.admin, a.id, input);
    const second = await issuePayslip(f.admin, a.id, "PAYMENT");
    assert.equal(second.version, 2);
    assert.notEqual(second.reference, slip.reference);
    const paidBytes = await get(second.reference);
    assert.notDeepEqual(original, paidBytes);
    assert.deepEqual(await get(slip.reference), original);
    assert.equal((await readDelivery(person, a.id)).payment, null);

    const { id: category } = await changePayroll(f.admin, "catalog", {
      kind: "EARNING",
      code: "CORR_" + input.reference,
      label: "Reviewed correction",
      category: "ADJUSTMENT",
      effectiveDate: f.end,
      enabled: true,
      reason: payReason,
      rule: { mode: "MANUAL" },
    });
    const paid = await f.line(a.id);
    await f.command(a.id, paid.version, "CORRECTION_NEEDED", reason);
    const correction = (
      await f.owner.query(
        "SELECT id FROM payroll_adjustments WHERE line_id=$1 AND kind='CORRECTION_NEEDED'",
        [a.id],
      )
    ).rows[0];
    const later = await f.prepare(["a"], f.end);
    const l = (await f.period(later.id)).lines[0];
    await f.command(l.id, l.version, "POST_CORRECTION", {
      ...reason,
      typeId: category,
      correctionId: correction.id,
      kind: "EARNING",
      date: f.end,
      amount: "3.21",
    });
    assert.equal((await f.line(l.id)).net, "3.21");
    assert.equal((await f.line(a.id)).snapshotDigest, paid.snapshotDigest);
    assert.equal(
      (await f.owner.query("SELECT id FROM payments WHERE line_id=$1", [a.id]))
        .rows[0].id,
      paymentId,
    );
    await f.owner.query(
      "UPDATE employee_profiles SET legal_name='Later Fixture Name' WHERE user_id=$1",
      [f.ids.a],
    );
    assert.deepEqual(await get(slip.reference), original);
    assert.deepEqual(await get(second.reference), paidBytes);
  } finally {
    await f.cleanup();
  }
});

test("failed publication keeps the ledger and orphan cleanup retains owned bytes", async () => {
  const f = await payrollFixture();
  const configured = process.env.PRIVATE_UPLOAD_ROOT!;
  const root = path.join(configured, "payslip-test-" + randomUUID());
  process.env.PRIVATE_UPLOAD_ROOT = root;
  try {
    const { a, input } = await positivePeriod(f);
    await mkdir(root, { recursive: true });
    const blocked = path.join(root, "payslip-quarantine");
    await writeFile(blocked, "blocked", { flag: "wx" });
    await assert.rejects(
      () => issuePayslip(f.admin, a.id, "APPROVAL"),
      status(503),
    );
    assert.equal((await f.line(a.id)).state, "APPROVED");
    const payment = await recordPayment(f.admin, a.id, input);
    await assert.rejects(
      () => issuePayslip(f.admin, a.id, "PAYMENT"),
      status(503),
    );
    assert.equal((await f.line(a.id)).state, "PAID");
    await unlink(blocked);
    const slip = await issuePayslip(f.admin, a.id, "PAYMENT");
    assert.deepEqual(await recordPayment(f.admin, a.id, input), payment);
    assert.equal((await readDelivery(f.admin, a.id)).payslips.length, 2);
    await assert.rejects(
      () => storagePath("../payroll", "objects", "payslip"),
      /storage key/,
    );
    await storageRoot("payslip");
    const orphan = randomBytes(32).toString("hex");
    const orphanFile = await storagePath(orphan, "objects", "payslip");
    await writeFile(orphanFile, "abandoned synthetic PDF bytes", {
      flag: "wx",
    });
    const old = new Date(Date.now() - 48 * 3600000);
    await utimes(orphanFile, old, old);
    const locator = await payslipLocator(f.admin, slip.reference);
    const owned = await storagePath(locator.storage_key, "objects", "payslip");
    await chmod(owned, 0o600);
    await utimes(owned, old, old);
    await chmod(owned, 0o400);
    const command = (key: string) =>
      execFileSync(
        process.execPath,
        [
          "--conditions=react-server",
          "--import",
          "tsx",
          "scripts/cleanup-payslip-orphans.ts",
          "--test",
          "--key",
          key,
        ],
        {
          encoding: "utf8",
          env: { ...process.env, PRIVATE_UPLOAD_ROOT: root },
        },
      );
    assert.match(command(orphan), /Removed 1/);
    assert.match(command(locator.storage_key), /Removed 0/);
    await assert.rejects(() => unlink(orphanFile), { code: "ENOENT" });
    const response = await downloadPayslip(
      f.admin,
      slip.reference,
      new Request("http://localhost"),
    );
    assert.equal(
      sha256(Buffer.from(await response.arrayBuffer())),
      locator.sha256,
    );
  } finally {
    process.env.PRIVATE_UPLOAD_ROOT = configured;
    await f.cleanup();
  }
});

test("export rechecks the same restricted administrator session on each chunk", async () => {
  const f = await payrollFixture();
  try {
    const { a } = await positivePeriod(f);
    await issuePayslip(f.admin, a.id, "APPROVAL");
    const endpoint = "http://localhost?start=" + f.start + "&end=" + f.start;
    const zip = await exportPayroll(f.admin, "ZIP", new Request(endpoint));
    const csv = await exportPayroll(f.admin, "CSV", new Request(endpoint));
    const readers = [zip.body!.getReader(), csv.body!.getReader()];
    for (const reader of readers)
      assert.equal((await reader.read()).done, false);
    await f.owner.query(
      "UPDATE sessions SET revoked_at=private.security_now(),revocation_reason='LOGOUT' WHERE token_hash=$1",
      [digest(f.tokens.admin)],
    );
    for (const reader of readers)
      await assert.rejects(() => reader.read(), /authorization/);
    const person = await session(f.tokens.a);
    const slip = (await readDelivery(person))[0];
    const download = await downloadPayslip(
      person,
      slip.reference,
      new Request(endpoint),
    );
    const reader = download.body!.getReader();
    await f.owner.query(
      "UPDATE users SET disabled_at=private.security_now() WHERE id=$1",
      [f.ids.a],
    );
    await assert.rejects(() => reader.read(), /authorization/);
  } finally {
    await f.cleanup();
  }
});
