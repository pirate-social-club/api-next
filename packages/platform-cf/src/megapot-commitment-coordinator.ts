import {
  type MegapotCommitmentFailure,
  type MegapotCommitmentProgress,
  MegapotCommitmentRejected,
  type MegapotCommitmentStore,
} from "@pirate/application";
import type { MegapotPublishedSnapshot } from "@pirate/domain";
import { Effect } from "effect";
import { sha256, toBytes } from "viem";

const rejected = (reason: MegapotCommitmentRejected["reason"]) =>
  new MegapotCommitmentRejected({ reason });

export interface MegapotCommitmentSigner {
  readonly sign: (payload: Uint8Array) => Promise<{
    readonly signingKeyId: string;
    readonly signature: string;
  }>;
}

export interface MegapotCommitmentPublisher {
  readonly publish: (input: {
    readonly idempotencyKey: string;
    readonly payload: string;
    readonly payloadHash: string;
    readonly signingKeyId: string;
    readonly signature: string;
  }) => Promise<{
    readonly publicReference: string;
    readonly publishedAt: string;
  }>;
}

function canonicalPayload(snapshot: MegapotPublishedSnapshot): string {
  return JSON.stringify({
    domain: snapshot.domain,
    poolLegId: snapshot.poolLegId,
    drawingId: snapshot.drawingId,
    termsHash: snapshot.termsHash,
    algorithmVersion: snapshot.algorithmVersion,
    fallback: snapshot.fallback,
    leafCount: snapshot.leafCount,
    leafCommitments: snapshot.leafCommitments,
    snapshotHash: snapshot.snapshotHash,
  });
}

export interface MegapotCommitmentCoordinator {
  readonly commit: (input: {
    readonly poolLegId: string;
    readonly drawingId: bigint;
  }) => Effect.Effect<MegapotCommitmentProgress, MegapotCommitmentFailure>;
}

export function makeMegapotCommitmentCoordinator(input: {
  readonly store: MegapotCommitmentStore;
  readonly signer: MegapotCommitmentSigner;
  readonly publisher: MegapotCommitmentPublisher;
  readonly now?: () => number;
}): MegapotCommitmentCoordinator {
  const now = input.now ?? Date.now;
  return {
    commit: Effect.fn("MegapotCommitmentCoordinator.commit")(function* (command) {
      const candidate = yield* input.store.loadCandidate(command);
      const payload = canonicalPayload(candidate.snapshot);
      const payloadHash = sha256(toBytes(payload)).slice(2);
      const commitmentEffectId = `megapot_commitment_${payloadHash}`;
      const existing = yield* input.store.findProgress(commitmentEffectId);
      if (existing?.state === "published") return existing;

      let progress = existing;
      if (progress === null) {
        if (!candidate.canPrepare) return yield* rejected("drawing-not-frozen");
        const signature = yield* Effect.tryPromise({
          try: () => input.signer.sign(toBytes(payload)),
          catch: () => rejected("signer-unavailable"),
        });
        const preparedMilliseconds = now();
        if (!Number.isFinite(preparedMilliseconds)) return yield* rejected("invalid-time");
        const preparedAt = new Date(preparedMilliseconds).toISOString();
        progress = yield* input.store.prepare({
          candidate,
          commitmentEffectId,
          payloadHash,
          signingKeyId: signature.signingKeyId,
          signature: signature.signature,
          preparedAt,
        });
      }
      if (progress.payloadHash !== payloadHash) return yield* rejected("payload-conflict");
      const publication = yield* Effect.tryPromise({
        try: () =>
          input.publisher.publish({
            idempotencyKey: commitmentEffectId,
            payload,
            payloadHash,
            signingKeyId: progress.signingKeyId,
            signature: progress.signature,
          }),
        catch: () => rejected("publication-unavailable"),
      });
      if (
        publication.publicReference.trim().length === 0 ||
        !Number.isFinite(Date.parse(publication.publishedAt)) ||
        Date.parse(publication.publishedAt) < Date.parse(progress.preparedAt)
      ) {
        return yield* rejected("publication-unavailable");
      }
      return yield* input.store.confirmPublished({
        commitmentEffectId,
        payloadHash,
        publicReference: publication.publicReference,
        publishedAt: publication.publishedAt,
      });
    }),
  };
}
