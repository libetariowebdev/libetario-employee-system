import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createTaskSchema,
  createProjectSchema,
  readOnlyReason,
} from "../../src/lib/work";
test("project defaults ACTIVE; SHARED only and recipient modes validate without assuming time", () => {
  assert.equal(
    createProjectSchema.parse({
      creationKey: randomUUID(),
      code: "sample",
      name: "Sample",
    }).status,
    "ACTIVE",
  );
  const task = {
    creationKey: randomUUID(),
    projectId: randomUUID(),
    title: "Sample",
    assignmentMode: "INDIVIDUAL",
    employeeIds: [randomUUID()],
  };
  assert.equal(createTaskSchema.parse(task).collaborationMode, "SHARED");
  assert.throws(() =>
    createTaskSchema.parse({ ...task, collaborationMode: "COPIES" }),
  );
  assert.throws(() =>
    createTaskSchema.parse({ ...task, assignmentMode: "ALL_ACTIVE" }),
  );
});
test("every inactive project gives an explicit read-only progress/comments explanation", () => {
  for (const state of ["PLANNING", "ON_HOLD", "COMPLETED", "CANCELLED"])
    assert.match(
      readOnlyReason(state, "PENDING")!,
      /Progress and comments are disabled/,
    );
  assert.equal(readOnlyReason("ACTIVE", "PENDING"), null);
  assert.match(readOnlyReason("ACTIVE", "CANCELLED")!, /cancelled/);
});
