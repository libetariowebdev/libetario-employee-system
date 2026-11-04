import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { payrollIssues, payrollLabels, payrollOptions } from "@/lib/payroll";
import { businessDate, weeklyCutoff } from "@/lib/time";
import { duration as formatDuration } from "@/lib/attendance";
import { pageSession } from "@/server/page-session";
import { HttpError } from "@/server/auth/security";
import { payrollIdentity, readPayroll } from "@/server/services/payroll";
import { PayrollForm, type PayrollField } from "./payroll-form";

type Catalog = {
  id: string;
  code: string;
  category: string;
  label: string;
  effective_date: string;
  enabled: boolean;
  revision: number;
  employee_id?: string;
  designation?: string;
  rule: { mode: string; amount?: string };
};
type Settings = {
  id: string;
  revision: number;
  effectiveDate: string | null;
  weekdayLocked: boolean;
  regularConfigured: boolean;
  configuration: Record<
    string,
    string | number | { code: string; reference: string; dateRule: string }[]
  >;
  missing: string[];
  earnings: Catalog[];
  deductions: Catalog[];
};
type Person = { id: string; name: string; number: string; status: string };
type Issue = {
  code: string;
  date?: string;
  missing?: string[];
  label?: string;
  shiftId?: string;
  shiftVersion?: number;
  flags?: string[];
  approvedSeconds?: string;
  slices?: { date: string; gross: string; suggested: string }[];
};
type Period = {
  id: string;
  start_date: string;
  end_date: string;
  payday: string;
  state: string;
  version: number;
  reviewManifest?: string;
  cutoffPassed: boolean;
  lines: Line[];
};
type Item = {
  id: string;
  sequence: number;
  date: string;
  description: string;
  kind: string;
  amount: string;
  detail: {
    basis?: string;
    rate?: string;
    approvedSeconds?: string;
    payableSeconds?: string;
    dayNumerator?: string;
    dayDenominator?: string;
  };
  attendance?: {
    shiftId: string;
    dutyDate: string;
    seconds: string;
    version: number;
  }[];
};
type Line = {
  id: string;
  periodId: string;
  employeeId: string;
  employee: string | { name: string; number: string; position: string };
  revision: number;
  predecessorId?: string;
  version: number;
  state: string;
  startDate: string;
  endDate: string;
  payday: string;
  approvedAt?: string;
  gross: string;
  deductions: string;
  net: string;
  issues: Issue[];
  items: Item[];
  periodState: string;
  sourceChanged: boolean;
  snapshotDigest?: string;
  workHolidays: string[];
  adjustments: {
    id: string;
    kind: string;
    reason: string;
    evidence: string;
    before_values: unknown;
    after_values: { kind?: string; manualId?: string };
  }[];
  laterPeriodCorrections: { id: string; lineId: string; reason: string }[];
};

function options(values: readonly string[]) {
  return values.map((value) => ({
    value,
    label: value.toLowerCase().replaceAll("_", " "),
  }));
}
const reviewFields: PayrollField[] = [
  {
    name: "reason",
    label: "Reason (10–2,000 characters)",
    type: "textarea",
    required: true,
  },
  {
    name: "evidence",
    label: "Supporting evidence note",
    type: "textarea",
    required: true,
  },
];
const catalogFields: PayrollField[] = [
  { name: "code", label: "Stable catalog code", required: true },
  { name: "label", label: "Display name", required: true },
  {
    name: "effectiveDate",
    label: "Effective Manila date",
    type: "date",
    required: true,
  },
  { name: "enabled", label: "Enable this revision", type: "checkbox" },
  {
    name: "reason",
    label: "Reason (10–2,000 characters)",
    type: "textarea",
    required: true,
  },
];
function Panel({ children }: { children: React.ReactNode }) {
  return <section className="card space-y-3">{children}</section>;
}
function Head({ children }: { children: React.ReactNode }) {
  return (
    <div className="page-heading">
      <div>
        <p className="eyebrow">WEEKLY PAYROLL · ASIA/MANILA</p>
        <h1>{children}</h1>
      </div>
    </div>
  );
}
async function account(admin = false) {
  const s = await pageSession(admin);
  try {
    const duty = (await cookies()).get("libetario_duty")?.value;
    return duty ? await payrollIdentity(s.token, duty) : s;
  } catch (error) {
    if (error instanceof HttpError) redirect("/login");
    throw error;
  }
}
async function record<T>(query: Promise<T>) {
  try {
    return await query;
  } catch (error) {
    if (
      error instanceof z.ZodError ||
      (error instanceof HttpError && error.status === 404)
    )
      notFound();
    throw error;
  }
}
function pagination(value?: string) {
  return value && /^\d{1,5}$/.test(value) ? Math.min(Number(value), 50000) : 0;
}
const label = (key: string) => payrollLabels[key] ?? key;
const amount = (value: string) => "PHP " + value;
function Totals({ line }: { line: Line }) {
  return (
    <p>
      <strong>
        Gross {amount(line.gross)} · Deductions {amount(line.deductions)} · Net{" "}
        {amount(line.net)}
      </strong>
    </p>
  );
}

