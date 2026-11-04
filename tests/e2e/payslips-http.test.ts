import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { crc32 } from "node:zlib";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { digest } from "../helpers";
import { addDays, payrollFixture, payReason } from "../payroll-helpers";
import { enrollDuty } from "../duty-helpers";
import { startDuty, completeDutyStage } from "../../src/server/auth/duty";
import { requireDuty } from "../../src/server/dal/duty";
import { otp } from "../../src/lib/mfa-crypto";
import { authPool, db } from "../../src/server/db";
import { storagePath } from "../../src/server/files/storage";

const origin = process.env.HTTP_TEST_ORIGIN ?? "http://127.0.0.1:3001";
if (!["127.0.0.1", "localhost"].includes(new URL(origin).hostname))
  throw new Error("Local HTTP tests only");
after(async () => {
  await db.$disconnect();
  await authPool.end();
});
const get = (url: string, token?: string, options: RequestInit = {}) =>
  fetch(origin + url, {
    ...options,
    redirect: "manual",
    headers: {
      ...(token ? { Cookie: "libetario_session=" + token } : {}),
      ...options.headers,
    },
  });

async function prepareHttp(
  f: Awaited<ReturnType<typeof payrollFixture>>,
  both = false,
) {
  for (const who of both ? (["a", "b"] as const) : (["a"] as const)) {
    await f.shift(
      who,
      f.start,
      f.start + "T00:00:00Z",
      f.start + "T02:00:00Z",
      "7200",
    );
  }
  const { id } = await f.prepare(both ? ["a", "b"] : ["a"]);
  const period = await f.period(id);
  const csrf = (await (await get("/api/session", f.tokens.admin)).json()).csrf;
  const post = (url: string, body: Record<string, unknown>) =>
    get("/api/payroll/" + url, f.tokens.admin, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ csrf, ...body }),
    });
  const approve = () =>
    post("periods/" + id + "/approve", {
      expectedVersion: period.version,
      manifest: period.reviewManifest,
      operationKey: randomUUID(),
    });
  return {
    id,
    approve,
    post,
    a: period.lines.find((line) => line.employeeId === f.ids.a)!,
  };
}

