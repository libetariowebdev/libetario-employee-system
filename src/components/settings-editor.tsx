"use client";
import { useState } from "react";
import { mutation } from "./forms";
import type { securitySchema } from "@/lib/config";
import type { z } from "zod";
type Security = z.infer<typeof securitySchema>;
const labels: Record<keyof Security, string> = {
  idleMinutes: "Idle session lifetime (minutes)",
  absoluteMinutes: "Absolute session lifetime (minutes)",
  accountLimit: "Account failure threshold",
  networkLimit: "Network failure threshold",
  windowMinutes: "Attempt window (minutes)",
  lockMinutes: "Lockout duration (minutes)",
  resetMinutes: "Reset-token lifetime (minutes)",
};
export function SettingsEditor({
  csrf,
  configuration,
}: {
  csrf: string;
  configuration: Security;
}) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <form
      className="card form-stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setError("");
        setBusy(true);
        const d = Object.fromEntries(new FormData(e.currentTarget));
        const config = Object.fromEntries(
          Object.keys(configuration).map((k) => [k, Number(d[k])]),
        );
        try {
          await mutation(
            "admin/settings/security",
            { configuration: config, reason: d.reason },
            csrf,
          );
          window.location.reload();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div>
        <p className="eyebrow">SECURITY POLICY</p>
        <h2>Session & sign-in controls</h2>
        <p className="muted small">
          Saving creates a new immutable policy version. Existing absolute
          expiries are never extended. New idle/lockout settings apply to
          subsequent checks.
        </p>
      </div>
      <div className="form-grid">
        {(Object.keys(labels) as (keyof Security)[]).map((k) => (
          <label key={k}>
            {labels[k]}
            <input
              type="number"
              name={k}
              min="1"
              max={
                k === "absoluteMinutes" ? 480 : k === "networkLimit" ? 100 : 60
              }
              defaultValue={configuration[k]}
              required
            />
          </label>
        ))}
      </div>
      <label>
        Reason for policy change
        <textarea name="reason" minLength={10} maxLength={500} required />
      </label>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      <button className="button primary" disabled={busy}>
        {busy ? "Saving…" : "Save new policy version"} ↗
      </button>
    </form>
  );
}
