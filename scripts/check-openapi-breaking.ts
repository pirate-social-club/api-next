import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { diffBreaking, type OpenApiDocument } from "@pirate/contracts";

// Diff the committed OpenAPI document against the one on HEAD. CI runs this
// after check:fresh on a full checkout; locally HEAD works for uncommitted
// reviews. Absence of the tracked file (first introduction) is additive.
//
// A removal may be declared explicitly in packages/contracts/deprecations.json
// (000 §5: "breaking changes require a new path or an explicit deprecation
// entry") — an undeclared removal is always a failure.
interface Deprecations {
  readonly deprecatedOperations: readonly {
    readonly operationId: string;
    readonly reason: string;
  }[];
}

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
const deprecations = JSON.parse(
  await readFile(new URL("../packages/contracts/deprecations.json", import.meta.url), "utf8"),
) as Deprecations;
const declared = new Set(deprecations.deprecatedOperations.map((entry) => entry.operationId));

// Map "METHOD /path" of removed operations back to their old operation ids
// so a declared deprecation can retire exactly one entry.
const operationIds = new Map<string, string>();
for (const [route, methods] of Object.entries(oldDoc.paths)) {
  for (const [method, operation] of Object.entries(methods)) {
    const id = (operation as Record<string, unknown>).operationId;
    if (typeof id === "string") operationIds.set(`${method.toUpperCase()} ${route}`, id);
  }
}

const breaks = diffBreaking(oldDoc, newDoc).filter((violation) => {
  if (!violation.startsWith("operation removed: ")) return true;
  const key = violation.slice("operation removed: ".length);
  return !declared.has(operationIds.get(key) ?? "");
});
if (breaks.length > 0) {
  console.error("Breaking OpenAPI changes detected (000 §5: append-only within a major version):");
  for (const violation of breaks) console.error(`  - ${violation}`);
  process.exit(1);
}
