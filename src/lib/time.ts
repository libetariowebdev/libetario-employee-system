export const BUSINESS_TIMEZONE = "Asia/Manila";
export function dateOnly(value: string) {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(value))
    throw new Error("Use an ISO date in 2000–2099");
  const d = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== value)
    throw new Error("Invalid calendar date");
  return d;
}
export function businessDate(instant: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (key: string) => parts.find((p) => p.type === key)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
export function localMidnight(value: string) {
  dateOnly(value);
  return new Date(`${value}T00:00:00+08:00`);
}
export function weeklyCutoff(instant: Date, isoWeekday = 1) {
  if (!Number.isInteger(isoWeekday) || isoWeekday < 1 || isoWeekday > 7)
    throw new Error("Invalid cutoff weekday");
  const local = dateOnly(businessDate(instant));
  const weekday = local.getUTCDay() || 7;
  local.setUTCDate(local.getUTCDate() - ((weekday - isoWeekday + 7) % 7));
  const startDate = local.toISOString().slice(0, 10);
  local.setUTCDate(local.getUTCDate() + 7);
  const endDate = local.toISOString().slice(0, 10);
  return {
    startDate,
    endDate,
    start: localMidnight(startDate),
    end: localMidnight(endDate),
  };
}
export function formatDate(value: Date | string) {
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: BUSINESS_TIMEZONE,
    dateStyle: "medium",
  }).format(new Date(value));
}