export async function PayrollSettingsPage() {
  const s = await account(true);
  const data = await readPayroll<Settings>(s, "settings");
  const cfg = data.configuration;
  const fields: PayrollField[] = [
    {
      name: "effectiveDate",
      label: "New revision effective Manila date",
      type: "date",
      required: true,
    },
    {
      name: "weekday",
      label: label("weekday"),
      type: "select",
      value: String(cfg.weekday ?? ""),
      disabled: data.weekdayLocked,
      options: [
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
      ].map((label, index) => ({ label, value: String(index + 1) })),
    },
    ...Object.entries(payrollOptions).map(([name, values]): PayrollField => ({
      name,
      label: label(name),
      type: "select",
      value: String(cfg[name] ?? ""),
      options: options(values),
    })),
    ...[
      "paydayOffset",
      "minimumDaySeconds",
      "timeUnitSeconds",
      "moneyUnitCentavos",
    ].map((name): PayrollField => ({
      name,
      label: label(name),
      type: "number",
      value: String(cfg[name] ?? ""),
    })),
    {
      name: "minimumPay",
      label: label("minimumPay") + " (PHP amount or NONE)",
      value: String(cfg.minimumPay ?? ""),
    },
    {
      name: "paymentMethods",
      label: "Payment methods, one line per CODE REFERENCE_FORMAT DATE_RULE",
      type: "textarea",
      value: Array.isArray(cfg.paymentMethods)
        ? cfg.paymentMethods
            .map((m) => [m.code, m.reference, m.dateRule].join(" "))
            .join("\n")
        : "",
    },
    catalogFields[4],
  ];
  return (
    <div className="space-y-5">
      <Head>Payroll settings</Head>
      <Link href="/admin/payroll">← Payroll periods</Link>
      <Panel>
        <h2>Readiness</h2>
        <p>
          Revision {data.revision}
          {data.effectiveDate
            ? " effective " + data.effectiveDate
            : " · Payroll decisions are not configured"}
          .
        </p>
        {data.missing.length > 0 ? (
          <ul className="list-disc pl-5">
            {data.missing.map((key) => (
              <li key={key}>
                {label(key)} blocks approval
                {key === "weekday" || key === "paydayOffset"
                  ? " and period preparation"
                  : ""}
                .
              </li>
            ))}
          </ul>
        ) : (
          <p>
            The saved revision has every required policy decision. Individual
            periods still check the rules effective on their dates.
          </p>
        )}
        {!data.regularConfigured && (
          <p>
            The REGULAR earning type is missing for today. Configure it for the
            service dates before approval.
          </p>
        )}
        <p>
          Employee rates and schedules are configured in Employees. Missing or
          disputed attendance appears in draft review.
        </p>
      </Panel>
      <Panel>
        <h2>Publish a payroll policy revision</h2>
        <p>
          Recent MFA and a reason are required. Payment reference formats are
          EXACT_ALNUM, UPPER_ALNUM or DIGITS. Date rules are ON_OR_AFTER_CUTOFF
          or ON_OR_AFTER_PAYDAY.
        </p>
        {data.weekdayLocked && (
          <p>The weekday is fixed because a payroll period already exists.</p>
        )}
        <PayrollForm
          key={data.id}
          csrf={s.csrf}
          endpoint="settings"
          title="Publish revision"
          mode="policy"
          fields={fields}
          fixed={{ expectedId: data.id, weekday: cfg.weekday }}
        />
      </Panel>
      <Panel>
        <h2>Earning types</h2>
        <p>
          Use REGULAR for base wages. Premiums, bonuses and allowances require a
          reviewed manual amount.
        </p>
        <ul>
          {data.earnings.map((entry) => (
            <li key={entry.id}>
              {entry.code} · {entry.label} · Revision {entry.revision} ·{" "}
              {entry.effective_date} · {entry.enabled ? "Enabled" : "Disabled"}
            </li>
          ))}
        </ul>
        <PayrollForm
          csrf={s.csrf}
          endpoint="catalog"
          title="Add earning revision"
          mode="catalog"
          fixed={{ kind: "EARNING" }}
          fields={[
            ...catalogFields,
            {
              name: "category",
              label: "Category",
              type: "select",
              required: true,
              options: options([
                "REGULAR",
                "PREMIUM",
                "ALLOWANCE",
                "BONUS",
                "ADJUSTMENT",
              ]),
            },
          ]}
        />
      </Panel>
      <Panel>
        <h2>Deduction types</h2>
        <p>
          Set the employee UUID or the exact profile designation for a group.
          Fixed amounts apply once per period using the revision effective on
          its last included date.
        </p>
        {data.deductions.length === 0 && <p>No deduction types configured.</p>}
        <ul>
          {data.deductions.map((entry) => (
            <li key={entry.id}>
              {entry.code} · {entry.label} ·{" "}
              {entry.designation ?? entry.employee_id} · {entry.effective_date}{" "}
              · {entry.rule.amount ?? entry.rule.mode} ·{" "}
              {entry.enabled ? "Enabled" : "Disabled"}
            </li>
          ))}
        </ul>
        <PayrollForm
          csrf={s.csrf}
          endpoint="catalog"
          title="Add deduction revision"
          mode="catalog"
          fixed={{ kind: "DEDUCTION" }}
          fields={[
            ...catalogFields,
            {
              name: "category",
              label: "Category",
              type: "select",
              required: true,
              options: options([
                "STATUTORY",
                "CONTRIBUTION",
                "WITHHOLDING",
                "LOAN",
                "OTHER",
                "ADJUSTMENT",
              ]),
            },
            {
              name: "employeeId",
              label: "Employee UUID (individual applicability)",
            },
            {
              name: "designation",
              label: "Employee designation (group applicability)",
            },
            {
              name: "rule",
              label: "Amount rule",
              type: "select",
              required: true,
              options: options(["FIXED", "MANUAL"]),
            },
            { name: "amount", label: "PHP amount if fixed" },
          ]}
        />
      </Panel>
    </div>
  );
}

