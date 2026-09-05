import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import type {
  VideoStreamClaim,
  VideoStreamIngestServices,
} from "@pirate/application/video/stream-ingest";
import type { VideoStreamIngestState } from "@pirate/domain";
import { Effect, type Layer, Schema } from "effect";

const Integer = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const Text = Schema.String.check(Schema.isPattern(/^\S(?:.*\S)?$/u));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Row = Schema.Struct({
  effect_identity: Text,
  operation_id: Text,
  submission_id: Text,
  post_id: Text,
  creation_revision: Integer,
  video_revision: Integer,
  analysis_revision: Integer,
  immutable_ref: Text,
  canonical_sha256: Digest,
  claim_fence: Integer,
  ingest_revision: Integer,
  state: Schema.Literals([
    "not_started",
    "sending",
    "bound",
    "ready",
    "failed",
    "reconciliation_required",
  ]),
  creator_marker: Schema.NullOr(Text),
  source_sha256: Schema.NullOr(Digest),
  provider_video_id: Schema.NullOr(Text),
  failure_reason: Schema.NullOr(Text),
  acceptance_deadline_ms: Schema.NullOr(Integer),
  encoding_deadline_ms: Schema.NullOr(Integer),
});

// No payload field participates in authority. Lock the durable facts in the same
// transaction as the claim/write, including the exact immutable-object identity.
const AUTHORITY = `SELECT o.effect_identity,o.operation_id,o.submission_id,o.post_id,
  p.creation_revision::text,p.video_revision::text,p.analysis_revision::text,
  v.immutable_ref,v.canonical_sha256,s.claim_fence::text,s.ingest_revision::text,
  s.state,s.creator_marker,s.source_sha256,s.provider_video_id,s.failure_reason,
  s.acceptance_deadline_ms::text,s.encoding_deadline_ms::text
  FROM media_video_enrichment_outbox o
  JOIN media_video_stream_ingests s ON s.operation_id=o.operation_id
  JOIN media_publication_projections p ON p.operation_id=o.operation_id
    AND p.submission_id=o.submission_id AND p.post_id=o.post_id AND p.media_kind='video'
  JOIN media_video_rights r ON r.submission_id=p.submission_id AND r.rights_basis='original'
  JOIN media_video_revisions v ON v.submission_id=p.submission_id
    AND v.operation_id=p.operation_id AND v.community_id=p.community_id
    AND v.actor_user_id=p.actor_user_id
    AND v.video_revision=p.video_revision AND v.immutable_ref=p.video_asset_ref
    AND v.canonical_sha256=p.canonical_video_sha256
  JOIN media_immutable_objects i ON i.immutable_ref=v.immutable_ref
    AND i.submission_id=v.submission_id AND i.operation_id=v.operation_id
    AND i.community_id=v.community_id AND i.canonical_sha256=v.canonical_sha256
    AND i.actor_user_id=p.actor_user_id AND i.author_persona_id=p.author_persona_id
    AND i.size_bytes=v.size_bytes AND i.content_type=v.content_type
  WHERE o.effect_identity=$1 AND o.enrichment_kind='stream'`;
const LOCK = " FOR UPDATE OF o,s,p,r,v,i";

