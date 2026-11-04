export const payrollOptions = {
  source: ["APPROVED_ATTENDANCE"],
  breaks: ["CONFIRM_CAPTURED"],
  overnight: ["REVIEWED_SPLIT"],
  paidDay: ["ANY_POSITIVE", "MINIMUM_SECONDS"],
  partialDay: ["PRORATE", "FULL", "ZERO"],
  lateness: ["NO_ADJUSTMENT", "REVIEW"],
  overtime: ["MANUAL", "NONE"],
  restDay: ["MANUAL", "NONE"],
  holiday: ["MANUAL", "NONE"],
  premium: ["MANUAL", "NONE"],
  allowance: ["MANUAL", "NONE"],
  bonus: ["MANUAL", "NONE"],
  deductions: ["CATALOG", "NONE"],
  contributions: ["CATALOG", "NONE"],
  withholding: ["CATALOG", "NONE"],
  loans: ["CATALOG", "NONE"],
  timeRounding: ["NONE", "HALF_UP", "HALF_EVEN", "FLOOR", "CEIL", "TRUNCATE"],
  moneyRounding: ["NONE", "HALF_UP", "HALF_EVEN", "FLOOR", "CEIL", "TRUNCATE"],
  zeroNet: ["REVIEW_NO_DISBURSEMENT"],
} as const;

export const payrollLabels: Record<string, string> = {
  source: "Payable time source",
  breaks: "Use recorded paid and unpaid break treatment",
  overnight: "Overnight allocation",
  paidDay: "Paid day eligibility",
  partialDay: "Daily rate for a qualifying partial day",
  minimumDaySeconds: "Minimum approved seconds for a paid day",
  minimumPay: "Minimum PHP per day with payable time",
  lateness: "Lateness",
  overtime: "Overtime items",
  restDay: "Rest day items",
  holiday: "Holiday items",
  premium: "Other premiums",
  allowance: "Allowances",
  bonus: "Bonuses",
  deductions: "Deductions and statutory applicability",
  contributions: "Contributions",
  withholding: "Withholding",
  loans: "Loans",
  timeRounding: "Payable time rounding",
  timeUnitSeconds: "Time rounding unit in seconds",
  moneyRounding: "Money rounding",
  moneyUnitCentavos: "Money rounding unit in centavos",
  weekday: "Manila week starts on",
  paydayOffset: "Calendar days after cutoff until payday",
  paymentMethods: "Payment methods, references and date rules",
  zeroNet: "Zero net handling",
};

export const payrollIssues: Record<string, string> = {
  OPEN_SHIFT: "Clock Out or correct the open shift.",
  DISPUTED_SHIFT: "Decide the pending attendance correction.",
  ATTENDANCE_NOT_APPROVED: "Approve the closed shift in Attendance.",
  INVALID_ATTENDANCE_INTERVAL: "Review and correct the attendance interval.",
  MISSING_OR_INVALID_PUNCH:
    "Correct the missing or invalid punch and approve the shift again.",
  UNRESOLVED_FLAGS: "Review the current attendance flags and exact allocation.",
  REVIEWED_ALLOCATION_REQUIRED:
    "Review and allocate the approved seconds across the Manila dates.",
  PAY_POLICY_UNCONFIGURED: "Complete the effective pay settings.",
  RATE_UNCONFIGURED: "Set an effective daily or hourly employee rate.",
  SCHEDULE_UNCONFIGURED: "Set the effective employee schedule.",
  REGULAR_EARNING_UNCONFIGURED: "Set the effective REGULAR earning type.",
  MISSING_EXPECTED_PUNCH:
    "Review the missing attendance for a scheduled workday.",
  ATTENDANCE_CORRECTION_PENDING: "Decide the attendance correction request.",
  NON_CENT_EXACT:
    "This item needs an explicit money rounding rule to post in centavos.",
  NEGATIVE_NET:
    "Deductions exceed gross pay. Review the items before approval.",
  ZERO_NET_REVIEW: "Record a no-disbursement review for the zero-net line.",
  MANUAL_ITEM_REVIEW:
    "A manual item needs review under the current catalog and pay policy.",
  MANUAL_DEDUCTION_REQUIRED:
    "Enter the reviewed amount for the applicable deduction.",
};