export async function PayrollPeriodsPage({ offset }: { offset?: string }) {
  const s = await account(true);
  const skip = pagination(offset);
  const [periods, data, people] = await Promise.all([
    readPayroll<Period[]>(s, "periods", undefined, Math.floor(skip / 100) * 50),
    readPayroll<Settings>(s, "settings"),
    readPayroll<Person[]>(s, "directory", undefined, skip),
  ]);
  const week =
    typeof data.configuration.weekday === "number"
      ? weeklyCutoff(new Date(), data.configuration.weekday)
      : null;
  return (
    <div className="space-y-5">
      <Head>Payroll periods</Head>
      <Link href="/admin/payroll/settings">
        Payroll settings and readiness →
      </Link>
      <Panel>
        <h2>Prepare a weekly draft</h2>
        <p>
          Select every employee to include in the canonical period. Inactive
          profiles are included in the chooser so earned history can still be
          reviewed.
        </p>
        <p>
          Today is {businessDate(new Date())} in Manila. The week ends at the
          exclusive cutoff.
        </p>
        {data.missing.some(
          (key) => key === "weekday" || key === "paydayOffset",
        ) && (
          <p role="status">
            Configure the weekday and payday before preparing a period.
          </p>
        )}
        <PayrollForm
          csrf={s.csrf}
          endpoint="periods"
          title="Prepare selected employees"
          mode="prepare"
          navigate="period"
          disabled={
            people.length === 0 ||
            !week ||
            data.configuration.paydayOffset === undefined
          }
          fields={[
            {
              name: "startDate",
              label: "Week start date",
              type: "date",
              value: week?.startDate,
              required: true,
            },
            ...people.map((p): PayrollField => ({
              name: p.id,
              label:
                p.number +
                " · " +
                p.name +
                (p.status === "INACTIVE" ? " · Inactive" : ""),
              type: "checkbox",
            })),
          ]}
        />
      </Panel>
      <Panel>
        <h2>Recorded periods</h2>
        {periods.length === 0 ? (
          <p>No payroll periods recorded.</p>
        ) : (
          <ul>
            {periods.map((p) => (
              <li key={p.id}>
                <Link href={"/admin/payroll/periods/" + p.id}>
                  {p.start_date} through {p.end_date} exclusive · {p.state} ·
                  Payday {p.payday}
                </Link>
              </li>
            ))}
          </ul>
        )}
        {(people.length === 100 || periods.length === 50) && (
          <Link href={"/admin/payroll?offset=" + (skip + 100)}>Next page</Link>
        )}
        {skip > 0 && (
          <Link href={"/admin/payroll?offset=" + (skip - 100)}>
            Previous page
          </Link>
        )}
      </Panel>
    </div>
  );
}

