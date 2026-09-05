import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import { VIDEO_POSTER_POLICY_V1 } from "@pirate/domain";
import { Effect, type Layer, Schema } from "effect";

export interface VideoPosterIdentity {
  readonly postId: string;
  readonly communityId: string;
  readonly artifactRef: string;
}

const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const Revision = Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/u));
const PosterRow = Schema.Struct({
  operation_id: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,200}$/u)),
  video_revision: Revision,
  analysis_revision: Revision,
  artifact_ref: Schema.String,
  canonical_sha256: Digest,
  source_sha256: Digest,
  poster_policy_revision: Schema.Literal(String(VIDEO_POSTER_POLICY_V1.policyRevision)),
});

export interface VideoPosterAuthority {
  readonly artifactRef: string;
  readonly key: string;
  readonly sha256: string;
  readonly sourceSha256: string;
  readonly policyRevision: string;
}

/** Storage identity only. The shared application authorization must run first. */
const resolve = Effect.fn("resolveVideoPosterAuthority")(function* (input: VideoPosterIdentity) {
  const db = yield* ControlPlaneDb;
  const result = yield* db.execute({
    label: "video-access.poster-authority",
    text: `SELECT pub.operation_id, pub.video_revision::text, pub.analysis_revision::text,
        a.artifact_ref, a.canonical_sha256, pub.canonical_video_sha256 AS source_sha256,
        v.analysis_snapshot->'frames'->>'posterPolicyRevision' AS poster_policy_revision
      FROM media_publication_projections pub
      JOIN media_video_derived_artifacts a ON a.submission_id=pub.submission_id
        AND a.video_revision=pub.video_revision AND a.analysis_revision=pub.analysis_revision
        AND a.artifact_kind='poster' AND a.artifact_ref=pub.poster_artifact_ref
      JOIN media_video_analyses v ON v.submission_id=pub.submission_id
        AND v.community_id=pub.community_id AND v.operation_id=pub.operation_id
        AND v.video_revision=pub.video_revision AND v.analysis_revision=pub.analysis_revision
        AND v.canonical_video_sha256=pub.canonical_video_sha256
      WHERE pub.post_id=$1 AND pub.community_id=$2 AND pub.media_kind='video'
        AND pub.poster_artifact_ref=$3`,
    values: [input.postId, input.communityId, input.artifactRef],
    readonly: true,
  });
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) return yield* Effect.fail(new Error("Ambiguous poster authority"));
  const row = yield* Effect.try(() => Schema.decodeUnknownSync(PosterRow)(result.rows[0]));
  const key = `video-analysis/${row.operation_id}/v${row.video_revision}/a${row.analysis_revision}/poster.jpg`;
  // Never turn a client locator into a bucket key by stripping a URI prefix.
  if (row.artifact_ref !== input.artifactRef || row.artifact_ref !== `media://derived/${key}`)
    return yield* Effect.fail(new Error("Invalid poster authority"));
  return {
    artifactRef: row.artifact_ref,
    key,
    sha256: row.canonical_sha256,
    sourceSha256: row.source_sha256,
    policyRevision: row.poster_policy_revision,
  } satisfies VideoPosterAuthority;
});

export function makeVideoPosterAuthority(
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
) {
  return (input: VideoPosterIdentity) => resolve(input).pipe(Effect.provide(layer));
}
