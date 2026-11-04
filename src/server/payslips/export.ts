import "server-only";
import { crc32 } from "node:zlib";
import { z } from "zod";
import { csvCell } from "@/lib/work-time";
import { dateOnly } from "@/lib/time";
import { HttpError } from "../auth/security";
import type { Session } from "../auth/service";
import { scoped } from "../db";
import {
  attachment,
  chunkSize,
  deliveryError,
  manilaDate,
  payslipLocator,
  rejectPartialRequest,
  requirePayrollAdmin,
  streamPrivate,
  verifiedPayslip,
} from "./service";

const maxFiles = 100;
const maxArchiveBytes = 100 * 1024 * 1024;
const maxRows = 50_000;
type ArchiveRow = { reference: string | null; size: number | null };
const exportFilters = z.object({
  start: manilaDate,
  end: manilaDate,
  employee: z.uuid().optional(),
});
const columns = [
  "Period start",
  "Cutoff (exclusive)",
  "Scheduled payday",
  "Employee number",
  "Employee",
  "Revision",
  "Approval status",
  "Payment status",
  "Approval date (Manila)",
  "Payment date (Manila)",
  "Payment method",
  "Gross",
  "Deductions",
  "Net",
  "Currency",
];
const csvLine = (cells: unknown[]) => cells.map(csvCell).join(",") + "\r\n";

async function assertExportAccess(identity: Session) {
  const [row] = await scoped(
    identity.hash,
    (tx) =>
      tx.$queryRaw<
        { allowed: boolean }[]
      >`SELECT private.is_admin() AS allowed`,
  );
  if (!row.allowed)
    throw new HttpError(403, "Administrator export access ended");
}

// Stored ZIP with bounded 32-bit sizes and ASCII names generated from opaque references.
// Each entry has a local header and a central directory record with the same CRC.
function zipEntry(name: string, bytes: Buffer, offset: number) {
  const filename = Buffer.from(name, "ascii");
  const local = Buffer.alloc(30 + filename.length);
  const central = Buffer.alloc(46 + filename.length);
  const checksum = crc32(bytes);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(33, 12); // DOS date 1980-01-01
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(bytes.length, 18);
  local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(filename.length, 26);
  filename.copy(local, 30);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  local.copy(central, 8, 6, 28);
  central.writeUInt32LE(offset, 42);
  filename.copy(central, 46);
  return { local, central };
}

async function* zipChunks(identity: Session, references: string[]) {
  const directory: Buffer[] = [];
  let cursor = 0;
  for (const ref of references) {
    const file = await payslipLocator(identity, ref);
    const bytes = await verifiedPayslip(file);
    await assertExportAccess(identity);
    const entry = zipEntry(file.display_name, bytes, cursor);
    directory.push(entry.central);
    cursor += entry.local.length + bytes.length;
    yield entry.local;
    for (let offset = 0; offset < bytes.length; offset += chunkSize)
      yield bytes.subarray(offset, offset + chunkSize);
  }
  for (const entry of directory) yield entry;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(directory.length, 8);
  end.writeUInt16LE(directory.length, 10);
  end.writeUInt32LE(
    directory.reduce((size, entry) => size + entry.length, 0),
    12,
  );
  end.writeUInt32LE(cursor, 16);
  yield end;
}

async function* csvChunks(rows: unknown[][]) {
  yield Buffer.from(csvLine(columns));
  for (let offset = 0; offset < rows.length; offset += 64)
    yield Buffer.from(
      rows
        .slice(offset, offset + 64)
        .map(csvLine)
        .join(""),
    );
}

export async function exportPayroll(
  identity: Session,
  kind: "ZIP" | "CSV",
  request: Request,
) {
  requirePayrollAdmin(identity);
  rejectPartialRequest(request);
  const params = new URL(request.url).searchParams;
  const { start, end, employee } = exportFilters.parse({
    start: params.get("start"),
    end: params.get("end"),
    employee: params.get("employee") || undefined,
  });
  const dateSpan = dateOnly(end).getTime() - dateOnly(start).getTime();
  if (dateSpan < 0 || dateSpan > 30 * 86400000)
    throw new HttpError(400, "Choose an ordered date range of 1 to 31 days");
  let data: ArchiveRow[] | unknown[][];
  try {
    const [row] = await scoped(
      identity.hash,
      (tx) =>
        tx.$queryRaw<
          { data: ArchiveRow[] | unknown[][] }[]
        >`SELECT private.payroll_export(${kind},${start}::date,${end}::date,${employee ?? null}::uuid) AS data`,
    );
    data = row.data;
  } catch (error) {
    return deliveryError(error);
  }
  const authorize = () => assertExportAccess(identity);
  if (kind === "CSV") {
    if (data.length > maxRows)
      throw new HttpError(
        413,
        "Export exceeds 50,000 rows. Narrow the filters.",
      );
    return new Response(
      streamPrivate(request, csvChunks(data as unknown[][]), authorize),
      {
        headers: attachment("payroll.csv", "text/csv; charset=utf-8"),
      },
    );
  }
  const entries = data as ArchiveRow[];
  // Include ZIP headers and the directory in the byte limit. File names are
  // 'payslip-' + 32 hex characters + '.pdf' and cannot be supplied by clients.
  const archiveSize = entries.reduce(
    (size, row) => size + (row.size ?? 0) + 30 + 46 + 44 * 2,
    22,
  );
  if (entries.length > maxFiles || archiveSize > maxArchiveBytes)
    throw new HttpError(
      413,
      "Archive exceeds 100 PDFs or 100 MiB. Narrow the filters.",
    );
  const references: string[] = [];
  for (const row of entries) {
    if (!row.reference || !row.size)
      throw new HttpError(
        409,
        "A matching payslip has not been issued. Open the payroll line to retry.",
      );
    await authorize();
    await verifiedPayslip(await payslipLocator(identity, row.reference));
    references.push(row.reference);
  }
  return new Response(
    streamPrivate(request, zipChunks(identity, references), authorize),
    {
      headers: {
        ...attachment("payslips.zip", "application/zip"),
        "Content-Length": String(archiveSize),
      },
    },
  );
}