export async function PayrollPeriodPage({ id }: { id: string }) {
  const s = await account(true);
  const period = await record(readPayroll<Period>(s, "period", id));
  const blocked = period.lines.filter((line) => line.issues.length > 0);
  return (
    <div className="space-y-5">
      <Head>Period review</Head>
      <Link href="/admin/payroll">← Payroll periods</Link>
      <Panel>
        <h2>
          {period.start_date} through {period.end_date} exclusive
        </h2>
        <p>
          {period.state} · Payday {period.payday}
        </p>
        <ul>
          {period.lines.map((line) => (
            <li key={line.id}>
              <Link href={"/admin/payroll/lines/" + line.id}>
                {line.employee as string} · Revision {line.revision} ·{" "}
                {line.state}
              </Link>
              {" · "}
              {amount(line.net)} net{" · "}
              {line.issues.length} blocking issues
            </li>
          ))}
        </ul>
        {period.state === "DRAFT" && (
          <>
            {!period.cutoffPassed && (
              <p>Approval opens when the exclusive Manila cutoff has passed.</p>
            )}
            {blocked.length > 0 && (
              <p>
                {blocked.length} employee lines need review before approval.
              </p>
            )}
            <p>
              Approval freezes every line in this review. Verify recent MFA in
              Account security.
            </p>
            <PayrollForm
              csrf={s.csrf}
              endpoint={"periods/" + id + "/approve"}
              title="Approve and freeze payroll"
              disabled={!period.cutoffPassed || blocked.length > 0}
              fixed={{
                manifest: period.reviewManifest,
                expectedVersion: period.version,
              }}
            />
          </>
        )}
      </Panel>
    </div>
  );
}

