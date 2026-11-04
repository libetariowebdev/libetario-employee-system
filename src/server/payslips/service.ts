import "server-only";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { dateOnly } from "@/lib/time";
import { HttpError } from "../auth/security";
import type { Session } from "../auth/service";
import { databaseErrorCode, workError } from "../dal/work";
import { scoped } from "../db";
import { validationKey } from "../files/service";
import {
  createQuarantine,
  openPrivate,
  promote,
  removeRejectedBytes,
} from "../files/storage";
import { maxPdfBytes, renderPayslip, sha256, type FrozenPayslip } from "./pdf";

export type PayslipEvent = "APPROVAL" | "PAYMENT";
export type PayslipMeta = {
  reference: string;
  event: PayslipEvent;
  version: number;
  issuedAt: string;
  hasLogo: boolean;
};
export type PayslipListEntry = PayslipMeta & {
  lineId: string;
  startDate: string;
  endDate: string;
  employee: string;
  net: string;
  lineState: string;
};
export type PayrollDelivery = {
  state: string;
  version: number;
  periodVersion: number;
  net: string;
  today: string;
  cutoff: string;
  payday: string;
  paymentDate: string | null;
  payment: {
    date: string;
    method: string;
    reference: string;
    amount: string;
  } | null;
  frozenMethods: { code: string; reference: string; dateRule: string }[] | null;
  paymentPolicyReady: boolean;
  payslips: PayslipMeta[];
};
type Source =
  | { published: PayslipMeta }
  | {
      snapshot: FrozenPayslip;
      digest: string;
      paymentId: string | null;
      paymentDate: string | null;
    };

export function deliveryError(error: unknown): never {
  const code = databaseErrorCode(error);
  if (code === "42501")
    throw new HttpError(
      403,
      "Valid account access and administrator MFA are required for this action",
    );
  if (code === "P0422")
    throw new HttpError(
      422,
      "Configure the PAY policy in effect on the payment date before recording payment",
    );
  if (code === "23505")
    throw new HttpError(
      409,
      "The payment reference or operation key is already in use",
    );
  if (code === "22023")
    throw new HttpError(
      400,
      "Check the amount, configured method, reference format and Manila payment date",
    );
  return workError(error);
}

export function requirePayrollAdmin(identity: Session) {
  if (identity.role !== "ADMINISTRATOR" || identity.scope !== "ACCOUNT")
    throw new HttpError(403, "Administrator access required");
}

export const manilaDate = z.string().refine((value) => {
  try {
    dateOnly(value);
    return true;
  } catch {
    return false;
  }
}, "Enter a valid Manila date");

const paymentFields = z.strictObject({
  expectedVersion: z.number().int().positive(),
  expectedPeriodVersion: z.number().int().positive(),
  operationKey: z.uuid(),
  reason: z.string().trim().min(10).max(2000),
  date: manilaDate,
  method: z.string().regex(/^[A-Z][A-Z0-9_]{0,31}$/),
  reference: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/),
  amount: z.string().regex(/^\d{1,18}(\.\d{1,2})?$/),
});

export async function readDelivery(
  identity: Session,
  line: string,
): Promise<PayrollDelivery>;
export async function readDelivery(
  identity: Session,
  line?: undefined,
  offset?: number,
): Promise<PayslipListEntry[]>;
export async function readDelivery(
  identity: Session,
  line?: string,
  offset = 0,
) {
  const target = line ? z.uuid().parse(line) : null;
  const skip = z.number().int().min(0).max(50000).parse(offset);
  try {
    const [row] = await scoped(
      identity.hash,
      (tx) =>
        tx.$queryRaw<
          { data: PayrollDelivery | PayslipListEntry[] }[]
        >`SELECT private.payslip_read(${target}::uuid,${skip}::int) AS data`,
    );
    return row.data;
  } catch (error) {
    return deliveryError(error);
  }
}

export async function recordPayment(
  identity: Session,
  line: string,
  input: unknown,
) {
  requirePayrollAdmin(identity);
  const target = z.uuid().parse(line);
  const data = JSON.stringify(paymentFields.parse(input));
  try {
    const [result] = await scoped(
      identity.hash,
      (tx) =>
        tx.$queryRaw<
          { id: string }[]
        >`SELECT private.payroll_record_payment(${target}::uuid,${data}::jsonb) AS id`,
    );
    return result;
  } catch (error) {
    return deliveryError(error);
  }
}

async function pdfSource(identity: Session, line: string, event: PayslipEvent) {
  try {
    const [row] = await scoped(
      identity.hash,
      (tx) =>
        tx.$queryRaw<
          { data: Source }[]
        >`SELECT private.payslip_source(${line}::uuid,${event}) AS data`,
    );
    return row.data;
  } catch (error) {
    return deliveryError(error);
  }
}