test("real HTTP approved payslip owner, guessing, scopes, HEAD, Range and conditional requests", async () => {
  const f = await payrollFixture();
  try {
    const { approve, a } = await prepareHttp(f, true);
    const approval = await approve();
    assert.equal(approval.status, 200);
    assert.deepEqual((await approval.json()).issuance.failed, []);
    const list = await (await get("/api/payroll/payslips", f.tokens.a)).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].lineId, a.id);
    const { reference } = list[0];
    const url = "/api/payroll/payslips/" + reference;
    const file = (
      await f.owner.query(
        "SELECT f.id,f.storage_key FROM file_objects f JOIN payslips s ON s.file_id=f.id WHERE s.reference=$1",
        [reference],
      )
    ).rows[0];
    const own = await get(url, f.tokens.a, {
      headers: {
        "If-None-Match": "*",
        "If-Modified-Since": "Wed, 21 Oct 2099 07:28:00 GMT",
      },
    });
    assert.equal(own.status, 200);
    assert.equal(own.headers.get("content-type"), "application/pdf");
    assert.equal(own.headers.get("cache-control"), "private, no-store");
    assert.equal(own.headers.get("x-content-type-options"), "nosniff");
    assert.match(own.headers.get("content-disposition") ?? "", /^attachment;/);
    assert.equal(
      Buffer.from(await own.arrayBuffer())
        .subarray(0, 5)
        .toString(),
      "%PDF-",
    );
    for (const [method, extra, status] of [
      ["HEAD", {}, 405],
      ["GET", { Range: "bytes=0-20" }, 416],
    ] as const) {
      const denied = await get(url, f.tokens.a, {
        method,
        headers: extra as Record<string, string>,
      });
      assert.equal(denied.status, status);
      assert.match(denied.headers.get("cache-control") ?? "", /no-store/);
      assert.equal(
        (
          await get(url, f.tokens.b, {
            method,
            headers: extra as Record<string, string>,
          })
        ).status,
        404,
      );
    }
    const peer = await get(url, f.tokens.b);
    assert.equal(peer.status, 404);
    const expected = await peer.text();
    for (const guess of [
      randomBytes(16).toString("hex"),
      file.id,
      file.storage_key,
      "%2e%2e%5cprivate",
    ]) {
      const response = await get("/api/payroll/payslips/" + guess, f.tokens.a);
      assert.equal(response.status, 404);
      assert.equal(await response.text(), expected);
    }
    assert.equal((await get(url)).status, 401);
    assert.equal(
      (await get("/api/work/files/" + file.id, f.tokens.admin)).status,
      404,
    );
    const adminDownload = await get(url, f.tokens.admin);
    assert.equal(adminDownload.status, 200);
    await adminDownload.arrayBuffer();
    const page = await get("/me/payslips", f.tokens.a);
    assert.equal(page.status, 200);
    assert.match((await page.text()).replaceAll("<!-- -->", ""), /Download approved PDF/);
    const setup = randomBytes(32).toString("hex");
    await f.owner.query(
      "INSERT INTO sessions(user_id,token_hash,csrf_token_hash,scope,setup_purpose,authorization_version,idle_expires_at,absolute_expires_at) VALUES($1,$2,$2,'SETUP','MFA_ENROLL',1,private.security_now()+interval '5 minutes',private.security_now()+interval '5 minutes')",
      [f.ids.a, digest(setup)],
    );
    assert.equal((await get(url, setup)).status, 403);

    const now = new Date(f.end + "T02:00:00Z");
    await f.grant("a", f.end);
    const enrolled = await enrollDuty(f, now);
    const later = new Date(now.getTime() + 30_000);
    await f.at(later.toISOString());
    const network = digest(randomUUID());
    const challenge = await startDuty(
      enrolled.token,
      f.end,
      f.password,
      false,
      network,
    );
    const duty = await completeDutyStage(
      enrolled.token,
      challenge.challenge,
      "TOTP",
      otp(enrolled.secret, later.getTime()),
      network,
    );
    if (duty.kind !== "SESSION") throw new Error("Expected real duty session");
    await requireDuty(duty.token, false);
    assert.equal(
      (
        await get(url, undefined, {
          headers: { Cookie: "libetario_duty=" + duty.token },
        })
      ).status,
      401,
    );
    assert.equal((await get(url, duty.token)).status, 401);
  } finally {
    await f.cleanup();
  }
});

