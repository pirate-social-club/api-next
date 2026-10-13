// Internal v3 composition only. Existing v2 coordinator and frozen ports remain unchanged.
import { MegapotCommitmentRejected, type ControlPlaneError, type RewardOperationsPaused, type RewardRunAuthorityUnavailable } from "@pirate/application";
import type { OwnerMegapotDrawingKey, OwnerMegapotCommitmentRead, OwnerMegapotCommitmentProgress, OwnerMegapotSettlementStore } from "@pirate/application/owner-megapot-settlement";
import { Effect } from "effect";
import { sha256, toBytes } from "viem";
import type { MegapotCommitmentSigner, MegapotCommitmentPublisher } from "./megapot-commitment-coordinator.ts";
import type { RewardRunAuthority } from "./reward-operations-control.ts";

type Failure = ControlPlaneError | MegapotCommitmentRejected | RewardOperationsPaused | RewardRunAuthorityUnavailable;
export function makeOwnerMegapotCommitmentCoordinator(input: {
  readonly store: OwnerMegapotSettlementStore;
  readonly signer: MegapotCommitmentSigner;
  readonly publisher: MegapotCommitmentPublisher;
  readonly authority: RewardRunAuthority;
}) {
  const fail = (reason: MegapotCommitmentRejected["reason"]) => new MegapotCommitmentRejected({ reason });
  const publicPayload = (record: OwnerMegapotCommitmentRead): string => {
    const s = record.snapshot;
    // Exhaustive public fields only. Owner/account/persona/salt/credential and
    // association metadata cannot reach signing, publication, logs or payload.
    return JSON.stringify({ domain: s.domain, poolLegId: s.poolLegId, drawingId: s.drawingId,
      termsHash: s.termsHash, algorithmVersion: s.algorithmVersion, fallback: s.fallback,
      leafCount: s.leafCount, leafCommitments: s.leafCommitments, snapshotHash: s.snapshotHash });
  };
  const commit = Effect.fn("OwnerMegapotCommitment.commit")(function* (key: OwnerMegapotDrawingKey): Effect.fn.Return<OwnerMegapotCommitmentProgress, Failure> {
    let record = yield* input.store.readCommitment(key);
    const payload = publicPayload(record), payloadHash = sha256(toBytes(payload)).slice(2);
    const originalId = `megapot_commitment_${payloadHash}`;
    if (record.progress?.state === "published") {
      if (record.progress.commitmentEffectId !== originalId || record.progress.payloadHash !== payloadHash)
        return yield* Effect.fail(fail("payload-conflict"));
      return record.progress;
    }
    if (record.progress === null) {
      if (!record.canPrepare) return yield* Effect.fail(fail("drawing-not-frozen"));
      yield* input.authority.ensure();
      const signature = yield* Effect.tryPromise({ try: () => input.signer.sign(toBytes(payload)), catch: () => fail("signer-unavailable") });
      record = yield* input.store.prepareCommitment({ ...key, snapshotId: record.snapshotId, payload, payloadHash,
        signingKeyId: signature.signingKeyId, signature: signature.signature });
    }
    const retained = record.progress;
    if (retained === null || retained.commitmentEffectId !== originalId || retained.payloadHash !== payloadHash)
      return yield* Effect.fail(fail("payload-conflict"));
    if (retained.state === "published") return retained;
    // No SQL transaction spans either external action. An unknown publication
    // stays prepared; a deliberate retry reuses this exact retained signature
    // and public idempotency key, never a new snapshot/draw/beneficiary set.
    yield* input.authority.ensure();
    const observed = yield* Effect.tryPromise({ try: () => input.publisher.publish({ idempotencyKey: originalId,
      payload, payloadHash, signingKeyId: retained.signingKeyId, signature: retained.signature }), catch: () => fail("publication-unavailable") });
    if (observed.publicReference.trim() === "" || !Number.isFinite(Date.parse(observed.publishedAt))
      || Date.parse(observed.publishedAt) < Date.parse(retained.preparedAt)) return yield* Effect.fail(fail("publication-unavailable"));
    const actual = yield* input.store.confirmPublished({ ...key, commitmentEffectId: originalId, payloadHash,
      publicReference: observed.publicReference, publishedAt: observed.publishedAt });
    if (actual.progress === null || actual.progress.state !== "published") return yield* Effect.fail(fail("publication-unavailable"));
    return actual.progress;
  });
  return Object.freeze({ commit });
}
