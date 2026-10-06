import { describe, expect, test } from "bun:test";
import type {
  MegapotCommitmentCandidate,
  MegapotCommitmentProgress,
  MegapotCommitmentStore,
} from "@pirate/application";
import { RewardOperationsPaused } from "@pirate/application";
import { MEGAPOT_BENEFICIARY_ALGORITHM_VERSION, MEGAPOT_SNAPSHOT_DOMAIN } from "@pirate/domain";
import { Effect } from "effect";
import { makeMegapotCommitmentCoordinator } from "./megapot-commitment-coordinator.ts";

const snapshotHash = `0x${"11".repeat(32)}`;
const candidate: MegapotCommitmentCandidate = {
  poolLegId: "pool-leg-1",
  drawingId: 100n,
  drawingVersion: 2,
  canPrepare: true,
  snapshotId: "snapshot-100",
  snapshot: {
    domain: MEGAPOT_SNAPSHOT_DOMAIN,
    poolLegId: "pool-leg-1",
    drawingId: "100",
    termsHash: `0x${"22".repeat(32)}`,
    algorithmVersion: MEGAPOT_BENEFICIARY_ALGORITHM_VERSION,
    fallback: false,
    leafCount: 1,
    leafCommitments: [`0x${"33".repeat(32)}`],
    snapshotHash,
  },
};

function memoryStore(): {
  readonly store: MegapotCommitmentStore;
  readonly progress: () => MegapotCommitmentProgress | null;
} {
  let current: MegapotCommitmentProgress | null = null;
  return {
    progress: () => current,
    store: {
      loadCandidate: () => Effect.succeed(candidate),
      findProgress: () => Effect.succeed(current),
      prepare: (input) => {
        current = {
          commitmentEffectId: input.commitmentEffectId,
          poolLegId: input.candidate.poolLegId,
          drawingId: input.candidate.drawingId,
          drawingVersion: input.candidate.drawingVersion,
          snapshotId: input.candidate.snapshotId,
          snapshot: input.candidate.snapshot,
          payloadHash: input.payloadHash,
          signingKeyId: input.signingKeyId,
          signature: input.signature,
          state: "prepared",
          preparedAt: input.preparedAt,
          publishedAt: null,
          publicReference: null,
        };
        return Effect.succeed(current);
      },
      confirmPublished: (input) => {
        if (current === null) throw new Error("commitment was not prepared");
        current = {
          ...current,
          state: "published",
          publishedAt: input.publishedAt,
          publicReference: input.publicReference,
          drawingVersion: 3,
        };
        return Effect.succeed(current);
      },
    },
  };
}

describe("Megapot commitment coordinator", () => {
  test("persists before publication and replays the published commitment", async () => {
    const memory = memoryStore();
    const calls: string[] = [];
    const coordinator = makeMegapotCommitmentCoordinator({
      authority: { ensure: () => Effect.void },
      store: memory.store,
      signer: {
        sign: async (payload) => {
          calls.push(`sign:${payload.byteLength}`);
          return { signingKeyId: "commitment-key-v1", signature: "signature-v1" };
        },
      },
      publisher: {
        publish: async (input) => {
          expect(memory.progress()?.state).toBe("prepared");
          calls.push(`publish:${input.idempotencyKey}`);
          return {
            publicReference: `https://commitments.example.invalid/${input.idempotencyKey}`,
            publishedAt: "2026-08-26T12:00:01.000Z",
          };
        },
      },
      now: () => Date.parse("2026-08-26T12:00:00.000Z"),
    });
    const first = await Effect.runPromise(
      coordinator.commit({ poolLegId: candidate.poolLegId, drawingId: candidate.drawingId }),
    );
    const replay = await Effect.runPromise(
      coordinator.commit({ poolLegId: candidate.poolLegId, drawingId: candidate.drawingId }),
    );
    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      state: "published",
      signingKeyId: "commitment-key-v1",
      signature: "signature-v1",
      drawingVersion: 3,
    });
    expect(calls.filter((call) => call.startsWith("sign:"))).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith("publish:"))).toHaveLength(1);
  });

  test("retains the prepared row when publication is unavailable", async () => {
    const memory = memoryStore();
    const coordinator = makeMegapotCommitmentCoordinator({
      authority: { ensure: () => Effect.void },
      store: memory.store,
      signer: {
        sign: async () => ({ signingKeyId: "commitment-key-v1", signature: "signature-v1" }),
      },
      publisher: { publish: async () => Promise.reject(new Error("offline")) },
      now: () => Date.parse("2026-08-26T12:00:00.000Z"),
    });
    await expect(
      Effect.runPromise(
        coordinator.commit({ poolLegId: candidate.poolLegId, drawingId: candidate.drawingId }),
      ),
    ).rejects.toMatchObject({ reason: "publication-unavailable" });
    expect(memory.progress()).toMatchObject({ state: "prepared" });
  });
});

