import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { superviseProductionTimeout } from "../production-bounded-process.ts";
import { fileHash } from "../production-operation-evidence.ts";

async function main() {
  const [directory, scenario] = Bun.argv.slice(2);
  assert.ok(directory?.startsWith("/") && scenario);
  const wrapperPath = fileURLToPath(import.meta.url);
  const childPath = fileURLToPath(new URL("./process-qualification-child.ts", import.meta.url));
  const executionTools = {
    bun_sha256: fileHash(process.execPath),
    timeout_sha256: fileHash("/usr/bin/timeout"),
  };
  writeFileSync(
    join(directory, "fixture-context.json"),
    JSON.stringify({
      directory,
      scenario,
      wrapperPath,
      childPath,
      executionTools,
      executorSha: fileHash(childPath),
      admissionSha: "a".repeat(64),
      reviewSha: "b".repeat(64),
    }),
  );
  await superviseProductionTimeout({
    journalDirectory: directory,
    wrapperPath,
    wrapperArguments: Bun.argv.slice(2),
    argv: [process.execPath, childPath, directory, scenario],
    mode: "qualify",
    executorSha256: fileHash(childPath),
    admissionSha256: "a".repeat(64),
    reviewSha256: "b".repeat(64),
    executionTools,
  });
}

if (import.meta.main)
  main().catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
  });
