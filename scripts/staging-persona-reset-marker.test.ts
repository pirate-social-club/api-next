import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResetMarker } from "./staging-persona-reset-marker";
import { STAGING_RESET_RELEASE } from "./staging-persona-reset-plan";

const input = {
  sourceSha: STAGING_RESET_RELEASE.sourceSha,
  recoveryDigest: "b".repeat(64),
  targetAndFenceDigest: "c".repeat(64),
  validUntilMs: Date.now() + 60_000,
};
test("durable marker refuses a second run and persists failure across a new caller", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reset-marker-test-"));
  try {
    const marker = await createResetMarker(directory, input);
    await expect(createResetMarker(directory, input)).rejects.toThrow("restore_required");
    await expect(marker.completeAfterVerification()).rejects.toThrow("verification_required");
    await marker.advance("removing", 1);
    await expect(marker.advance("admitted", 1)).rejects.toThrow("transition_invalid");
    await marker.advance("failed", 1);
    await expect(marker.advance("replaying", 2)).rejects.toThrow("transition_invalid");
    await expect(createResetMarker(directory, input)).rejects.toThrow("restore_required");
    const contents = JSON.parse(
      await readFile(join(directory, "pirate-staging-api-next.reset-in-progress.json"), "utf8"),
    );
    expect(contents.phase).toBe("failed");
    expect(contents.completedBatches).toBe(1);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("only the successful verification path clears its marker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reset-marker-test-"));
  try {
    const marker = await createResetMarker(directory, input);
    await expect(marker.advance("verifying", 0)).rejects.toThrow("transition_invalid");
    await marker.advance("removing", 1);
    await marker.advance("replaying", 2);
    await marker.advance("verifying", 3);
    await marker.completeAfterVerification();
    const fresh = await createResetMarker(directory, input);
    expect(fresh.run).not.toBe(marker.run);
  } finally {
    await rm(directory, { recursive: true });
  }
});
