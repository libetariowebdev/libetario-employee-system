import { execFileSync } from "node:child_process";
import { forbiddenReleasePath } from "./lib/release-paths.mjs";

const tracked = execFileSync("git", ["ls-files", "--cached", "-z"], {
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);
const blocked = tracked.filter((file) => forbiddenReleasePath(file));
if (blocked.length) {
  console.error(
    "Forbidden tracked paths. Remove from the index and review Git history.",
  );
  for (const file of blocked) console.error(JSON.stringify(file));
  process.exitCode = 1;
} else {
  console.log("No forbidden tracked secret, upload or backup paths.");
}