function Items({ line, admin }: { line: Line; admin?: boolean }) {
  return (
    <Panel>
      <h2>Itemized pay</h2>
      {line.items.length === 0 ? (
        <p>No pay items for this line.</p>
      ) : (
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>Service date</th>
                <th>Item</th>
                <th>Kind</th>
                <th>Rate and time</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {line.items.map((item) => (
                <tr key={item.sequence}>
                  <td>{item.date}</td>
                  <td>{item.description}</td>
                  <td>{item.kind}</td>
                  <td>
                    {item.detail.basis && (
                      <div>
                        {item.detail.basis} · {amount(item.detail.rate ?? "")}
                        <br />
                        Approved{" "}
                        {formatDuration(item.detail.approvedSeconds ?? "0")}
                        <br />
                        Calculated{" "}
                        {formatDuration(item.detail.payableSeconds ?? "0")}
                        {item.detail.dayNumerator && (
                          <>
                            <br />
                            Paid days{" "}
                            {item.detail.dayDenominator === "1"
                              ? item.detail.dayNumerator
                              : item.detail.dayNumerator +
                                " / " +
                                item.detail.dayDenominator}
                          </>
                        )}
                      </div>
                    )}
                    {admin &&
                      item.attendance?.map((source) => (
                        <div key={source.shiftId}>
                          <Link href={"/admin/attendance/" + source.shiftId}>
                            Duty {source.dutyDate} · Shift v{source.version} ·{" "}
                            {formatDuration(source.seconds)}
                          </Link>
                        </div>
                      ))}
                  </td>
                  <td>{amount(item.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

export async function PayrollLinePage({ id }: { id: string }) {
  const s = await account(true);
  const [line, settings] = await Promise.all([
    record(readPayroll<Line>(s, "line", id)),
    readPayroll<Settings>(s, "settings"),
  ]);
  const endpoint = "lines/" + id;
  const types = [
    ...settings.earnings
      .filter((e) => e.enabled && e.category !== "REGULAR")
      .map((e) => ({
        value: "EARNING:" + e.id,
        label: e.label + " · " + e.effective_date,
      })),
    ...settings.deductions
      .filter((e) => e.enabled && e.rule.mode === "MANUAL")
      .map((e) => ({
        value: "DEDUCTION:" + e.id,
        label: e.label + " · " + e.effective_date,
      })),
  ];
  const manualFields: PayrollField[] = [
    {
      name: "itemType",
      label: "Catalog type",
      type: "select",
      options: types,
      required: true,
    },
    {
      name: "date",
      label: "Manila service date",
      type: "date",
      value: line.startDate,
      required: true,
    },
    { name: "amount", label: "PHP amount", required: true },
    {
      name: "premiumKind",
      label: "Premium classification, if applicable",
      type: "select",
      options: [
        { value: "overtime", label: "Overtime" },
        { value: "restDay", label: "Rest day" },
        { value: "holiday", label: "Holiday" },
        { value: "premium", label: "Other premium" },
      ],
    },
    ...reviewFields,
  ];
  const fixed = { expectedVersion: line.version };
  const reviewedSources = new Set<string>();
  return (
    <div className="space-y-5">
      <Head>{line.employee as string}</Head>
      <Link href={"/admin/payroll/periods/" + line.periodId}>
        ← Period review
      </Link>
      <Panel>
        <h2>
          {line.state} · Revision {line.revision}
        </h2>
        <p>
          {line.startDate} through {line.endDate} exclusive · Payday{" "}
          {line.payday}
        </p>
        <Totals line={line} />
        {line.snapshotDigest && (
          <p className="break-all">Frozen snapshot {line.snapshotDigest}</p>
        )}
        {line.sourceChanged && (
          <p role="alert">
            Attendance changed after approval. Review a controlled correction.
          </p>
        )}
        <p>
          WORK holiday dates (information only){" "}
          {Array.isArray(line.workHolidays) && line.workHolidays.length
            ? line.workHolidays.map(String).join(", ")
            : "None listed"}
        </p>
      </Panel>
      <Items line={line} admin />
      {line.state === "DRAFT" && (
        <>
          <Panel>
            <h2>Draft review</h2>
            {line.issues.length === 0 && (
              <p>No blocking issues for the current draft.</p>
            )}
            {line.issues.map((issue, index) => {
              const canAllocate =
                issue.shiftId &&
                issue.slices?.length &&
                !reviewedSources.has(issue.shiftId) &&
                ["REVIEWED_ALLOCATION_REQUIRED", "UNRESOLVED_FLAGS"].includes(
                  issue.code,
                );
              if (canAllocate && issue.shiftId)
                reviewedSources.add(issue.shiftId);
              return (
                <div key={index} className="space-y-2">
                  <p>
                    {issue.date && issue.date + " · "}
                    {payrollIssues[issue.code] ?? issue.code}
                    {issue.label && " " + issue.label}
                  </p>
                  {issue.missing && (
                    <p>{issue.missing.map(label).join(", ")}</p>
                  )}
                  {issue.shiftId && (
                    <Link href={"/admin/attendance/" + issue.shiftId}>
                      View attendance shift
                    </Link>
                  )}
                  {canAllocate && (
                    <details>
                      <summary>
                        Review approved allocation of {issue.approvedSeconds}{" "}
                        seconds
                      </summary>
                      <p>{issue.flags?.join(", ") || "No attendance flags"}</p>
                      <PayrollForm
                        csrf={s.csrf}
                        endpoint={endpoint}
                        title="Save reviewed allocation"
                        mode="source"
                        fixed={{
                          ...fixed,
                          action: "SOURCE",
                          shiftId: issue.shiftId,
                          shiftVersion: issue.shiftVersion,
                          flags: issue.flags ?? [],
                        }}
                        fields={[
                          ...issue.slices!.map((slice): PayrollField => ({
                            name: "seconds_" + slice.date,
                            label:
                              slice.date +
                              " · Allocated seconds (gross " +
                              slice.gross +
                              ")",
                            value: slice.suggested,
                            required: true,
                          })),
                          ...reviewFields,
                        ]}
                      />
                    </details>
                  )}
                </div>
              );
            })}
            <PayrollForm
              csrf={s.csrf}
              endpoint={endpoint}
              title="Recalculate draft"
              fixed={{ ...fixed, action: "RECALCULATE" }}
            />
            {line.issues.some((issue) => issue.code === "ZERO_NET_REVIEW") && (
              <details>
                <summary>Review zero net</summary>
                <PayrollForm
                  csrf={s.csrf}
                  endpoint={endpoint}
                  title="Record no-disbursement review"
                  fixed={{ ...fixed, action: "ZERO_REVIEW" }}
                  fields={reviewFields}
                />
              </details>
            )}
          </Panel>
          <Panel>
            <h2>Manual items</h2>
            <PayrollForm
              csrf={s.csrf}
              endpoint={endpoint}
              title="Add reviewed item"
              mode="manual"
              fixed={{ ...fixed, action: "MANUAL" }}
              fields={manualFields}
            />
            {line.adjustments
              .filter(
                (entry) =>
                  entry.kind === "MANUAL" &&
                  entry.after_values.kind !== "ZERO_REVIEW" &&
                  !line.adjustments.some(
                    (a) =>
                      a.kind === "REMOVE_MANUAL" &&
                      a.after_values.manualId === entry.id,
                  ),
              )
              .map((entry) => (
                <details key={entry.id}>
                  <summary>Remove item · {entry.reason}</summary>
                  <PayrollForm
                    csrf={s.csrf}
                    endpoint={endpoint}
                    title="Remove manual item"
                    fields={reviewFields}
                    fixed={{
                      ...fixed,
                      action: "REMOVE_MANUAL",
                      manualId: entry.id,
                    }}
                  />
                </details>
              ))}
            {line.laterPeriodCorrections.length > 0 && (
              <details>
                <summary>Post a reviewed prior paid correction</summary>
                <PayrollForm
                  csrf={s.csrf}
                  endpoint={endpoint}
                  title="Post correction"
                  mode="manual"
                  fixed={{ ...fixed, action: "POST_CORRECTION" }}
                  fields={[
                    {
                      name: "correctionId",
                      label: "Prior correction",
                      type: "select",
                      required: true,
                      options: line.laterPeriodCorrections.map((entry) => ({
                        value: entry.id,
                        label: entry.reason,
                      })),
                    },
                    ...manualFields,
                  ]}
                />
              </details>
            )}
          </Panel>
          {line.predecessorId && (
            <Panel>
              <h2>Approve replacement</h2>
              <Link href={"/admin/payroll/lines/" + line.predecessorId}>
                Review the original approved line
              </Link>
              <PayrollForm
                csrf={s.csrf}
                endpoint={endpoint}
                title="Approve replacement and mark prior line adjusted"
                disabled={line.issues.length > 0}
                fixed={{ ...fixed, action: "APPROVE_REPLACEMENT" }}
                fields={reviewFields}
              />
            </Panel>
          )}
        </>
      )}
      {line.state === "APPROVED" && (
        <Panel>
          <h2>Unpaid line corrections</h2>
          <details>
            <summary>Prepare a replacement draft</summary>
            <PayrollForm
              csrf={s.csrf}
              endpoint={endpoint}
              title="Prepare replacement"
              fixed={{ ...fixed, action: "REPLACE" }}
              fields={reviewFields}
              navigate="line"
            />
          </details>
          <details>
            <summary>Void this approved line</summary>
            <PayrollForm
              csrf={s.csrf}
              endpoint={endpoint}
              title="Void unpaid line"
              fixed={{ ...fixed, action: "VOID" }}
              fields={reviewFields}
            />
          </details>
        </Panel>
      )}
      {line.state === "PAID" && (
        <Panel>
          <h2>Review a paid correction</h2>
          <PayrollForm
            csrf={s.csrf}
            endpoint={endpoint}
            title="Flag a later-period correction"
            fixed={{ ...fixed, action: "CORRECTION_NEEDED" }}
            fields={reviewFields}
          />
        </Panel>
      )}
      {line.adjustments.length > 0 && (
        <Panel>
          <h2>Adjustment trail</h2>
          {line.adjustments.map((entry) => (
            <details key={entry.id}>
              <summary>
                {entry.kind} · {entry.reason}
              </summary>
              <p>{entry.evidence}</p>
              <pre className="whitespace-pre-wrap break-all">
                {JSON.stringify(
                  { before: entry.before_values, after: entry.after_values },
                  null,
                  2,
                )}
              </pre>
            </details>
          ))}
        </Panel>
      )}
    </div>
  );
}

export async function MyPayrollPage({
  id,
  offset,
}: {
  id?: string;
  offset?: string;
}) {
  const s = await account();
  if (id) {
    const line = await record(readPayroll<Line>(s, "own-line", id));
    const employee = line.employee as {
      name: string;
      number: string;
      position: string;
    };
    return (
      <div className="space-y-5">
        <Head>My payroll</Head>
        <Link href="/me/payroll">← My finalized payroll</Link>
        <Panel>
          <h2>
            {employee.name} · {employee.number}
          </h2>
          <p>
            {employee.position} · {line.state} · Revision {line.revision}
          </p>
          <p>
            {line.startDate} through {line.endDate} exclusive · Payday{" "}
            {line.payday}
          </p>
          <Totals line={line} />
        </Panel>
        <Items line={line} />
      </div>
    );
  }
  const skip = pagination(offset);
  const lines = await readPayroll<Line[]>(s, "own", undefined, skip);
  return (
    <div className="space-y-5">
      <Head>My finalized payroll</Head>
      <Panel>
        {lines.length === 0 ? (
          <p>There are no finalized payroll lines for your account.</p>
        ) : (
          <ul>
            {lines.map((line) => (
              <li key={line.id}>
                <Link href={"/me/payroll/" + line.id}>
                  {line.startDate} through {line.endDate} exclusive ·{" "}
                  {line.state} · {amount(line.net)}
                </Link>
              </li>
            ))}
          </ul>
        )}
        {skip > 0 && (
          <Link href={"/me/payroll?offset=" + Math.max(0, skip - 50)}>
            Previous page
          </Link>
        )}
        {lines.length === 50 && (
          <Link href={"/me/payroll?offset=" + (skip + 50)}>Next page</Link>
        )}
      </Panel>
    </div>
  );
}
