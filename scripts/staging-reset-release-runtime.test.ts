import { expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  KaraokeReleaseSurface,
  KaraokeSurfaceReceipt,
} from "./staging-karaoke-release-operation.ts";
import { createReleaseMarker } from "./staging-persona-reset-marker.ts";
import {
  STAGING_UPGRADE_ORDINALS,
  STAGING_UPGRADE_RELEASE,
} from "./staging-persona-upgrade-plan.ts";

// The reset is mocked so the composition's ordering, marker lifecycle and
// failure semantics can be exercised without a PostgreSQL cluster. The real
// reset is proved against the disposable cluster in
// staging-persona-phased-reset.pg.test.ts.
let makeReset: () => object = () => {
  throw new Error("reset fixture not armed");
};
const actualPhasedReset = await import("./staging-persona-phased-reset.ts");
mock.module("./staging-persona-phased-reset.ts", () => ({
  ...actualPhasedReset,
  readCompletedStagingReset: actualPhasedReset.readCompletedStagingReset,
  reconstructStagingInPhases: async () => makeReset(),
}));

const {
  StagingResetRunUnresolved,
  reconstructAndReleaseStaging,
  StagingUpgradeFailedRestoreRequired,
} = await import("./staging-reset-release-runtime.ts");

const upgradeVersions = (() => {
  return STAGING_UPGRADE_ORDINALS.map((ordinal, index) => {
    if (index === 0) return STAGING_UPGRADE_RELEASE.firstUpgradeVersion;
    if (index === STAGING_UPGRADE_ORDINALS.length - 1)
      return STAGING_UPGRADE_RELEASE.terminalVersion;
    return `${String(ordinal).padStart(4, "0")}_fixture_migration.sql`;
  });
})();

const receipt = {
  sourceSha: STAGING_UPGRADE_RELEASE.sourceSha,
  manifestSha256: STAGING_UPGRADE_RELEASE.manifestSha256,
  fromVersion: "0119_hns_root_health_renewal.sql",
  toVersion: STAGING_UPGRADE_RELEASE.terminalVersion,
  applied: upgradeVersions,
};

const plan = {
  version: "staging-karaoke-release-plan-v2",
  ingressApplicationId: "a".repeat(32),
  resumeQueues: [{ name: "queue", id: "b".repeat(32) }],
  servingWorkers: [{ worker: "fixture-worker", versionId: "c".repeat(32) }],
  reviewedGrantDigest: "d".repeat(64),
  surfaceOrder: ["versions", "database", "ingress", "producers"],
};

