import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSystemRuntime } from "./staging-persona-rehearsal-launch";
import { createResetMarker } from "./staging-persona-reset-marker";
import { STAGING_RESET_RELEASE } from "./staging-persona-reset-plan";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitForFile(path: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(50);
  return existsSync(path);
}

test("launcher state directories satisfy the reset marker's owner-only boundary", async () => {
  // The r12 rehearsal failed with reset_marker_directory_untrusted because the
  // launcher pre-created the branch state directory under a group-readable
  // umask (0775) and the marker module refuses any directory with group or
  // other bits. This proves the launcher's own mkdir now produces the
  // owner-only directory the real marker boundary requires.
  const root = mkdtempSync(join(tmpdir(), "launch-marker-"));
  const runtime = createSystemRuntime("review-marker-mode");
  const markerDirectory = join(root, "branch-id");
  const evidence = join(markerDirectory, "evidence");
  runtime.mkdir(evidence);
  expect(statSync(markerDirectory).mode & 0o077).toBe(0);
  expect(statSync(evidence).mode & 0o077).toBe(0);
  await expect(
    createResetMarker(markerDirectory, {
      sourceSha: STAGING_RESET_RELEASE.sourceSha,
      recoveryDigest: "a".repeat(64),
      targetAndFenceDigest: "b".repeat(64),
      validUntilMs: Date.now() + 60_000,
    }),
  ).resolves.toBeDefined();
  rmSync(root, { recursive: true, force: true });
});

test("the supervisor deadline kills and joins the whole owned process tree", async () => {
  const directory = mkdtempSync(join(tmpdir(), "launch-tree-"));
  const pidFile = join(directory, "grandchild.pid");
  const runtime = createSystemRuntime("review-tree-deadline");
  const result = await runtime.runSupervisor(
    ["bash", "-c", `sleep 300 & echo $! > ${pidFile}; wait`],
    { env: process.env, timeoutMs: 1_500, logPath: join(directory, "tree.log") },
  );
  expect(result.timedOut).toBe(true);
  expect(await waitForFile(pidFile, 2_000)).toBe(true);
  const grandchild = Number(readFileSync(pidFile, "utf8").trim());
  expect(Number.isInteger(grandchild)).toBe(true);
  expect(alive(grandchild)).toBe(false);
  rmSync(directory, { recursive: true, force: true });
});

test("launcher termination stops and joins an active supervisor tree", async () => {
  const directory = mkdtempSync(join(tmpdir(), "launch-tree-"));
  const pidFile = join(directory, "grandchild.pid");
  const runtime = createSystemRuntime("review-tree-signal");
  const running = runtime.runSupervisor(["bash", "-c", `sleep 300 & echo $! > ${pidFile}; wait`], {
    env: process.env,
    timeoutMs: 60_000,
    logPath: join(directory, "tree.log"),
  });
  expect(await waitForFile(pidFile, 2_000)).toBe(true);
  const grandchild = Number(readFileSync(pidFile, "utf8").trim());
  expect(await runtime.terminateSupervisor?.()).toBe(true);
  const result = await running;
  expect(result.treeAlive).toBeUndefined();
  expect(alive(grandchild)).toBe(false);
  rmSync(directory, { recursive: true, force: true });
});