const decodeClaim = Effect.fn("decodeVideoStreamClaim")(function* (raw: unknown, owner: string) {
  const row = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(Row)(raw),
    catch: () => new Error("Invalid durable video ingest authority"),
  });
  // The spike's literal prefix plus a production operation UUID exceeds 64 bytes.
  // A full SHA-256 marker preserves exact operation identity without truncation.
  const digest = yield* Effect.tryPromise(() =>
    crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`pirate-video-v1:${row.operation_id}`),
    ),
  );
  const creator = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const identity = { operationId: row.operation_id, creator, sourceSha256: row.canonical_sha256 };
  let state: VideoStreamIngestState = { state: "not_started" };
  if (row.state !== "not_started") {
    if (
      row.creator_marker !== creator ||
      row.source_sha256 !== identity.sourceSha256 ||
      row.acceptance_deadline_ms === null ||
      row.encoding_deadline_ms === null
    )
      return yield* Effect.fail(new Error("Invalid durable video ingest identity"));
    const pending = {
      identity,
      acceptanceDeadlineMs: row.acceptance_deadline_ms,
      encodingDeadlineMs: row.encoding_deadline_ms,
    };
    if (row.state === "sending") state = { ...pending, state: "sending" };
    else if (row.state === "reconciliation_required") {
      const reason = row.failure_reason;
      if (
        reason !== "acceptance_unknown" &&
        reason !== "identity_mismatch" &&
        reason !== "multiple_matches" &&
        reason !== "unsafe_delivery"
      )
        return yield* Effect.fail(new Error("Invalid durable video reconciliation"));
      state = { ...pending, state: row.state, reason };
    } else {
      if (row.provider_video_id === null)
        return yield* Effect.fail(new Error("Missing durable video provider identity"));
      if (row.state === "failed") {
        const reason = row.failure_reason;
        if (reason !== "encoding_failed" && reason !== "encoding_timeout")
          return yield* Effect.fail(new Error("Invalid durable video failure"));
        state = { ...pending, state: row.state, providerVideoId: row.provider_video_id, reason };
      } else state = { ...pending, state: row.state, providerVideoId: row.provider_video_id };
    }
  }
  return {
    effectIdentity: row.effect_identity,
    leaseOwner: owner,
    fence: row.claim_fence,
    revision: row.ingest_revision,
    identity,
    sealedSourceRef: row.immutable_ref,
    state,
    authority: {
      submissionId: row.submission_id,
      postId: row.post_id,
      creationRevision: row.creation_revision,
      videoRevision: row.video_revision,
      analysisRevision: row.analysis_revision,
    },
  } satisfies VideoStreamClaim;
});

function sameAuthority(a: VideoStreamClaim, b: VideoStreamClaim): boolean {
  return (
    a.identity.operationId === b.identity.operationId &&
    a.identity.creator === b.identity.creator &&
    a.identity.sourceSha256 === b.identity.sourceSha256 &&
    a.sealedSourceRef === b.sealedSourceRef &&
    a.authority.submissionId === b.authority.submissionId &&
    a.authority.postId === b.authority.postId &&
    a.authority.creationRevision === b.authority.creationRevision &&
    a.authority.videoRevision === b.authority.videoRevision &&
    a.authority.analysisRevision === b.authority.analysisRevision
  );
}

function validTransition(
  claim: VideoStreamClaim,
  next: VideoStreamIngestState,
  release: boolean,
): boolean {
  if (next.state === "not_started") return false;
  if (
    next.identity.operationId !== claim.identity.operationId ||
    next.identity.creator !== claim.identity.creator ||
    next.identity.sourceSha256 !== claim.identity.sourceSha256
  )
    return false;
  const current = claim.state;
  if (current.state === "not_started") return next.state === "sending" && !release;
  if (
    !release ||
    next.acceptanceDeadlineMs !== current.acceptanceDeadlineMs ||
    next.encodingDeadlineMs !== current.encodingDeadlineMs
  )
    return false;
  if (
    current.state === "ready" ||
    current.state === "failed" ||
    current.state === "reconciliation_required"
  )
    return JSON.stringify(current) === JSON.stringify(next);
  if (current.state === "bound" && next.state === "sending") return false;
  if (
    current.state === "bound" &&
    "providerVideoId" in next &&
    current.providerVideoId !== next.providerVideoId
  )
    return false;
  return true;
}

