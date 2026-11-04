import "server-only";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import {
  PDFDocument,
  PageSizes,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import sharp from "sharp";
import { duration } from "@/lib/attendance";
import { businessDate, dateOnly } from "@/lib/time";

export const maxPdfBytes = 10 * 1024 * 1024;
const version = "libetario-payslip-a4-v1";
const fontPath = path.join(
  process.cwd(),
  "src",
  "server",
  "payslips",
  "assets",
  "NotoSans-Regular.ttf",
);
const ink = rgb(0.1, 0.16, 0.25);
const muted = rgb(0.31, 0.39, 0.48);
const accent = rgb(0.08, 0.29, 0.41);

export type FrozenPayslip = {
  company: string;
  employee: { number: string; name: string; position: string };
  startDate: string;
  endDate: string;
  payday: string;
  approvedAt: string;
  gross: string;
  deductions: string;
  net: string;
  items: {
    description: string;
    date: string;
    kind: "EARNING" | "DEDUCTION";
    amount: string;
    detail: {
      category?: string;
      basis?: string;
      rate?: string;
      payableSeconds?: string;
      dayNumerator?: string | null;
      dayDenominator?: string | null;
    };
  }[];
};

export function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readLocal(file: string, limit: number) {
  if (
    !path.isAbsolute(file) ||
    file.startsWith("\\\\") ||
    file.startsWith("//")
  )
    throw new Error("Branding file must be on a local absolute path");
  const full = path.resolve(file);
  const canonical = await realpath(full);
  if (canonical.toLowerCase() !== full.toLowerCase())
    throw new Error("Linked branding paths are prohibited");
  const stat = await lstat(full);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 1 ||
    stat.size > limit
  )
    throw new Error("Unsafe branding file");
  const handle = await open(full, "r");
  try {
    const current = await handle.stat();
    if (
      current.ino !== stat.ino ||
      current.dev !== stat.dev ||
      current.size !== stat.size
    )
      throw new Error("Branding file changed");
    const bytes = Buffer.alloc(stat.size);
    const result = await handle.read({ buffer: bytes, position: 0 });
    if (result.bytesRead !== bytes.length)
      throw new Error("Incomplete branding file");
    return bytes;
  } finally {
    await handle.close();
  }
}