test("real HTTP payment is recorded once and payroll exports enforce integrity, scope and bounds", async () => {
  const f = await payrollFixture();
  try {
    await f.owner.query(
      "UPDATE employee_profiles SET legal_name=$2 WHERE user_id=$1",
      [f.ids.a, "=Employee payroll fixture"],
    );
    const { id, a, approve, post } = await prepareHttp(f);
    // Leave the approved line without an issued PDF to exercise upgrade/retry and archive preflight.
    await f.approve(id);
    const query =
      "?start=" + f.start + "&end=" + f.start + "&employee=" + f.ids.a;
    const zipPath = "/api/payroll/export/zip" + query;
    const csvPath = "/api/payroll/export/csv" + query;
    assert.equal((await get(zipPath, f.tokens.admin)).status, 409);
    assert.equal((await get(csvPath, f.tokens.a)).status, 403);
    assert.equal(
      (
        await get(
          "/api/payroll/export/csv?start=" +
            f.start +
            "&end=" +
            addDays(f.start, 31),
          f.tokens.admin,
        )
      ).status,
      400,
    );
    const approved = await (await get(csvPath, f.tokens.admin)).text();
    assert.match(approved, /"APPROVED","UNPAID"/);
    assert.match(approved, /"'=Employee payroll fixture"/);
    const p = await f.period(id);
    const l = await f.line(a.id);
    const date = addDays(f.end, 2);
    await f.at(date + "T02:00:00Z");
    const fields = {
      amount: l.net,
      date,
      method: "TEST_BANK",
      reference: Date.now().toString(),
      reason: payReason,
      expectedVersion: l.version,
      expectedPeriodVersion: p.version,
      operationKey: randomUUID(),
    };
    const payment = "lines/" + l.id + "/payment";
    assert.equal(
      (await post(payment, { ...fields, csrf: "invalid" })).status,
      403,
    );
    assert.equal(
      (await post(payment, { ...fields, amount: "1.00" })).status,
      400,
    );
    const attempts = await Promise.all([
      post(payment, fields),
      post(payment, fields),
    ]);
    for (const response of attempts) assert.equal(response.status, 200);
    const first = await attempts[0].json();
    const replay = await attempts[1].json();
    assert.equal(first.id, replay.id);
    assert.deepEqual(first.issuance.failed, []);
    assert.deepEqual(replay.issuance.failed, []);
    const final = await f.line(a.id);
    assert.equal(final.state, "PAID");
    assert.equal(final.snapshotDigest, l.snapshotDigest);
    assert.match(
      await (await get(csvPath, f.tokens.admin)).text(),
      /"APPROVED","PAID"/,
    );

    const zip = await get(zipPath, f.tokens.admin);
    assert.equal(zip.status, 200);
    const bytes = Buffer.from(await zip.arrayBuffer());
    let offset = 0;
    for (let i = 0; i < 2; i++) {
      assert.equal(bytes.readUInt32LE(offset), 0x04034b50);
      const start = offset + 30 + bytes.readUInt16LE(offset + 26);
      const pdf = bytes.subarray(
        start,
        start + bytes.readUInt32LE(offset + 18),
      );
      assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
      assert.equal(bytes.readUInt32LE(offset + 14), crc32(pdf));
      offset = start + pdf.length;
    }
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const archived = (
      await f.owner.query(
        "SELECT f.storage_key FROM file_objects f JOIN payslips s ON s.file_id=f.id WHERE s.line_id=$1 ORDER BY version",
        [a.id],
      )
    ).rows;
    const file = await storagePath(
      archived[0].storage_key,
      "objects",
      "payslip",
    );
    const original = await readFile(file);
    try {
      const corrupt = Buffer.from(original);
      corrupt[10] ^= 1;
      await chmod(file, 0o600);
      await writeFile(file, corrupt);
      assert.equal((await get(zipPath, f.tokens.admin)).status, 503);
    } finally {
      await writeFile(file, original);
      await chmod(file, 0o400);
    }
    assert.equal(
      (await get("/admin/payroll/payslips", f.tokens.admin)).status,
      200,
    );
    assert.equal((await approve()).status, 409);
  } finally {
    await f.cleanup();
  }
});

