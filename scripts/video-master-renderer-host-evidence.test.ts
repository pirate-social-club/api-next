import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runConcurrencyEvidence,
  runCorruptSourceEvidence,
  runHostLimitEvidence,
} from "./video-master-renderer-host-evidence.ts";

describe("renderer host boundaries", () => {
  let workingDirectory: string;

  beforeAll(async () => {
    workingDirectory = await mkdtemp(join(tmpdir(), "api-video-host-boundary-test-"));
  });

  afterAll(async () => {
    await rm(workingDirectory, { recursive: true, force: true });
  });

  it("rejects corrupt media without exposing the source path or private diagnostic", async () => {
    const evidence = await runCorruptSourceEvidence(workingDirectory);
    expect(evidence.rejected).toBe(true);
    expect(evidence.publicFailure).toEqual({
      code: "invalid_source",
      message: "Video source could not be processed.",
    });
    expect(evidence.internalDiagnosticSha256).toHaveLength(64);
    expect(evidence.publicContainsSourcePath).toBe(false);
    expect(evidence.publicContainsPrivateToken).toBe(false);
  });

  it("kills timed-out and diagnostic-overflow processes and removes attempt storage", async () => {
    const evidence = await runHostLimitEvidence();
    expect(evidence.processTimeoutMs).toBe(150);
    expect(evidence.diagnosticLimitBytes).toBe(1_024);
    expect(evidence.artifactLimitBytes).toBe(1_024);
    expect(evidence.timeoutKilled).toBe(true);
    expect(evidence.diagnosticOverflowKilled).toBe(true);
    expect(evidence.oversizedArtifactRejected).toBe(true);
    expect(evidence.attemptDirectoryRemoved).toBe(true);
  });

  it("never exceeds the configured local concurrency permits", async () => {
    const evidence = await runConcurrencyEvidence();
    expect(evidence.configuredMaximum).toBe(2);
    expect(evidence.observedMaximum).toBe(2);
    expect(evidence.completedTasks).toBe(6);
  });
});
