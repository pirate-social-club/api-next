import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertReleaseMarkerAbsent,
  assertResetMarkerAbsent,
  createReleaseMarker,
  createResetMarker,
} from "./staging-persona-reset-marker";
import { STAGING_RESET_RELEASE } from "./staging-persona-reset-plan";

const input = {
  sourceSha: STAGING_RESET_RELEASE.sourceSha,
  recoveryDigest: "b".repeat(64),
  targetAndFenceDigest: "c".repeat(64),
  validUntilMs: Date.now() + 60_000,
};
test("early marker check refuses malformed files, broken symlinks and filesystem errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reset-marker-test-"));
  const path = join(directory, "pirate-staging-api-next.reset-in-progress.json");
  try {
    await expect(assertResetMarkerAbsent(directory)).resolves.toBeUndefined();
    await writeFile(path, "malformed");
    await expect(assertResetMarkerAbsent(directory)).rejects.toThrow("restore_required");
    await expect(assertResetMarkerAbsent(path)).rejects.toThrow("unreadable_restore_required");
    await rm(path);
    await symlink(join(directory, "absent"), path);
    await expect(assertResetMarkerAbsent(directory)).rejects.toThrow("restore_required");
  } finally {
    await rm(directory, { recursive: true });
  }
});

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

const releaseInput = { targetAndFenceDigest: "c".repeat(64), validUntilMs: Date.now() + 60_000 };

test("the release marker survives an interrupted window and refuses an overlap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "release-marker-test-"));
  const path = join(directory, "pirate-staging-api-next.release-in-progress.json");
  try {
    await expect(assertReleaseMarkerAbsent(directory)).resolves.toBeUndefined();
    const marker = await createReleaseMarker(directory, releaseInput);
    await expect(createReleaseMarker(directory, releaseInput)).rejects.toThrow("restore_required");
    await expect(marker.completeAfterReconciliation()).rejects.toThrow("reconciliation_required");
    await expect(
      marker.advance("reconciling", {
        appliedMigrations: 0,
        upgradeSourceSha: null,
        upgradeManifestSha256: null,
      }),
    ).rejects.toThrow("transition_invalid");
    await expect(
      marker.advance("reconciling", {
        appliedMigrations: 1,
        upgradeSourceSha: "a".repeat(40),
        upgradeManifestSha256: null,
      }),
    ).rejects.toThrow("transition_invalid");
    await marker.advance("reconciling", {
      appliedMigrations: 47,
      upgradeSourceSha: "a".repeat(40),
      upgradeManifestSha256: "b".repeat(64),
    });
    await expect(
      marker.advance("reconciling", {
        appliedMigrations: 47,
        upgradeSourceSha: "a".repeat(40),
        upgradeManifestSha256: "b".repeat(64),
      }),
    ).rejects.toThrow("transition_invalid");
    const contents = JSON.parse(await readFile(path, "utf8")) as {
      phase: string;
      appliedMigrations: number;
    };
    expect(contents.phase).toBe("reconciling");
    expect(contents.appliedMigrations).toBe(47);
    await expect(assertReleaseMarkerAbsent(directory)).rejects.toThrow("restore_required");
    await marker.completeAfterReconciliation();
    await expect(assertReleaseMarkerAbsent(directory)).resolves.toBeUndefined();
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("a failed release marker keeps its identity and cannot be completed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "release-marker-test-"));
  try {
    const marker = await createReleaseMarker(directory, releaseInput);
    await marker.advance("failed", {
      appliedMigrations: 47,
      upgradeSourceSha: "a".repeat(40),
      upgradeManifestSha256: "b".repeat(64),
    });
    await expect(marker.completeAfterReconciliation()).rejects.toThrow("reconciliation_required");
    await expect(
      marker.advance("reconciling", {
        appliedMigrations: 47,
        upgradeSourceSha: "a".repeat(40),
        upgradeManifestSha256: "b".repeat(64),
      }),
    ).rejects.toThrow("transition_invalid");
  } finally {
    await rm(directory, { recursive: true });
  }
});