test("real HTTP export rejects byte, file-count and row overflow and aborts an active CSV on revocation", async () => {
  const f = await payrollFixture();
  try {
    const { id, a } = await prepareHttp(f);
    await f.approve(id);
    const append = (from: number, through: number) =>
      f.owner.query(
        `
      WITH source AS (SELECT * FROM payroll_lines WHERE id=$1),
      previous AS (SELECT id FROM payroll_lines WHERE period_id=(SELECT period_id FROM source) ORDER BY revision DESC LIMIT 1),
      candidates AS MATERIALIZED (SELECT n,gen_random_uuid() id FROM generate_series($2::int,$3::int) n),
      linked AS (SELECT n,id,lag(id,1,(SELECT id FROM previous)) OVER(ORDER BY n) predecessor FROM candidates)
      INSERT INTO payroll_lines(id,period_id,employee_id,revision,predecessor_id,state,gross,deductions,net,snapshot,snapshot_digest,
       created_by,approved_by,approved_at)
      SELECT c.id,l.period_id,l.employee_id,c.n,c.predecessor,'VOIDED',l.gross,l.deductions,l.net,
        jsonb_build_object('employee',l.snapshot->'employee'),l.snapshot_digest,
        l.created_by,l.approved_by,l.approved_at FROM linked c CROSS JOIN source l`,
        [a.id, from, through],
      );
    await append(2, 11);
    // Synthetic metadata exercises preflight before accessing any oversized archive bytes.
    await f.owner.query(
      `
      WITH metadata AS MATERIALIZED (
        SELECT id line_id,snapshot_digest,gen_random_uuid() file_id,replace(gen_random_uuid()::text,'-','') ref,
          replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','') storage
        FROM payroll_lines WHERE period_id=$1 AND revision BETWEEN 2 AND 11),
      bytes AS (
        INSERT INTO file_objects(id,storage_key,display_name,declared_media_type,detected_media_type,reserved_bytes,size_bytes,sha256,
          purpose,uploaded_by,upload_session_id,state,validation_policy_id,upload_completed_at,validated_at,validation_outcome)
        SELECT file_id,storage,'payslip-'||ref||'.pdf','application/pdf','application/pdf',10485760,10485760,repeat('0',64),
          'PAYSLIP',$2,$3,'AVAILABLE',pay_policy_id,private.security_now(),private.security_now(),'VALIDATED'
        FROM metadata CROSS JOIN company_settings RETURNING id)
      INSERT INTO payslips(line_id,version,reference,file_id,event,issued_by,line_digest,template_digest,has_logo)
      SELECT line_id,1,ref,id,'APPROVAL',$2,snapshot_digest,repeat('0',64),false FROM bytes JOIN metadata ON file_id=id`,
      [id, f.ids.admin, f.admin.session_id],
    );
    const query =
      "?start=" + f.start + "&end=" + f.start + "&employee=" + f.ids.a;
    const zip = "/api/payroll/export/zip" + query;
    const csv = "/api/payroll/export/csv" + query;
    assert.equal((await get(zip, f.tokens.admin)).status, 413);
    await append(12, 50_000);
    assert.equal((await get(zip, f.tokens.admin)).status, 413);
    const running = await get(csv, f.tokens.admin);
    assert.equal(running.status, 200);
    const reader = running.body!.getReader();
    assert.equal((await reader.read()).done, false);
    await f.owner.query(
      "UPDATE sessions SET revoked_at=private.security_now(),revocation_reason='LOGOUT' WHERE token_hash=$1",
      [digest(f.tokens.admin)],
    );
    await assert.rejects(async () => {
      while (!(await reader.read()).done) {
        /* drain through the stream authorization error */
      }
    });
    await f.owner.query(
      "UPDATE sessions SET revoked_at=NULL,revocation_reason=NULL WHERE token_hash=$1",
      [digest(f.tokens.admin)],
    );
    await append(50_001, 50_001);
    assert.equal((await get(csv, f.tokens.admin)).status, 413);
  } finally {
    await f.cleanup();
  }
});

test("real HTTP publication failure preserves approval and payment and supports guarded retry", async () => {
  const f = await payrollFixture();
  const config = (
    await f.owner.query(
      "SELECT upload_validation_key_hash AS hash FROM company_settings WHERE id=1",
    )
  ).rows[0];
  try {
    const { id, a, approve, post } = await prepareHttp(f);
    await f.owner.query(
      "UPDATE company_settings SET upload_validation_key_hash=repeat('0',64) WHERE id=1",
    );
    const approval = await approve();
    assert.equal(approval.status, 200);
    assert.deepEqual((await approval.json()).issuance.failed, [a.id]);
    const approved = await f.line(a.id);
    assert.equal(approved.state, "APPROVED");
    const p = await f.period(id);
    const date = addDays(f.end, 2);
    await f.at(date + "T02:00:00Z");
    const payment = "lines/" + a.id + "/payment";
    const input = {
      amount: approved.net,
      date,
      method: "TEST_BANK",
      reference: Date.now().toString(),
      reason: payReason,
      expectedVersion: approved.version,
      expectedPeriodVersion: p.version,
      operationKey: randomUUID(),
    };
    const result = await post(payment, input);
    assert.equal(result.status, 200);
    const saved = await result.json();
    assert.deepEqual(saved.issuance.failed, [a.id]);
    assert.equal((await f.line(a.id)).state, "PAID");
    await f.owner.query(
      "UPDATE company_settings SET upload_validation_key_hash=$1 WHERE id=1",
      [config.hash],
    );
    const retry = await post("lines/" + a.id + "/payslip", {
      event: "PAYMENT",
    });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).version, 2);
    const replay = await post(payment, input);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).id, saved.id);
    const files = await (await get("/api/payroll/payslips", f.tokens.a)).json();
    assert.deepEqual(
      files.map((row: { version: number }) => row.version).sort(),
      [1, 2],
    );
  } finally {
    await f.owner.query(
      "UPDATE company_settings SET upload_validation_key_hash=$1 WHERE id=1",
      [config.hash],
    );
    await f.cleanup();
  }
});