async function harness(
  options: {
    upgradeFails?: boolean;
    badReceipt?: boolean;
    databaseFails?: boolean;
    completionInterrupts?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const refenced: string[] = [];
  let clock = 0;
  const now = () => new Date(Date.UTC(2026, 8, 12, 12, 0, clock++)).toISOString();
  let resetAttempted = false;
  let markerDurableBeforeCompletion = false;
  const markerDirectory = await mkdtemp(join(tmpdir(), "release-marker-test-"));
  const markerPath = join(markerDirectory, "pirate-staging-api-next.release-in-progress.json");
  makeReset = () => ({
    async completeAfterPairedRelease(verifyServingPair: () => Promise<void>) {
      if (resetAttempted) throw new Error("reset_release_retry_forbidden_restore_required");
      resetAttempted = true;
      calls.push("reset:completion");
      // The replacement marker must be durable before the reset hook retires
      // the original, so an interruption here cannot leave neither.
      markerDurableBeforeCompletion = await readFile(markerPath, "utf8").then(
        () => true,
        () => false,
      );
      if (options.completionInterrupts) throw new Error("interrupted at the handoff");
      await verifyServingPair();
    },
  });
  const make =
    (surface: KaraokeReleaseSurface) =>
    async (_directive: unknown, at: () => string): Promise<KaraokeSurfaceReceipt> => {
      calls.push(`surface:${surface}`);
      if (options.databaseFails && surface === "database")
        throw new Error("grant restoration failed");
      return { surface, releasedAt: at(), receipt: `${surface}-receipt` };
    };
  const run = () =>
    reconstructAndReleaseStaging({
      database: {} as never,
      artifacts: {} as never,
      admission: {
        markerDirectory,
        targetAndFenceDigest: "e".repeat(64),
        validUntilMs: Date.now() + 600_000,
      } as never,
      release: {
        plan,
        now,
        surfaces: {
          versions: make("versions"),
          database: make("database"),
          ingress: make("ingress"),
          producers: make("producers"),
        },
        acceptance: async () => {
          calls.push("acceptance");
        },
        refence: {
          async database() {
            refenced.push("database");
          },
          async ingress() {
            refenced.push("ingress");
          },
          async producers() {
            refenced.push("producers");
          },
        },
      },
      upgrade: {
        async apply() {
          calls.push("upgrade");
          if (options.upgradeFails) throw new Error("migration apply failed");
          if (options.badReceipt) return { ...receipt, applied: receipt.applied.slice(0, -1) };
          return receipt;
        },
      },
    });
  return {
    calls,
    refenced,
    markerDirectory,
    markerPath,
    markerDurableBeforeCompletion: () => markerDurableBeforeCompletion,
    dispose: () => rm(markerDirectory, { recursive: true, force: true }),
    run,
  };
}

test("the upgrade applies after reset completion and before grant restoration", async () => {
  const h = await harness();
  try {
    const result = await h.run();
    expect(result.release.disposition).toBe("released");
    expect(result.upgrade).toEqual(receipt);
    // Versions activate while every fence is held; completion proves the 0119
    // ledger and retires the reset marker; the upgrade then reaches the
    // reviewed terminal before the database surface compiles grants against
    // it. The release marker is retired only after reconciliation, and nothing
    // is re-fenced on success.
    expect(h.calls).toEqual([
      "surface:versions",
      "reset:completion",
      "upgrade",
      "surface:database",
      "surface:ingress",
      "acceptance",
      "surface:producers",
    ]);
    expect(h.refenced).toEqual([]);
    expect(h.markerDurableBeforeCompletion()).toBe(true);
    await expect(readFile(h.markerPath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await h.dispose();
  }
});

test("an upgrade failure preserves the fences, leaves the marker, and never reaches grants", async () => {
  const h = await harness({ upgradeFails: true });
  try {
    await h.run();
    throw new Error("expected an upgrade failure");
  } catch (error) {
    expect(error).toBeInstanceOf(StagingUpgradeFailedRestoreRequired);
    if (!(error instanceof StagingUpgradeFailedRestoreRequired)) throw error;
    expect(error.message).toBe("staging_upgrade_failed_restore_required");
    expect(error.stage).toBe("apply");
    expect((error.cause as Error).message).toBe("migration apply failed");
    expect(error.outcome.receipts.map((entry) => entry.surface)).toEqual(["versions"]);
    const marker = JSON.parse(await readFile(h.markerPath, "utf8")) as { phase: string };
    expect(marker.phase).toBe("failed");
  } finally {
    expect(h.calls).toEqual(["surface:versions", "reset:completion", "upgrade"]);
    // The database fence is already the reset's denied state; re-fencing it is
    // the executor's fixed-target policy, while ingress and producers were never
    // attempted and must not be touched.
    expect(h.refenced).toEqual(["database"]);
    await h.dispose();
  }
});

test("a receipt that does not reach the reviewed terminal is refused as its own stage", async () => {
  const h = await harness({ badReceipt: true });
  try {
    await h.run();
    throw new Error("expected a receipt refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(StagingUpgradeFailedRestoreRequired);
    if (!(error instanceof StagingUpgradeFailedRestoreRequired)) throw error;
    expect(error.stage).toBe("receipt");
    expect((error.cause as Error).message).toBe("staging_upgrade_receipt_mismatch");
  } finally {
    expect(h.calls).toEqual(["surface:versions", "reset:completion", "upgrade"]);
    await h.dispose();
  }
});

test("a reconciliation failure after the upgrade carries the receipt and leaves the marker", async () => {
  const h = await harness({ databaseFails: true });
  try {
    await h.run();
    throw new Error("expected an unresolved release");
  } catch (error) {
    expect(error).toBeInstanceOf(StagingResetRunUnresolved);
    if (!(error instanceof StagingResetRunUnresolved)) throw error;
    expect(error.upgrade).toEqual(receipt);
    expect(error.outcome.failedSurface).toBe("database");
    const marker = JSON.parse(await readFile(h.markerPath, "utf8")) as { phase: string };
    expect(marker.phase).toBe("failed");
  } finally {
    expect(h.calls).toEqual([
      "surface:versions",
      "reset:completion",
      "upgrade",
      "surface:database",
    ]);
    expect(h.refenced).toEqual(["database"]);
    await h.dispose();
  }
});

test("a marker left by an interrupted window refuses before reconstruction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "release-marker-test-"));
  try {
    await createReleaseMarker(directory, {
      targetAndFenceDigest: "e".repeat(64),
      validUntilMs: Date.now() + 600_000,
    });
    makeReset = () => {
      throw new Error("reset must not run");
    };
    await expect(
      reconstructAndReleaseStaging({
        database: {} as never,
        artifacts: {} as never,
        admission: {
          markerDirectory: directory,
          targetAndFenceDigest: "e".repeat(64),
          validUntilMs: Date.now() + 600_000,
        } as never,
        release: {
          plan,
          surfaces: {} as never,
          acceptance: async () => {},
          refence: {} as never,
        },
        upgrade: { apply: async () => receipt },
      }),
    ).rejects.toThrow("release_marker_exists_restore_required");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an interruption at the completion handoff leaves durable release evidence", async () => {
  const h = await harness({ completionInterrupts: true });
  try {
    await h.run();
    throw new Error("expected an interrupted run");
  } catch (error) {
    expect(error).toBeInstanceOf(StagingResetRunUnresolved);
  } finally {
    // The reset marker was retired by the hook before the throw; the release
    // marker written first is the remaining evidence, and it stays `upgrading`
    // because no upgrade stage was entered.
    const marker = JSON.parse(await readFile(h.markerPath, "utf8")) as { phase: string };
    expect(marker.phase).toBe("upgrading");
    expect(h.markerDurableBeforeCompletion()).toBe(true);
    // A fresh invocation refuses on the retained marker before reconstruction,
    // so it cannot mutate anything.
    const callsBefore = [...h.calls];
    await expect(h.run()).rejects.toThrow("release_marker_exists_restore_required");
    expect(h.calls).toEqual(callsBefore);
    await h.dispose();
  }
});

test("the finished composition cannot run the upgrade twice", async () => {
  const h = await harness();
  try {
    const result = await h.run();
    await expect(result.reset.completeAfterPairedRelease(async () => {})).rejects.toThrow(
      "reset_release_retry_forbidden_restore_required",
    );
    expect(h.calls.filter((call) => call === "upgrade")).toHaveLength(1);
  } finally {
    await h.dispose();
  }
});
