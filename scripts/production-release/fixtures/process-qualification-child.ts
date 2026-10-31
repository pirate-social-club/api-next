import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { validateOuterProcessExecution } from "../production-release-admission.ts";
import { fileHash } from "../production-operation-evidence.ts";
import { checkBoundProcess } from "../production-linux-process-bound.ts";

async function main() {
  const [directory, scenario] = Bun.argv.slice(2); assert.ok(directory && scenario);
  const context = JSON.parse(readFileSync(join(directory, "fixture-context.json"), "utf8"));
  const startPath = process.env.PIRATE_RELEASE_OUTER_START_PATH;
  const review = { outer_wrapper_sha256: fileHash(context.wrapperPath), execution_tools: { ...context.executionTools } };
  if (scenario === "wrong-tool") review.execution_tools.bun_sha256 = "0".repeat(64);
  let accepted = false, failure = "";
  try {
    validateOuterProcessExecution({ mode: "qualify", executor: context.executorSha, admissionSha: context.admissionSha,
      reviewSha: context.reviewSha, review, now: Date.now(), startPath, journalDirectory: directory, wrapperPath: context.wrapperPath });
    if (scenario === "wrong-argv") {
      const start = JSON.parse(readFileSync(startPath as string, "utf8"));
      const child = JSON.parse(readFileSync((startPath as string).replace(/-start\.json$/u, "-child.json"), "utf8"));
      checkBoundProcess({ ...start, argv: [...start.argv, "foreign"] }, child, context.wrapperPath, review);
    }
    accepted = true;
  } catch (error) { failure = error instanceof Error ? error.message : "refused"; }
  const direct = process.env.QUALIFICATION_DIRECT_CHILD === "1";
  const filename = direct ? "direct-result-" + process.pid + ".json" : "fixture-result.json";
  writeFileSync(join(directory, filename), JSON.stringify({ accepted, failure, startPath, pid: process.pid }));
  if (direct || !accepted) return;
  if (scenario === "descendant") {
    const start = JSON.parse(readFileSync(startPath as string, "utf8"));
    const child = Bun.spawn(start.argv, { env: { ...process.env, QUALIFICATION_DIRECT_CHILD: "1" }, stdout: "pipe", stderr: "pipe" });
    assert.equal(await child.exited, 0);
    const result = JSON.parse(readFileSync(join(directory, "direct-result-" + child.pid + ".json"), "utf8"));
    assert.equal(result.accepted, false);
    writeFileSync(join(directory, "descendant-result.json"), JSON.stringify(result));
  }
  if (scenario === "hold") {
    const until = Date.now() + 10_000;
    while (!existsSync(join(directory, "fixture-stop")) && Date.now() < until) await delay(10);
    assert.ok(existsSync(join(directory, "fixture-stop")), "Qualification hold expired");
  }
}

if (import.meta.main) main().catch(error => { console.error(String(error)); process.exitCode = 1; });
