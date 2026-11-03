// Disposable local-test identities only. Never imported by request handlers.
import { fixture } from "../tests/helpers";
import { sampleCredentials } from "../prisma/seed";
import { enrollDuty } from "../tests/duty-helpers";
import { businessDate } from "../src/lib/time";
import { workSession } from "../src/server/dal/work";
import { createProject, createTask } from "../src/server/services/work";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { db, authPool } from "../src/server/db";
const f = await fixture({ password: sampleCredentials[0].password });
try {
  const now = (await f.owner.query("SELECT private.security_now() AS now"))
    .rows[0].now as Date;
  await enrollDuty(f, now);
  await f.owner.query(
    "SELECT private.mutate_duty($1::uuid[],$2::date,'ACTIVATE','Fake browser verification fixture only',false,NULL)",
    [[f.ids.a], businessDate(now)],
  );
  const w = await workSession(f.tokens.admin),
    p = await createProject(w, {
      creationKey: randomUUID(),
      code: "QA-" + f.suffix.toUpperCase(),
      name: "QA · Website refresh",
      description: "Fake test project for the checkpoint 3b browser review.",
    });
  const task = await createTask(w, {
    creationKey: randomUUID(),
    projectId: p.id,
    title: "Deliver the landing page brief",
    instructions:
      "Read the brief and submit notes with a private attachment for review. This is fake QA work; no action records paid time.",
    assignmentMode: "SELECTED",
    employeeIds: [f.ids.a, f.ids.b],
    references: [
      {
        url: "https://example.invalid/brief",
        label: "Example brief (test only)",
      },
    ],
  });
  await writeFile(
    ".local/qa-work.json",
    JSON.stringify({
      employee: "a_" + f.suffix,
      admin: "admin_" + f.suffix,
      employeeId: f.ids.a,
      adminId: f.ids.admin,
      projectId: p.id,
      taskId: task.id,
    }),
    { mode: 0o600 },
  );
  console.log(
    "Fake browser fixture ready; identifiers saved in ignored .local/qa-work.json. Credentials are the README seed example.",
  );
} finally {
  await f.owner.end();
  await db.$disconnect();
  await authPool.end();
}
