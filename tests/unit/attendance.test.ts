import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attendanceDefaults,
  attendancePolicySchema,
  exactSeconds,
  duration,
  manilaInput,
  manilaInstant,
  shiftReviewSchema,
} from "../../src/lib/attendance";
import { randomUUID } from "node:crypto";
test("attendance defaults distinguish unpaid MEAL and paid SHORT, and reject ambiguous or invalid policies", () => {
  assert.deepEqual(
    attendanceDefaults.breakCodes.map((b) => [b.code, b.paid]),
    [
      ["MEAL", false],
      ["SHORT", true],
    ],
  );
  assert.equal(attendanceDefaults.longShiftReviewSeconds, 57600);
  assert.equal(attendanceDefaults.maxShiftsPerDutyDate, null);
  for (const value of [
    { longShiftReviewSeconds: 0 },
    { bulkMaxDays: 32 },
    {
      breakCodes: [
        { ...attendanceDefaults.breakCodes[0] },
        { ...attendanceDefaults.breakCodes[0] },
      ],
    },
    { breakCodes: [{ ...attendanceDefaults.breakCodes[0], paid: "false" }] },
    { automaticPayroll: true },
  ])
    assert.equal(attendancePolicySchema.safeParse(value).success, false);
});
test("attendance seconds retain microseconds without rounding; Manila correction inputs retain instants at rollover", () => {
  assert.equal(exactSeconds.parse("28800.123456"), "28800.123456");
  assert.equal(duration("28800.123456"), "8:00:00.123456");
  for (const v of ["1e3", "NaN", "-1", "1.1234567", " 1"])
    assert.equal(exactSeconds.safeParse(v).success, false);
  assert.equal(
    manilaInput("2026-12-31T16:00:00.123456+00:00"),
    "2027-01-01T00:00:00.123456",
  );
  assert.equal(
    manilaInstant("2027-01-01T00:00:00.123456"),
    "2027-01-01T00:00:00.123456+08:00",
  );
  assert.equal(manilaInstant("2027-01-01T00:00"), "2027-01-01T00:00:00+08:00");
});
test("an explicit approval uses SUGGESTED by default; override and rejection require a reason", () => {
  const b = {
    operationKey: randomUUID(),
    expectedVersion: 1,
    decision: "APPROVED",
  };
  assert.equal(shiftReviewSchema.parse(b).mode, "SUGGESTED");
  assert.equal(
    shiftReviewSchema.safeParse({ ...b, mode: "OVERRIDE", value: "60" })
      .success,
    false,
  );
  assert.equal(
    shiftReviewSchema.safeParse({
      ...b,
      mode: "OVERRIDE",
      value: "60",
      reason: "Confirmed with employee",
    }).success,
    true,
  );
  assert.equal(
    shiftReviewSchema.safeParse({ ...b, decision: "REJECTED", reason: "short" })
      .success,
    false,
  );
});
