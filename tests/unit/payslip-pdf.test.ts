import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  renderPayslip,
  type FrozenPayslip,
} from "../../src/server/payslips/pdf";

test("A4 payslip retains Unicode, exact PHP strings, frozen dates and repeated item headings", async () => {
  const fixture: FrozenPayslip = {
    company: "Libetario Digital Marketing Services",
    employee: {
      name: "Zoë Muñoz Dela Cruz",
      number: "FAKE-45",
      position: "Content editor",
    },
    startDate: "2037-12-26",
    endDate: "2038-01-02",
    payday: "2038-01-04",
    approvedAt: "2038-01-01T18:00:00Z",
    gross: "9007199254740993.44",
    deductions: "2.22",
    net: "9007199254740991.22",
    items: [
      {
        description: "Basic hours",
        date: "2037-12-26",
        kind: "EARNING",
        amount: "150.00",
        detail: {
          basis: "HOURLY",
          rate: "75.00",
          payableSeconds: "7200.125000",
        },
      },
      {
        description: "Basic days",
        date: "2037-12-27",
        kind: "EARNING",
        amount: "500.00",
        detail: {
          basis: "DAILY",
          rate: "500.00",
          payableSeconds: "28800.000000",
          dayNumerator: "1",
          dayDenominator: "1",
        },
      },
      {
        description: "Reviewed night work",
        date: "2037-12-28",
        kind: "EARNING",
        amount: "35.45",
        detail: { category: "PREMIUM" },
      },
      {
        description: "Transport",
        date: "2037-12-28",
        kind: "EARNING",
        amount: "22.30",
        detail: { category: "ALLOWANCE" },
      },
      {
        description: "Project milestone",
        date: "2037-12-28",
        kind: "EARNING",
        amount: "20.05",
        detail: { category: "BONUS" },
      },
      {
        description: "Fixture deduction",
        date: "2037-12-29",
        kind: "DEDUCTION",
        amount: "2.22",
        detail: {},
      },
      ...Array.from({ length: 73 }, (_, i) => ({
        description: "Extra reviewed item " + i,
        date: "2037-12-30",
        kind: "EARNING" as const,
        amount: "10.01",
        detail: { category: "BONUS" },
      })),
    ],
  };
  const ref = "2f".repeat(16);
  const { bytes, hasLogo } = await renderPayslip(fixture, ref, "2038-01-04");
  assert.equal(hasLogo, false);
  const dimensions = await PDFDocument.load(bytes);
  assert.ok(dimensions.getPageCount() >= 3);
  for (const page of dimensions.getPages()) {
    assert.equal(page.getWidth(), 595.28);
    assert.equal(page.getHeight(), 841.89);
  }
  const task = getDocument({ data: bytes.slice(), useSystemFonts: false });
  const doc = await task.promise;
  try {
    const pages: string[] = [];
    for (let number = 1; number <= doc.numPages; number++) {
      const content = await (await doc.getPage(number)).getTextContent();
      pages.push(
        content.items.map((item) => ("str" in item ? item.str : "")).join(" "),
      );
    }
    for (const page of pages) {
      assert.ok(page.includes(fixture.company));
      assert.ok(page.includes(ref));
    }
    assert.ok(
      pages.filter((page) =>
        page.includes("Pay item and applicable rate basis"),
      ).length >= 3,
    );
    const text = pages.join(" ");
    for (const value of [
      "Zoë Muñoz Dela Cruz",
      "FAKE-45",
      "Content editor",
      "2037-12-26 to 2038-01-01",
      "2038-01-02",
      "Daily rate PHP 500.00",
      "Hourly rate PHP 75.00",
      "payable days 1",
      "2:00:00.125",
      "Basic pay",
      "Manual premium",
      "Allowance",
      "Bonus",
      "Fixture deduction",
      "Gross earnings",
      "Total deductions",
      "Net pay",
      "PHP 9007199254740993.44",
      "PHP 2.22",
      "PHP 9007199254740991.22",
      "Payment status",
      "Paid / 2038-01-04",
    ])
      assert.ok(text.includes(value), value);
  } finally {
    await task.destroy();
  }
});
