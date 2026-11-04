import "./lib/require-local-qa";
import { fixture } from "../tests/helpers";
import { writeFile } from "node:fs/promises";
import { sampleCredentials } from "../prisma/seed";
import { enrollDuty } from "../tests/duty-helpers";
import { businessDate } from "../src/lib/time";
import { db, authPool } from "../src/server/db";
const f = await fixture({ password: sampleCredentials[0].password });
const now = (await f.owner.query("SELECT private.security_now() now")).rows[0]
  .now as Date;
await enrollDuty(f, now);
await f.owner.query(
  "SELECT private.mutate_duty($1::uuid[],$2::date,'ACTIVATE','Fake browser verification fixture only',false,NULL)",
  [[f.ids.a], businessDate(now)],
);
await writeFile(
  ".local/qa.json",
  JSON.stringify({
    username: "admin_" + f.suffix,
    employee: "a_" + f.suffix,
    employeeId: f.ids.a,
  }),
  { mode: 0o600 },
);
await f.owner.end();
await db.$disconnect();
await authPool.end();
console.log(
  "Temporary test browser usernames:",
  "admin_" + f.suffix,
  "a_" + f.suffix,
);
