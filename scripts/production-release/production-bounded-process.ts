import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { linuxProcess } from "./production-linux-process-bound.ts";
import { exclusiveRecord, fileHash } from "./production-operation-evidence.ts";

export interface ProductionBoundedCommand {
  readonly journalDirectory: string;
  readonly wrapperPath: string;
  readonly wrapperArguments: readonly string[];
  readonly argv: readonly string[];
  readonly mode: string;
  readonly executorSha256: string;
  readonly admissionSha256: string;
  readonly reviewSha256: string;
  readonly executionTools: { readonly bun_sha256: string; readonly timeout_sha256: string };
}

/** Shared production handshake, qualified with harmless committed children. This is not admission. */
export async function superviseProductionTimeout(input: ProductionBoundedCommand) {
  const id = randomUUID(),
    name = "outer-" + id + "-start.json";
  const wrapper = linuxProcess(process.pid);
  assert.equal(wrapper.executable_sha256, input.executionTools.bun_sha256);
  exclusiveRecord(input.journalDirectory, name, {
    kind: "website-release-outer-start-v2",
    at: new Date().toISOString(),
    mode: input.mode,
    argv: input.argv,
    wrapper_identity: wrapper,
    wrapper_arguments: input.wrapperArguments,
    executor_sha256: input.executorSha256,
    wrapper_sha256: fileHash(input.wrapperPath),
    admission_sha256: input.admissionSha256,
    review_sha256: input.reviewSha256,
    timeout_ms: 180_000,
    kill_after_ms: 10_000,
  });
  const startPath = join(input.journalDirectory, name);
  let status: number | null = null,
    signal: string | null = null;
  let completion: Promise<void> | undefined,
    spawnFailed = false;
  try {
    const child = spawn(
      "/usr/bin/timeout",
      ["--signal=TERM", "--kill-after=10s", "180s", ...input.argv],
      {
        cwd: input.journalDirectory,
        env: { ...process.env, PIRATE_RELEASE_OUTER_START_PATH: startPath },
        stdio: "inherit",
      },
    );
    completion = new Promise<void>((resolve) => {
      child.once("error", () => {
        spawnFailed = true;
        resolve();
      });
      child.once("exit", (code, observed) => {
        status = code;
        signal = observed;
        resolve();
      });
    });
    let identity: ReturnType<typeof linuxProcess> | undefined;
    const until = process.hrtime.bigint() + 1_000_000_000n;
    while (process.hrtime.bigint() < until && child.pid && child.exitCode === null) {
      try {
        const observed = linuxProcess(child.pid);
        if (
          observed.executable === realpathSync("/usr/bin/timeout") &&
          observed.ppid === process.pid &&
          observed.pgrp === observed.pid
        ) {
          identity = observed;
          break;
        }
      } catch {
        /* Observe only this owned PID while exec completes. */
      }
      await delay(5);
    }
    assert.ok(identity, "Owned timeout identity unavailable; child admission must refuse");
    assert.equal(identity.executable_sha256, input.executionTools.timeout_sha256);
    exclusiveRecord(input.journalDirectory, "outer-" + id + "-child.json", {
      kind: "website-release-timeout-child-v1",
      at: new Date().toISOString(),
      start_sha256: fileHash(startPath),
      timeout_identity: identity,
    });
    await completion;
    assert.equal(spawnFailed, false, "Timeout process could not start");
  } finally {
    if (completion) await completion.catch(() => undefined);
    exclusiveRecord(input.journalDirectory, "outer-" + id + "-end.json", {
      at: new Date().toISOString(),
      start_sha256: fileHash(startPath),
      exit_status: status,
      signal,
    });
  }
  assert.equal(
    status,
    0,
    "Bounded command did not complete normally; preserve evidence, never retry automatically",
  );
  return { startPath, status };
}
