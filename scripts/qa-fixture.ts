import { fixture } from "../tests/helpers";
import { writeFile } from "node:fs/promises";
import { sampleCredentials } from "../prisma/seed";
const f = await fixture({ password: sampleCredentials[0].password });
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
console.log(
  "Temporary test browser usernames:",
  "admin_" + f.suffix,
  "a_" + f.suffix,
);
