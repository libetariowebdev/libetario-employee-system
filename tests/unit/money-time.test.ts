import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decimal,
  roundMoney,
  sumMoney,
  hourlyAmount,
  formatPHP,
} from "../../src/lib/money";
import {
  businessDate,
  localMidnight,
  weeklyCutoff,
  dateOnly,
} from "../../src/lib/time";
import { passwordValid } from "../../src/server/auth/security";
test("money uses exact decimal strings and configurable tie rounding", () => {
  assert.equal(sumMoney(["0.10", "0.20"]), "0.30");
  assert.equal(roundMoney("1.005"), "1.01");
  assert.equal(roundMoney("1.005", "HALF_EVEN"), "1.00");
  assert.equal(roundMoney("1.009", "DOWN"), "1.00");
  assert.equal(hourlyAmount("150.1250", 1800), "75.06");
  assert.equal(hourlyAmount("150.1250", 1), "0.04");
  assert.equal(formatPHP("1234567.50"), "₱1,234,567.50");
  assert.equal(
    JSON.stringify({ amount: decimal("0.1000").toFixed(4) }),
    '{"amount":"0.1000"}',
  );
  assert.throws(() => decimal(0.1 as unknown as string));
  assert.throws(() => decimal("1e3"));
  assert.throws(() => hourlyAmount("100", 0.5));
});
test("Manila midnight is previous UTC date at 16:00; calendar dates do not depend on host timezone", () => {
  assert.equal(businessDate(new Date("2026-10-29T15:59:59Z")), "2026-10-29");
  assert.equal(businessDate(new Date("2026-10-29T16:00:00Z")), "2026-10-30");
  assert.equal(
    localMidnight("2026-10-30").toISOString(),
    "2026-10-29T16:00:00.000Z",
  );
  assert.throws(() => dateOnly("2026-02-30"));
  assert.throws(() => dateOnly("10/30/2026"));
});
test("weekly cutoff is start inclusive and end exclusive across weekend, year boundary and configurable weekday", () => {
  const before = weeklyCutoff(new Date("2026-11-01T15:59:59Z"));
  assert.equal(before.startDate, "2026-10-26");
  assert.equal(before.endDate, "2026-11-02");
  assert.equal(
    weeklyCutoff(new Date("2026-11-01T16:00:00Z")).startDate,
    "2026-11-02",
  );
  assert.equal(
    weeklyCutoff(new Date("2027-01-01T00:00:00Z")).startDate,
    "2026-12-28",
  );
  assert.equal(
    weeklyCutoff(new Date("2026-10-30T00:00:00Z"), 5).startDate,
    "2026-10-30",
  );
  assert.throws(() => weeklyCutoff(new Date(), 0));
});
test("password policy handles Unicode code points and rejects missing complexity/overlength", () => {
  assert.equal(passwordValid("abcdefghijk1"), true);
  assert.equal(passwordValid("abcdefghijkl"), false);
  assert.equal(passwordValid("界".repeat(127) + "1"), true);
  assert.equal(passwordValid("界".repeat(128) + "1"), false);
});