export function makeVideoStreamIngestStore(
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  options: Readonly<{ leaseOwner: string; leaseMs: number }>,
): VideoStreamIngestServices["store"] {
  const owner = Schema.decodeUnknownSync(Text)(options.leaseOwner);
  const leaseMs = Schema.decodeUnknownSync(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(300_000),
    ),
  )(options.leaseMs);
  const claim = Effect.fn("claimVideoStreamIngest")(function* (effectIdentity: string) {
    const db = yield* ControlPlaneDb;
    return yield* db.withTransaction(
      Effect.fn("claimVideoStreamIngest.transaction")(function* (tx) {
        const selected = yield* tx.execute({
          label: "video-ingest.claim-authority",
          text: `${AUTHORITY}
        AND (o.state='pending' OR (o.state='running' AND o.lease_expires_at<=clock_timestamp()))${LOCK}`,
          values: [effectIdentity],
          readonly: false,
        });
        if (selected.rows.length === 0) return null;
        if (selected.rows.length !== 1)
          return yield* Effect.fail(new Error("Ambiguous video ingest authority"));
        const current = yield* decodeClaim(selected.rows[0], owner);
        yield* tx.execute({
          label: "video-ingest.claim",
          text: `UPDATE media_video_enrichment_outbox
        SET state='running',lease_owner=$2,lease_expires_at=clock_timestamp()+$3*interval '1 millisecond',updated_at=clock_timestamp()
        WHERE effect_identity=$1`,
          values: [effectIdentity, owner, leaseMs],
          readonly: false,
        });
        yield* tx.execute({
          label: "video-ingest.fence",
          text: "UPDATE media_video_stream_ingests SET claim_fence=claim_fence+1 WHERE operation_id=$1",
          values: [current.identity.operationId],
          readonly: false,
        });
        return { ...current, fence: current.fence + 1 };
      }),
    );
  });
  const transition = Effect.fn("transitionVideoStreamIngest")(function* (
    input: VideoStreamClaim,
    next: VideoStreamIngestState,
    release: boolean,
  ) {
    const db = yield* ControlPlaneDb;
    return yield* db.withTransaction(
      Effect.fn("transitionVideoStreamIngest.transaction")(function* (tx) {
        const selected = yield* tx.execute({
          label: "video-ingest.transition-authority",
          text: `${AUTHORITY}
        AND o.state='running' AND o.lease_owner=$2 AND o.lease_expires_at>clock_timestamp()
        AND s.claim_fence=$3 AND s.ingest_revision=$4${LOCK}`,
          values: [input.effectIdentity, input.leaseOwner, input.fence, input.revision],
          readonly: false,
        });
        if (selected.rows.length === 0) return null;
        if (selected.rows.length !== 1)
          return yield* Effect.fail(new Error("Ambiguous video ingest authority"));
        const current = yield* decodeClaim(selected.rows[0], owner);
        if (
          input.leaseOwner !== owner ||
          !sameAuthority(input, current) ||
          !validTransition(current, next, release)
        )
          return null;
        if (next.state === "not_started") return null;
        const changed = yield* tx.execute({
          label: "video-ingest.persist",
          text: `UPDATE media_video_stream_ingests
        SET state=$2,creator_marker=$3,source_sha256=$4,provider_video_id=$5,
          acceptance_deadline_ms=$6,encoding_deadline_ms=$7,failure_reason=$8,
          ingest_revision=ingest_revision+1,updated_at=clock_timestamp()
        WHERE operation_id=$1 AND ($9 OR $6>extract(epoch FROM clock_timestamp())*1000)`,
          values: [
            current.identity.operationId,
            next.state,
            next.identity.creator,
            next.identity.sourceSha256,
            "providerVideoId" in next ? next.providerVideoId : null,
            next.acceptanceDeadlineMs,
            next.encodingDeadlineMs,
            "reason" in next ? next.reason : null,
            current.state.state !== "not_started",
          ],
          readonly: false,
        });
        if (changed.rowCount !== 1)
          return yield* Effect.fail(new Error("Video ingest initial deadline expired"));
        const disposition = !release
          ? "running"
          : next.state === "ready"
            ? "ready"
            : next.state === "failed" || next.state === "reconciliation_required"
              ? "failed"
              : "pending";
        const finished = yield* tx.execute({
          label: "video-ingest.release",
          text: `UPDATE media_video_enrichment_outbox
        SET state=$2,lease_owner=CASE WHEN $3 THEN NULL ELSE lease_owner END,
          lease_expires_at=CASE WHEN $3 THEN NULL ELSE lease_expires_at END,updated_at=clock_timestamp()
        WHERE effect_identity=$1 AND lease_expires_at>clock_timestamp()`,
          values: [input.effectIdentity, disposition, release],
          readonly: false,
        });
        if (finished.rowCount !== 1)
          return yield* Effect.fail(new Error("Video ingest lease expired during transition"));
        return { ...current, revision: current.revision + 1, state: next };
      }),
    );
  });
  return {
    claim: (identity) => Effect.runPromise(claim(identity).pipe(Effect.provide(layer))),
    transition: (input, next, release) =>
      Effect.runPromise(transition(input, next, release).pipe(Effect.provide(layer))),
  };
}
