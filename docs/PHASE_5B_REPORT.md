# Phase 5b delivery report

4 November 2026, Asia/Manila. **Checkpoint 5b passed. Awaiting owner acceptance.**

## Delivered

- The append-only payment ledger records one actual disbursement per approved line with the exact PHP net, Manila payment date, configured method, normalized reference, administrator, reason and operation receipt. Recent MFA and expected period and line versions are checked before recording. A guarded transaction inserts the payment, changes APPROVED to PAID and audits the change. A payment reference is unique per method across the ledger. Approval produces no payment and reviewed zero-net lines show **No disbursement due**.
- Approving a line starts synchronous issuance of its A4 payslip after financial commit. Payment publishes a second PDF version from the frozen line and recorded payment date. Each PDF has its own opaque reference, stored digest and private typed file. Approved bytes are preserved. If issuance fails, the payroll line retains its financial status and the administrator can retry the PDF from that line.
- Employees see their own finalized PDFs in **My payslips** and in the payroll line detail using ordinary account sign-in. An MFA administrator can record payment, inspect its details, retry issuance and export payroll. Downloads verify SHA-256 and length before serving. A revoked account session or account disablement stops further chunks.
- **Payslips and exports** provides a stored ZIP with preflight for every expected PDF and formula-safe payroll CSV with separate approval and payment status. The selected range can span up to 31 Manila dates by period start. ZIP limits are 100 PDFs and 100 MiB including metadata. CSV is capped at 50,000 rows. Requests over a limit fail with a narrower-filter instruction.
- A paid correction is flagged and posted as a reviewed manual adjustment in a later period. The correction keeps a link to the original line. The test with a real payment also exposed an ambiguous column reference in the existing adjustment command. The new migration resolves it while preserving the approved adjustment workflow.

Payment takes the existing shared policy and affected-user locks, validates and locks the session, and locks the period before the line. A payslip publication first locks its independent storage key for coordination with the orphan operator. Publication then revalidates the live administrator and locks the affected employee, period and line before adding the file and version. The orphan operator takes only the storage-key lock. The final schema has two new application tables, both with RLS.

## Verification results

| Check | Result |
| --- | --- |
| Full Windows regression, first pass | **153/153 unit and PostgreSQL tests and 70/70 real HTTP tests passed** |
| Full Windows regression, second consecutive pass | **153/153 unit and PostgreSQL tests and 70/70 real HTTP tests passed** |
| Test inventory per pass | **223 passed, 0 failed, 0 skipped**. All 212 baseline cases and 11 new cases |
| Clean migration replay | **56 migrations and exactly 43 RLS-enabled application tables**, exit 0 |
| TypeScript, Prisma generation and production webpack build | Passed |
| Dependency audit | `pnpm audit` reported no known vulnerabilities |

Both full runs used fresh PostgreSQL clusters, ports, keyrings and private roots. The two runs and the replay removed their three temporary checkouts and closed all seven recorded listeners. The HTTP coverage includes an actual DUTY session, restricted account access, concurrent payment and publication retries, the two ZIP limits, 50,001-row CSV overflow and revocation during a live export. The integration checks cover guarded writes, the later-period paid correction, immutable original bytes and orphan recovery.

The synthetic PDF inspection used a two-page A4 sample. Extracted text verifies Unicode names, exact PHP amounts, rate basis, days and hours, approval and payment dates, all required earnings and deduction fields, and the company-name fallback. Poppler renders were inspected for repeated headings, item alignment, totals and page numbers. [Acceptance coverage](TEST_COVERAGE.md)

## Run locally

With the dedicated local PostgreSQL running, use `pnpm install --frozen-lockfile`, `pnpm db:migrate`, `pnpm db:generate` and `pnpm dev`. Open **Payroll settings and readiness** to publish the effective PAY rules. Use **Account security** for recent MFA, then open an approved line to record an actual payment. Employees use **My payslips**. Configure an optional local logo and back up private bytes alongside the database. [README](../README.md)

## Known gaps

- The existing payroll line page can carry a React Flight 404 result in HTTP 200 after streaming headers are sent. Foreign and missing IDs get the same result in that transport. Full-page responses and the PDF and payroll APIs send HTTP 404 for both cases. This checkpoint retains the existing page behavior.
- The bundled font covers Latin and other supported scripts in Noto Sans. Names outside that repertoire need a compatible local font configured by the operator. The visual inspection covered a Latin-script Unicode fixture. Wider mobile device checks and a backup restore rehearsal remain release work.
- The first payslip version reflects its approval event. The app displays subsequent line state for historical versions after a void or replacement. A corrupt or missing published PDF requires restoring the matching backup bytes.

## Owner/accountant decisions

Publish payment methods, reference formats and date rules in PAY and confirm the no-disbursement treatment of zero-net lines. Confirm which reviewed corrections to paid lines may be posted in a later period and the procedure for approving them. Provide the approved local logo and confirm font coverage for employee names. Assign an operator to retain and restore the database and matching private files. [Payroll assumptions](ASSUMPTIONS.md)