export async function issuePayslip(
  identity: Session,
  line: string,
  event: PayslipEvent,
): Promise<PayslipMeta> {
  requirePayrollAdmin(identity);
  const target = z.uuid().parse(line);
  if (event === "PAYMENT") await issuePayslip(identity, target, "APPROVAL");
  const source = await pdfSource(identity, target, event);
  if ("published" in source) return source.published;
  const reference = randomBytes(16).toString("hex");
  const key = randomBytes(32).toString("hex");
  try {
    const rendered = await renderPayslip(
      source.snapshot,
      reference,
      source.paymentDate,
    );
    const proof = validationKey();
    return await scoped(identity.hash, async (tx) => {
      await tx.$queryRaw`SELECT private.payslip_storage_lock(${key},${proof})::text`;
      const file = await createQuarantine(key, "payslip");
      try {
        await file.writeFile(rendered.bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await promote(key, "payslip");
      const data = JSON.stringify({
        event,
        reference,
        key,
        size: rendered.bytes.length,
        sha256: sha256(rendered.bytes),
        digest: source.digest,
        paymentId: source.paymentId,
        templateDigest: rendered.templateDigest,
        hasLogo: rendered.hasLogo,
      });
      const [row] = await tx.$queryRaw<
        { data: { published: PayslipMeta; created: boolean } }[]
      >`SELECT private.payslip_publish(${target}::uuid,${data}::jsonb,${proof}) AS data`;
      if (!row.data.created) await removeRejectedBytes(key, "payslip");
      return row.data.published;
    });
  } catch (error) {
    if (databaseErrorCode(error) === "42501") return deliveryError(error);
    // The commit outcome can be uncertain. Only the offline owner-checked
    // operator removes old candidates left behind after a failed request.
    throw new HttpError(
      503,
      "Payslip could not be published. Check private storage and local fonts, then retry issuance",
    );
  }
}

export async function issueAfterCommit(
  identity: Session,
  lines: string[],
  event: PayslipEvent,
) {
  const failed: string[] = [];
  for (const line of lines) {
    try {
      await issuePayslip(identity, line, event);
    } catch {
      failed.push(line);
    }
  }
  return failed.length
    ? {
        failed,
        message:
          "Financial change saved. Some PDFs could not be issued. Open the affected payroll lines to retry.",
      }
    : { failed };
}

type Locator = {
  storage_key: string;
  display_name: string;
  size_bytes: bigint;
  sha256: string;
};
export async function payslipLocator(identity: Session, reference: string) {
  if (!/^[a-f0-9]{32}$/.test(reference)) throw new HttpError(404, "Not found");
  try {
    const [row] = await scoped(
      identity.hash,
      (tx) =>
        tx.$queryRaw<
          Locator[]
        >`SELECT * FROM private.payslip_locator(${reference})`,
    );
    return row;
  } catch (error) {
    return deliveryError(error);
  }
}

export async function verifiedPayslip(file: Locator) {
  try {
    const size = Number(file.size_bytes);
    if (!Number.isSafeInteger(size) || size < 1 || size > maxPdfBytes)
      throw new Error("Invalid size");
    const handle = await openPrivate(file.storage_key, "objects", "payslip");
    try {
      if ((await handle.stat()).size !== size) throw new Error("Size changed");
      const bytes = Buffer.alloc(size + 1);
      let read = 0;
      while (read <= size) {
        const part = await handle.read(bytes, read, bytes.length - read, read);
        if (!part.bytesRead) break;
        read += part.bytesRead;
      }
      const exact = bytes.subarray(0, size);
      if (read !== size || sha256(exact) !== file.sha256)
        throw new Error("Hash changed");
      return exact;
    } finally {
      await handle.close();
    }
  } catch {
    throw new HttpError(
      503,
      "Payslip bytes are missing or corrupt. Restore the matching private backup.",
    );
  }
}

export const chunkSize = 64 * 1024;
export function streamPrivate(
  request: Request,
  chunks: AsyncGenerator<Uint8Array>,
  authorize: () => Promise<unknown>,
) {
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          if (request.signal.aborted) throw new Error("Interrupted");
          await authorize();
          const part = await chunks.next();
          if (request.signal.aborted) throw new Error("Interrupted");
          if (part.done) controller.close();
          else controller.enqueue(part.value);
        } catch {
          await chunks.return(undefined).catch(() => undefined);
          controller.error(
            new Error("Private stream authorization or integrity changed"),
          );
        }
      },
      async cancel() {
        await chunks.return(undefined);
      },
    },
    { highWaterMark: 0 },
  );
}

export function attachment(name: string, type: string) {
  return {
    "Content-Type": type,
    "Content-Disposition": `attachment; filename="${name}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "none",
  };
}

export function rejectPartialRequest(request: Request) {
  if (request.method === "HEAD")
    throw new HttpError(405, "HEAD downloads are not supported");
  if (request.headers.has("range"))
    throw new HttpError(416, "Range downloads are not supported");
}

export async function downloadPayslip(
  identity: Session,
  reference: string,
  request: Request,
) {
  const file = await payslipLocator(identity, reference);
  rejectPartialRequest(request);
  const bytes = await verifiedPayslip(file);
  await payslipLocator(identity, reference);
  async function* chunks() {
    for (let offset = 0; offset < bytes.length; offset += chunkSize)
      yield bytes.subarray(offset, offset + chunkSize);
  }
  return new Response(
    streamPrivate(request, chunks(), () => payslipLocator(identity, reference)),
    {
      headers: {
        ...attachment(file.display_name, "application/pdf"),
        "Content-Length": String(bytes.length),
      },
    },
  );
}