describe("Megapot commitment under a run lease", () => {
  const paused = () => Effect.fail(new RewardOperationsPaused({ reason: "paused" }));
  const command = { poolLegId: candidate.poolLegId, drawingId: candidate.drawingId };
  const at = { now: () => Date.parse("2026-08-26T12:00:00.000Z") };
  const published = async (input: { idempotencyKey: string }) => ({
    publicReference: `https://commitments.example.invalid/${input.idempotencyKey}`,
    publishedAt: "2026-08-26T12:00:01.000Z",
  });

  test("authority is asked before the signature and again before publication", async () => {
    const memory = memoryStore();
    const order: string[] = [];
    const coordinator = makeMegapotCommitmentCoordinator({
      ...at,
      authority: { ensure: () => Effect.sync(() => void order.push("authority")) },
      store: memory.store,
      signer: {
        sign: async () => {
          order.push("sign");
          return { signingKeyId: "commitment-key-v1", signature: "signature-v1" };
        },
      },
      publisher: {
        publish: async (input) => {
          order.push("publish");
          return published(input);
        },
      },
    });
    await Effect.runPromise(coordinator.commit(command));
    expect(order).toEqual(["authority", "sign", "authority", "publish"]);
  });

  test("without authority nothing is signed, stored or published", async () => {
    const memory = memoryStore();
    let calls = 0;
    const coordinator = makeMegapotCommitmentCoordinator({
      ...at,
      authority: { ensure: paused },
      store: memory.store,
      signer: {
        sign: async () => {
          calls += 1;
          return { signingKeyId: "commitment-key-v1", signature: "signature-v1" };
        },
      },
      publisher: {
        publish: async (input) => {
          calls += 1;
          return published(input);
        },
      },
    });
    await expect(Effect.runPromise(coordinator.commit(command))).rejects.toMatchObject({
      _tag: "RewardOperationsPaused",
    });
    expect(calls).toBe(0);
    expect(memory.progress()).toBeNull();
  });

  test("a commitment signed before expiry is not published after it, and is not called unavailable", async () => {
    const memory = memoryStore();
    let live = true;
    let publications = 0;
    const coordinator = makeMegapotCommitmentCoordinator({
      ...at,
      authority: { ensure: () => Effect.suspend(() => (live ? Effect.void : paused())) },
      store: memory.store,
      signer: {
        sign: async () => {
          // The lease lapses once the signature exists.
          live = false;
          return { signingKeyId: "commitment-key-v1", signature: "signature-v1" };
        },
      },
      publisher: {
        publish: async (input) => {
          publications += 1;
          return published(input);
        },
      },
    });
    await expect(Effect.runPromise(coordinator.commit(command))).rejects.toMatchObject({
      _tag: "RewardOperationsPaused",
    });
    expect(publications).toBe(0);
    expect(memory.progress()).toMatchObject({ state: "prepared" });
    // Resumed after expiry: still held. Resumed with authority: published, not re-signed.
    await expect(Effect.runPromise(coordinator.commit(command))).rejects.toMatchObject({
      _tag: "RewardOperationsPaused",
    });
    live = true;
    expect(await Effect.runPromise(coordinator.commit(command))).toMatchObject({
      state: "published",
      signature: "signature-v1",
    });
    expect(publications).toBe(1);
  });
});
