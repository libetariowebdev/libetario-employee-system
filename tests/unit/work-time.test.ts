import { test } from "node:test";
import assert from "node:assert/strict";
import { csvCell, timeRules } from "../../src/lib/work-time";

test("CSV quotes text and neutralizes formula markers after whitespace", () => {
  assert.equal(
    csvCell('  =HYPERLINK("bad","x")'),
    '"\'  =HYPERLINK(""bad"",""x"")"',
  );
  assert.equal(csvCell("＋10"), '"\'＋10"');
  assert.equal(csvCell("\nplain"), '"\'\nplain"');
  assert.equal(csvCell('Project, "Second"'), '"Project, ""Second"""');
  assert.equal(csvCell("0.000001"), '"0.000001"');
});
test("report limits validate 31 days and 50,000 rows with policy able only to lower the caps", () => {
  const defaults = {
    timers: { switchMode: "ATOMIC_STOP_AND_START" },
    reports: {
      weekStartsOn: 1,
      pollSeconds: 15,
      maxDays: 31,
      maxRows: 50000,
      maxEntries: 100,
    },
  };
  assert.equal(timeRules.safeParse(defaults).success, true);
  for (const change of [
    { maxRows: 50001 },
    { maxDays: 32 },
    { maxEntries: 101 },
    { pollSeconds: 9 },
  ])
    assert.equal(
      timeRules.safeParse({
        ...defaults,
        reports: { ...defaults.reports, ...change },
      }).success,
      false,
    );
});
