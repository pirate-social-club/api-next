import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import type {
  VideoThumbnailClaim,
  VideoThumbnailServices,
} from "@pirate/application/video/thumbnail-enrichment";
import { Effect, type Layer, Schema } from "effect";
import { readVideoPosterAuthority } from "./video-poster-authority.ts";

const Text = Schema.String.check(Schema.isPattern(/^\S(?:.*\S)?$/u));
const Row = Schema.Struct({ post_id: Text, community_id: Text, artifact_ref: Text });
const AUTHORITY = `SELECT p.post_id,p.community_id,p.poster_artifact_ref AS artifact_ref
  FROM media_video_enrichment_outbox o
  JOIN media_publication_projections p ON p.operation_id=o.operation_id
    AND p.submission_id=o.submission_id AND p.post_id=o.post_id AND p.media_kind='video'
  JOIN media_video_rights r ON r.submission_id=p.submission_id AND r.rights_basis='original'
  WHERE o.effect_identity=$1 AND o.enrichment_kind='thumbnail'`;

function samePoster(a: VideoThumbnailClaim, b: VideoThumbnailClaim): boolean {
  return (
    a.postId === b.postId &&
    a.communityId === b.communityId &&
    a.artifactRef === b.artifactRef &&
    a.sha256 === b.sha256 &&
    a.sourceSha256 === b.sourceSha256 &&
    a.policyRevision === b.policyRevision
  );
}

export function makeVideoThumbnailStore(
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  options: Readonly<{ leaseMs: number }>,
): VideoThumbnailServices["store"] {
  const leaseMs = Schema.decodeUnknownSync(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(300_000),
    ),
  )(options.leaseMs);
  const claim = Effect.fn("claimVideoThumbnail")(function* (effectIdentity: string) {
    const db = yield* ControlPlaneDb;
    return yield* db.withTransaction(
      Effect.fn("claimVideoThumbnail.transaction")(function* (tx) {
        const result = yield* tx.execute({
          label: "video-thumbnail.claim-authority",
          text: `${AUTHORITY} AND (o.state='pending' OR
          (o.state='running' AND o.lease_expires_at<=clock_timestamp())) FOR UPDATE OF o,p,r`,
          values: [effectIdentity],
          readonly: false,
        });
        if (result.rows.length === 0) return null;
        if (result.rows.length !== 1)
          return yield* Effect.fail(new Error("Ambiguous thumbnail authority"));
        const row = yield* Effect.try(() => Schema.decodeUnknownSync(Row)(result.rows[0]));
        const identity = {
          postId: row.post_id,
          communityId: row.community_id,
          artifactRef: row.artifact_ref,
        };
        const poster = yield* readVideoPosterAuthority(identity, tx, true);
        if (poster === null) return yield* Effect.fail(new Error("Missing thumbnail authority"));
        // Never reuse a worker identity as a fencing token. A fresh acquisition
        // fences an expired callback even when both run in the same worker.
        const leaseToken = crypto.randomUUID();
        const changed = yield* tx.execute({
          label: "video-thumbnail.claim",
          text: `UPDATE media_video_enrichment_outbox SET state='running',lease_owner=$2,
          lease_expires_at=clock_timestamp()+$3*interval '1 millisecond',updated_at=clock_timestamp()
          WHERE effect_identity=$1 AND enrichment_kind='thumbnail' AND
          (state='pending' OR (state='running' AND lease_expires_at<=clock_timestamp()))`,
          values: [effectIdentity, leaseToken, leaseMs],
          readonly: false,
        });
        if (changed.rowCount !== 1) return yield* Effect.fail(new Error("Thumbnail claim lost"));
        return {
          effectIdentity,
          leaseToken,
          ...identity,
          sha256: poster.sha256,
          sourceSha256: poster.sourceSha256,
          policyRevision: poster.policyRevision,
        } satisfies VideoThumbnailClaim;
      }),
    );
  });
  const complete = Effect.fn("completeVideoThumbnail")(function* (
    input: VideoThumbnailClaim,
    state: "ready" | "failed",
  ) {
    const db = yield* ControlPlaneDb;
    return yield* db.withTransaction(
      Effect.fn("completeVideoThumbnail.transaction")(function* (tx) {
        const result = yield* tx.execute({
          label: "video-thumbnail.completion-authority",
          text: `${AUTHORITY} AND o.state='running' AND o.lease_owner=$2
          AND o.lease_expires_at>clock_timestamp() FOR UPDATE OF o,p,r`,
          values: [input.effectIdentity, input.leaseToken],
          readonly: false,
        });
        if (result.rows.length === 0) return false;
        if (result.rows.length !== 1)
          return yield* Effect.fail(new Error("Ambiguous thumbnail authority"));
        const row = yield* Effect.try(() => Schema.decodeUnknownSync(Row)(result.rows[0]));
        const identity = {
          postId: row.post_id,
          communityId: row.community_id,
          artifactRef: row.artifact_ref,
        };
        const poster = yield* readVideoPosterAuthority(identity, tx, true);
        if (poster === null || !samePoster(input, { ...input, ...identity, ...poster }))
          return false;
        const changed = yield* tx.execute({
          label: "video-thumbnail.complete",
          text: `UPDATE media_video_enrichment_outbox SET state=$3,lease_owner=NULL,
          lease_expires_at=NULL,updated_at=clock_timestamp()
          WHERE effect_identity=$1 AND enrichment_kind='thumbnail' AND state='running'
            AND lease_owner=$2 AND lease_expires_at>clock_timestamp()`,
          values: [input.effectIdentity, input.leaseToken, state],
          readonly: false,
        });
        return changed.rowCount === 1;
      }),
    );
  });
  return {
    claim: (identity) => Effect.runPromise(claim(identity).pipe(Effect.provide(layer))),
    complete: (input, state) =>
      Effect.runPromise(complete(input, state).pipe(Effect.provide(layer))),
  };
}