async function localLogo() {
  const logoPath = process.env.PAYSLIP_LOGO_PATH;
  if (!logoPath) return null;
  try {
    const bytes = await readLocal(logoPath, 1024 * 1024);
    const image = sharp(bytes, {
      limitInputPixels: 2_000_000,
      failOn: "warning",
    });
    const meta = await image.metadata();
    if (!["png", "jpeg"].includes(meta.format ?? "") || (meta.pages ?? 1) !== 1)
      return null;
    return await image
      .resize({
        width: 240,
        height: 96,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();
  } catch {
    return null;
  }
}

function cents(value: string) {
  const [whole, fraction] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction ?? "0");
}

function money(value: string) {
  return "PHP " + value;
}

function decimal(centsValue: bigint) {
  return (
    (centsValue / 100n).toString() +
    "." +
    (centsValue % 100n).toString().padStart(2, "0")
  );
}

const categories: Record<string, string> = {
  PREMIUM: "Manual premium",
  ALLOWANCE: "Allowance",
  BONUS: "Bonus",
  ADJUSTMENT: "Reviewed adjustment",
};

export async function renderPayslip(
  frozen: FrozenPayslip,
  reference: string,
  paymentDate: string | null,
) {
  const logo = await localLogo();
  const bytes = await readLocal(fontPath, 1024 * 1024);
  const extraPath = process.env.PAYSLIP_EXTRA_FONT_PATH;
  const extra = extraPath ? await readLocal(extraPath, 24 * 1024 * 1024) : null;
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const base = await pdf.embedFont(bytes, { subset: true });
  const alternate = extra ? await pdf.embedFont(extra, { subset: true }) : null;
  const supported = new Map<PDFFont, Set<number>>([
    [base, new Set(base.getCharacterSet())],
  ]);
  if (alternate) supported.set(alternate, new Set(alternate.getCharacterSet()));
  const logoImage = logo ? await pdf.embedPng(logo) : null;
  const [width, height] = PageSizes.A4;
  const margin = 44;
  const right = width - margin;
  let page: PDFPage;
  let y = 0;

  const clean = (value: string) =>
    value
      .normalize("NFC")
      .replace(/[\s\p{Cc}]+/gu, " ")
      .trim();
  function fontFor(value: string) {
    const glyphs = Array.from(value, (char) => char.codePointAt(0)!);
    for (const [font, charset] of supported)
      if (glyphs.every((point) => charset.has(point))) return font;
    throw new Error(
      "A payslip name or label needs a configured local font covering its script",
    );
  }
  function draw(
    value: string,
    x: number,
    at: number,
    size: number,
    color = ink,
  ) {
    if (!value) return;
    page.drawText(value, { x, y: at, size, font: fontFor(value), color });
  }
  function wrap(value: string, size: number, available: number) {
    const text = clean(value);
    if (!text) return [""];
    const font = fontFor(text);
    const lines: string[] = [];
    let current = "";
    for (const word of text.split(" ")) {
      const candidate = current ? current + " " + word : word;
      if (font.widthOfTextAtSize(candidate, size) <= available) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);
      current = "";
      for (const char of word) {
        if (
          current &&
          font.widthOfTextAtSize(current + char, size) > available
        ) {
          lines.push(current);
          current = "";
        }
        current += char;
      }
    }
    if (current) lines.push(current);
    return lines;
  }
  function rule(at: number) {
    page.drawLine({
      start: { x: margin, y: at },
      end: { x: right, y: at },
      color: rgb(0.83, 0.87, 0.9),
      thickness: 0.7,
    });
  }
  function newPage() {
    page = pdf.addPage(PageSizes.A4);
    y = height - margin;
    if (logoImage) {
      const dim = logoImage.scaleToFit(108, 36);
      page.drawImage(logoImage, {
        ...dim,
        x: right - dim.width,
        y: y - dim.height,
      });
    }
    for (const line of wrap(
      frozen.company,
      14,
      right - margin - (logoImage ? 120 : 0),
    )) {
      draw(line, margin, y, 14, accent);
      y -= 18;
    }
    draw("Weekly payslip", margin, y - 11, 22);
    y -= 36;
    draw("Reference " + reference, margin, y, 9, muted);
    y -= 15;
    const lastDay = dateOnly(frozen.endDate);
    lastDay.setUTCDate(lastDay.getUTCDate() - 1);
    draw(
      `Pay period ${frozen.startDate} to ${lastDay.toISOString().slice(0, 10)} (Manila)`,
      margin,
      y,
      10,
      muted,
    );
    rule(y - 9);
    y -= 27;
  }
  function paragraph(label: string, value: string) {
    draw(label, margin, y, 9, muted);
    for (const line of wrap(value, 10, right - margin)) {
      y -= 15;
      draw(line, margin, y, 10);
    }
    y -= 18;
  }
  function itemHeader() {
    draw("Pay item and applicable rate basis", margin, y, 10, accent);
    draw("Amount (PHP)", right - 75, y, 10, accent);
    rule(y - 7);
    y -= 22;
  }

  newPage();
  paragraph("Employee name", frozen.employee.name);
  paragraph(
    "Employee ID / Position",
    frozen.employee.number + " / " + frozen.employee.position,
  );
  paragraph(
    "Approval date (Manila)",
    businessDate(new Date(frozen.approvedAt)),
  );
  const status = paymentDate
    ? "Paid"
    : frozen.net === "0.00"
      ? "Approved - no disbursement due"
      : "Approved - unpaid";
  paragraph(
    "Payment status / Payment date (Manila)",
    status + " / " + (paymentDate ?? "Pending or not applicable"),
  );
  itemHeader();
  let basic = 0n;
  for (const item of frozen.items) {
    const { detail } = item;
    const label =
      item.kind === "DEDUCTION"
        ? "Deduction"
        : detail.basis
          ? "Basic pay"
          : (categories[detail.category ?? ""] ?? "Earning");
    if (label === "Basic pay") basic += cents(item.amount);
    const units =
      detail.dayNumerator && detail.dayDenominator
        ? ` / payable days ${detail.dayNumerator}${detail.dayDenominator === "1" ? "" : "/" + detail.dayDenominator}`
        : "";
    const description = wrap(
      `${item.date}  ${label} - ${item.description}`,
      10,
      right - margin - 135,
    );
    const detailLines = detail.basis
      ? wrap(
          `${detail.basis === "DAILY" ? "Daily rate" : "Hourly rate"} ${money(detail.rate ?? "0.00")} / payable hours ${duration(detail.payableSeconds ?? "0")}${units}`,
          9,
          right - margin - 135,
        )
      : [];
    const rowHeight = 14 * (description.length + detailLines.length) + 8;
    if (y - rowHeight < 56) {
      newPage();
      itemHeader();
    }
    const amount = money(item.amount);
    draw(amount, right - base.widthOfTextAtSize(amount, 10), y, 10);
    for (const line of description) {
      draw(line, margin, y, 10);
      y -= 14;
    }
    for (const line of detailLines) {
      draw(line, margin, y, 9, muted);
      y -= 14;
    }
    y -= 8;
  }
  if (y < 151) newPage();
  rule(y + 3);
  y -= 15;
  for (const [label, value] of [
    ["Basic pay", decimal(basic)],
    ["Gross earnings", frozen.gross],
    ["Total deductions", frozen.deductions],
    ["Net pay", frozen.net],
  ]) {
    draw(label, margin, y, 12, accent);
    const amount = money(value);
    draw(amount, right - base.widthOfTextAtSize(amount, 12), y, 12);
    y -= 19;
  }
  pdf.getPages().forEach((p, index, pages) => {
    page = p;
    draw(
      `Private payroll record  |  Page ${index + 1} of ${pages.length}`,
      margin,
      30,
      8,
      muted,
    );
  });
  pdf.setTitle("Weekly payslip " + reference);
  pdf.setCreator("Libetario Workforce");
  const output = await pdf.save();
  if (output.length > maxPdfBytes)
    throw new Error("Payslip exceeds the private file size limit");
  return {
    bytes: output,
    hasLogo: !!logo,
    templateDigest: sha256(
      [
        version,
        sha256(bytes),
        extra && sha256(extra),
        logo && sha256(logo),
      ].join(":"),
    ),
  };
}
