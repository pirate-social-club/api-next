import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { diffBreaking, type OpenApiDocument } from "@pirate/contracts";

// Diff the committed OpenAPI document against the one on HEAD. CI runs this
// after check:fresh on a full checkout; locally HEAD works for uncommitted
// reviews. Removal of the tracked file (first introduction) is additive.
const path = "apps/http-worker/src/generated/openapi.json";
const oldText = (() => {
  try {
    return execFileSync("git", ["show", `HEAD:${path}`], { encoding: "utf8" });
  } catch {
    process.exit(0);
  }
})();
const oldDoc = JSON.parse(oldText) as OpenApiDocument;
const newDoc = JSON.parse(await readFile(path, "utf8")) as OpenApiDocument;
const breaks = diffBreaking(oldDoc, newDoc);
if (breaks.length > 0) {
  console.error("Breaking OpenAPI changes detected (000 §5: append-only within a major version):");
  for (const violation of breaks) console.error(`  - ${violation}`);
  process.exit(1);
}
