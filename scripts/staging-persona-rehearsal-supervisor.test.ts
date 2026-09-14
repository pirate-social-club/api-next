import { expect, test } from "bun:test";
import {
  providerDiagnosticEnvironment,
  resolveDiagnosticIntent,
} from "./staging-persona-diagnostic-mode.ts";
import { superviseRehearsalProcess } from "./staging-persona-rehearsal-supervisor.ts";
import {
  REHEARSAL_BRANCH_LIFETIME_MS,
  REHEARSAL_CLEANUP_MARGIN_MS,
  REHEARSAL_PROCESS_TIMEOUT_MS,
  REHEARSAL_SUPERVISOR_TIMEOUT_MS,
  REHEARSAL_VALIDITY_MS,
} from "./staging-persona-rehearsal-timing.ts";

const completed =
  'console.log(JSON.stringify({event:"staging_rehearsal_completed",mode:"dry-run"}));';

function observe(source: string, timeoutMs = 5_000) {
  const child = Bun.spawn([process.execPath, "-e", source], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return superviseRehearsalProcess(child, "dry-run", { timeoutMs, report: () => {} });
}

test("requires a terminal record and a successful real child exit", async () => {
  await observe(completed);
  await expect(observe("")).rejects.toThrow("rehearsal_completion_unproven");
  await expect(observe('console.log("phase began")')).rejects.toThrow(
    "rehearsal_completion_unproven",
  );
  await expect(observe(`${completed} process.exitCode=1;`)).rejects.toThrow(
    "rehearsal_process_failed",
  );
});

test("rejects a mismatched mode or duplicate completion instead of accepting ambiguous evidence", async () => {
  await expect(observe(completed.replace('mode:"dry-run"', 'mode:"execute"'))).rejects.toThrow(
    "rehearsal_completion_unproven",
  );
  await expect(observe(completed + completed)).rejects.toThrow("rehearsal_completion_unproven");
});

test("terminates a stalled child at the deadline without retry", async () => {
  await expect(observe("setInterval(()=>{},1000)", 100)).rejects.toThrow(
    "rehearsal_process_deadline_exceeded",
  );
});

test("the supervisor reasserts diagnostic intent after secret injection", () => {
  expect(providerDiagnosticEnvironment({ STAGING_REHEARSAL_DIAGNOSTIC: "1" }, false)).toMatchObject(
    { STAGING_REHEARSAL_DIAGNOSTIC: "0" },
  );
  expect(providerDiagnosticEnvironment({ STAGING_REHEARSAL_DIAGNOSTIC: "0" }, true)).toMatchObject({
    STAGING_REHEARSAL_DIAGNOSTIC: "1",
  });
  expect(resolveDiagnosticIntent("--execute", "--diagnostic").diagnostic).toBe(true);
  expect(resolveDiagnosticIntent("--execute", "--no-diagnostic").diagnostic).toBe(false);
  expect(() => resolveDiagnosticIntent("--dry-run", "--diagnostic")).toThrow(
    "rehearsal_diagnostic_mode_invalid",
  );
});

test("the measured provider workload has a bounded process and cleanup window", () => {
  expect(REHEARSAL_PROCESS_TIMEOUT_MS).toBe(225 * 60_000);
  expect(REHEARSAL_VALIDITY_MS).toBe(240 * 60_000);
  expect(REHEARSAL_SUPERVISOR_TIMEOUT_MS).toBe(REHEARSAL_VALIDITY_MS);
  expect(REHEARSAL_CLEANUP_MARGIN_MS).toBe(15 * 60_000);
  expect(REHEARSAL_BRANCH_LIFETIME_MS).toBe(360 * 60_000);
  expect(REHEARSAL_PROCESS_TIMEOUT_MS).toBeLessThan(REHEARSAL_VALIDITY_MS);
  expect(REHEARSAL_VALIDITY_MS).toBeLessThan(REHEARSAL_BRANCH_LIFETIME_MS);
});
