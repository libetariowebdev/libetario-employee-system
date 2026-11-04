import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  holdQuietShiftGate,
  openShiftCount,
} from "../../scripts/lib/backup-shift-gate";
import { authPool, db } from "../../src/server/db";
import {
  advance,
  attendanceFixture,
  clockIn,
  clockOut,
} from "../attendance-helpers";
import { testOwner } from "../helpers";

after(async () => {
  await db.$disconnect();
  await authPool.end();
});

test("release backup skips an open shift and serializes with attendance writers before shutdown", async () => {
  const f = await attendanceFixture();
  const other = testOwner();
  await other.connect();
  try {
    const id = await clockIn(f);
    assert.equal(await openShiftCount(f.owner), 1);
    assert.equal(await holdQuietShiftGate(f.owner), false);
    await advance(f, 1);
    await clockOut(f, id);
    assert.equal(await openShiftCount(f.owner), 0);
    await other.query("BEGIN");
    await other.query(
      "LOCK TABLE public.attendance_shifts IN ROW EXCLUSIVE MODE",
    );
    assert.equal(await holdQuietShiftGate(f.owner), false);
    await other.query("ROLLBACK");

    assert.equal(await holdQuietShiftGate(f.owner), true);
    await other.query("BEGIN");
    await assert.rejects(
      () =>
        other.query(
          "LOCK TABLE public.attendance_shifts IN ROW EXCLUSIVE MODE NOWAIT",
        ),
      { code: "55P03" },
    );
    await other.query("ROLLBACK");
    await f.owner.query("COMMIT");
    assert.ok(await clockIn(f));
  } finally {
    await f.owner.query("ROLLBACK").catch(() => {});
    await other.end();
    await f.cleanup();
  }
});
