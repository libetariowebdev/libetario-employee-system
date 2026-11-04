"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { payrollOptions } from "@/lib/payroll";

export type PayrollField = {
  name: string;
  label: string;
  type?: "text" | "date" | "number" | "textarea" | "checkbox" | "select";
  value?: string;
  options?: { value: string; label: string }[];
  required?: boolean;
  disabled?: boolean;
};

type Mode = "plain" | "policy" | "catalog" | "prepare" | "manual" | "source";
export function PayrollForm({
  csrf,
  endpoint,
  title,
  fields = [],
  fixed = {},
  mode = "plain",
  navigate,
  disabled,
}: {
  csrf: string;
  endpoint: string;
  title: string;
  fields?: PayrollField[];
  fixed?: Record<string, unknown>;
  mode?: Mode;
  navigate?: "period" | "line";
  disabled?: boolean;
}) {
  const router = useRouter();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const receipt = useRef<{ fingerprint: string; key: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const values = Object.fromEntries(form) as Record<string, string>;
    const cleaned = Object.fromEntries(
      Object.entries(values).filter(([, value]) => value !== ""),
    );
    let input: Record<string, unknown> = { ...cleaned, ...fixed };
    if (mode === "policy") {
      const configuration: Record<string, unknown> = {};
      for (const key of Object.keys(payrollOptions))
        if (values[key]) configuration[key] = values[key];
      for (const key of [
        "weekday",
        "paydayOffset",
        "minimumDaySeconds",
        "timeUnitSeconds",
        "moneyUnitCentavos",
      ]) {
        const value =
          values[key] ?? (key === "weekday" ? String(fixed.weekday ?? "") : "");
        if (value !== "") configuration[key] = Number(value);
      }
      if (values.minimumPay)
        configuration.minimumPay = values.minimumPay.trim().toUpperCase();
      if (values.paymentMethods?.trim()) {
        configuration.paymentMethods = values.paymentMethods
          .trim()
          .split(/\r?\n/)
          .map((line) => {
            const [code, reference, dateRule] = line.trim().split(/\s+/);
            return { code, reference, dateRule };
          });
      }
      input = {
        configuration,
        expectedId: fixed.expectedId,
        effectiveDate: values.effectiveDate,
        reason: values.reason,
      };
    } else if (mode === "catalog") {
      const { amount, rule, enabled, ...other } = cleaned;
      input = {
        ...other,
        ...fixed,
        enabled: enabled === "on",
        rule:
          fixed.kind === "EARNING"
            ? { mode: values.category === "REGULAR" ? "REGULAR" : "MANUAL" }
            : rule === "FIXED"
              ? { mode: "FIXED", amount }
              : { mode: "MANUAL" },
      };
    } else if (mode === "prepare") {
      const employeeIds = fields
        .filter((field) => field.type === "checkbox" && form.has(field.name))
        .map((field) => field.name);
      if (employeeIds.length === 0 || employeeIds.length > 100) {
        setStatus("Select 1 to 100 employees for this period.");
        return;
      }
      input = { startDate: values.startDate, employeeIds };
    } else if (mode === "manual") {
      const { itemType, ...other } = cleaned;
      const [kind, typeId] = (itemType ?? "").split(":");
      input = { ...other, ...fixed, kind, typeId };
    } else if (mode === "source") {
      input = {
        ...fixed,
        reason: values.reason,
        evidence: values.evidence,
        allocations: fields
          .filter((field) => field.name.startsWith("seconds_"))
          .map((field) => ({
            date: field.name.slice(8),
            seconds: values[field.name],
          })),
      };
    }
    if (mode !== "catalog" && mode !== "policy") {
      const fingerprint = JSON.stringify(input);
      if (receipt.current?.fingerprint !== fingerprint)
        receipt.current = { fingerprint, key: crypto.randomUUID() };
      input.operationKey = receipt.current.key;
    }
    setBusy(true);
    setStatus("");
    try {
      const response = await fetch("/api/payroll/" + endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, csrf }),
      });
      const data = await response.json();
      if (!response.ok) {
        setStatus(data.error ?? "Payroll change could not be saved.");
        return;
      }
      receipt.current = null;
      setStatus("Saved.");
      if (navigate === "period")
        router.push("/admin/payroll/periods/" + data.id);
      else if (navigate === "line")
        router.push("/admin/payroll/lines/" + data.id);
      router.refresh();
    } catch {
      setStatus("The request could not be completed. You can retry.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form-stack space-y-3" onSubmit={submit}>
      {fields.map((field) => (
        <label
          className={
            field.type === "checkbox" ? "flex items-center gap-2" : "grid gap-1"
          }
          key={field.name}
        >
          {field.type === "checkbox" && (
            <input
              type="checkbox"
              name={field.name}
              defaultChecked={field.value === "on"}
            />
          )}
          <span>{field.label}</span>
          {field.type === "select" && (
            <select
              name={field.name}
              defaultValue={field.value ?? ""}
              required={field.required}
              disabled={field.disabled}
            >
              <option value="">Not configured / select</option>
              {field.options?.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
          {field.type === "textarea" && (
            <textarea
              name={field.name}
              defaultValue={field.value}
              required={field.required}
              maxLength={2000}
            />
          )}
          {field.type !== "select" &&
            field.type !== "textarea" &&
            field.type !== "checkbox" && (
              <input
                name={field.name}
                type={field.type ?? "text"}
                defaultValue={field.value}
                required={field.required}
                maxLength={200}
              />
            )}
        </label>
      ))}
      <button className="button" type="submit" disabled={busy || disabled}>
        {busy ? "Saving…" : title}
      </button>
      {status && (
        <p role="status" aria-live="polite">
          {status}
        </p>
      )}
    </form>
  );
}
