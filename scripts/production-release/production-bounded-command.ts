import assert from "node:assert/strict";
import { superviseProductionTimeout } from "./production-bounded-process.ts";
import { admitted } from "./production-release-admission.ts";
import { checkGenesis, fileHash, JOURNAL_DIR, PACKAGE } from "./production-operation-evidence.ts";
import { WEBSITE_EXECUTOR } from "./production-release-paths.ts";

async function main() {
  const [adapter, mode, argument] = Bun.argv.slice(2);
  assert.ok(typeof adapter === "string" && typeof mode === "string");
  assert.ok((adapter === "database" && ["migrate", "grants", "resolve"].includes(mode)) || (["worker", "website"].includes(adapter) && mode === "apply"));
  if (adapter === "worker") assert.ok(argument && ["gateway", "media", "http", "jobs"].includes(argument));
  if (adapter === "database" && mode !== "resolve") assert.equal(argument, undefined);
  if (adapter === "website") assert.equal(argument, undefined);
  if (mode === "resolve") assert.ok(argument?.startsWith("/"));
  assert.ok(Bun.argv.length <= 5, "Unexpected command arguments");
  const executor = adapter === "website" ? WEBSITE_EXECUTOR : PACKAGE + "production-" + adapter + "-cutover.ts";
  const executorSha = fileHash(executor);
  const { review, admissionSha, reviewSha } = admitted(mode, executorSha, false, 190_000);
  const executorKey = adapter === "database" ? "backend_executor_sha256" : adapter === "worker" ? "worker_executor_sha256" : "website_executor_sha256";
  assert.equal(review[executorKey], executorSha);
  assert.equal(review.outer_wrapper_sha256, fileHash(new URL(import.meta.url))); checkGenesis(review);
  await superviseProductionTimeout({ journalDirectory: JOURNAL_DIR, wrapperPath: PACKAGE + "production-bounded-command.ts",
    wrapperArguments: Bun.argv.slice(2), argv: [process.execPath, executor, mode, ...(argument ? [argument] : [])], mode,
    executorSha256: executorSha, admissionSha256: admissionSha, reviewSha256: reviewSha, executionTools: review.execution_tools });
}

if (import.meta.main) main().catch(() => {
  console.error("Bounded production operation refused or unresolved; preserve evidence. No automatic retry."); process.exitCode = 1;
});
