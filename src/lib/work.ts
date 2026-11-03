import { z } from "zod";
export const priorities = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
export const projectStates = [
  "ACTIVE",
  "PLANNING",
  "ON_HOLD",
  "COMPLETED",
  "CANCELLED",
] as const;
export const taskStates = [
  "PENDING",
  "IN_PROGRESS",
  "SUBMITTED",
  "REVISION_REQUIRED",
  "APPROVED",
  "CANCELLED",
] as const;
export const assignmentModes = [
  "INDIVIDUAL",
  "SELECTED",
  "ALL_ACTIVE",
] as const;
export const reasonSchema = z.string().trim().min(10).max(500);
const url = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return (
        /^https?:\/\//.test(value) &&
        ["https:", "http:"].includes(parsed.protocol) &&
        !parsed.username &&
        !parsed.password &&
        !/[\s\u0000-\u001f\\]/.test(value)
      );
    } catch {
      return false;
    }
  }, "Use an HTTP(S) URL without credentials");
const links = z
  .array(z.strictObject({ url, label: z.string().trim().max(120).optional() }))
  .max(10);
export const projectFields = z.strictObject({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9_-]{1,39}$/),
  name: z.string().trim().min(1).max(200),
  clientLabel: z.string().trim().max(200).nullable().optional(),
  websiteUrl: url.nullable().optional(),
  description: z.string().max(10000).default(""),
  references: links.default([]),
  startDate: z.iso.date().nullable().optional(),
  deadlineAt: z.iso.datetime({ offset: true }).nullable().optional(),
  priority: z.enum(priorities).default("NORMAL"),
  status: z.enum(projectStates).default("ACTIVE"),
});
export const taskFields = z.strictObject({
  title: z.string().trim().min(1).max(200),
  instructions: z.string().max(10000).default(""),
  references: links.default([]),
  dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
  priority: z.enum(priorities).default("NORMAL"),
});
export const createProjectSchema = projectFields.extend({
  creationKey: z.uuid(),
});
export const editProjectSchema = projectFields
  .partial()
  .extend({
    expectedVersion: z.number().int().positive(),
    reason: reasonSchema,
  });
export const createTaskSchema = taskFields
  .extend({
    projectId: z.uuid(),
    creationKey: z.uuid(),
    collaborationMode: z.literal("SHARED").default("SHARED"),
    assignmentMode: z.enum(assignmentModes),
    employeeIds: z.array(z.uuid()).max(500).default([]),
  })
  .superRefine((value, ctx) => {
    if (
      (value.assignmentMode === "ALL_ACTIVE" &&
        value.employeeIds.length !== 0) ||
      (value.assignmentMode === "INDIVIDUAL" &&
        value.employeeIds.length !== 1) ||
      (value.assignmentMode === "SELECTED" && value.employeeIds.length === 0) ||
      new Set(value.employeeIds).size !== value.employeeIds.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Choose the required unique recipients for this mode",
        path: ["employeeIds"],
      });
  });
export const editTaskSchema = taskFields
  .partial()
  .extend({
    expectedVersion: z.number().int().positive(),
    reason: reasonSchema,
  });
export const progressSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  status: z.enum(taskStates),
  reason: reasonSchema.optional(),
});
export const membershipSchema = z
  .strictObject({
    expectedVersion: z.number().int().positive(),
    add: z.array(z.uuid()).max(500).default([]),
    remove: z.array(z.uuid()).max(500).default([]),
    reason: reasonSchema,
  })
  .refine(
    (v) =>
      v.add.length + v.remove.length > 0 &&
      new Set(v.add).size === v.add.length &&
      new Set(v.remove).size === v.remove.length &&
      !v.add.some((id) => v.remove.includes(id)),
    "Choose unique additions/withdrawals",
  );
export const commentSchema = z.strictObject({
  body: z.string().trim().min(1).max(5000),
  creationKey: z.uuid(),
});
export const seenSchema = z.strictObject({
  observations: z
    .array(
      z.strictObject({
        assignmentId: z.uuid(),
        taskVersion: z.number().int().positive(),
        projectVersion: z.number().int().positive(),
        assignmentVersion: z.number().int().positive(),
      }),
    )
    .max(50),
});
export type ReferenceLink = { url: string; label?: string };
export function label(value: string) {
  return value === "APPROVED"
    ? "Approved / Completed"
    : value
        .toLowerCase()
        .replaceAll("_", " ")
        .replace(/^./, (s) => s.toUpperCase());
}
export function readOnlyReason(projectStatus: string, taskStatus: string) {
  if (projectStatus !== "ACTIVE")
    return `Read-only: this project is ${label(projectStatus).toLowerCase()}. Progress and comments are disabled until an administrator makes it active.`;
  if (taskStatus === "CANCELLED")
    return "Read-only: this task is cancelled. An administrator must explicitly restore it before progress or comments can continue.";
  return null;
}
