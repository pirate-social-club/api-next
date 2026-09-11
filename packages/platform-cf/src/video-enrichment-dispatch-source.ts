import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import type { VideoEnrichmentDispatchSource } from "@pirate/application/video/enrichment-dispatch";
import { Effect, type Layer, Schema } from "effect";

const Row = Schema.Struct({ effect_identity: Schema.String.check(Schema.isPattern(/^\S+$/u)) });

export function makeVideoEnrichmentDispatchSource(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): VideoEnrichmentDispatchSource {
  const list = Effect.fn("listEligibleVideoEnrichment")(function* (limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      return yield* Effect.fail(new Error("Invalid video enrichment dispatch limit"));
    const db = yield* ControlPlaneDb;
    const result = yield* db.execute({
      label: "video-enrichment.list-eligible",
      readonly: true,
      text: `SELECT o.effect_identity FROM media_video_enrichment_outbox o
        JOIN media_publication_projections p ON p.operation_id=o.operation_id
          AND p.submission_id=o.submission_id AND p.post_id=o.post_id AND p.media_kind='video'
        JOIN media_video_rights r ON r.submission_id=o.submission_id
          AND r.rights_basis IN ('original','derivative')
        WHERE o.enrichment_kind IN ('stream','thumbnail')
          AND (o.state='pending' OR (o.state='running' AND o.lease_expires_at<=clock_timestamp()))
        ORDER BY o.workflow_dispatched_at NULLS FIRST,o.created_at,o.effect_identity LIMIT $1`,
      values: [limit],
    });
    return yield* Effect.try(() =>
      result.rows.map((row) => ({
        effectIdentity: Schema.decodeUnknownSync(Row)(row).effect_identity,
      })),
    );
  });
  return { listEligible: (limit) => Effect.runPromise(list(limit).pipe(Effect.provide(runtime))) };
}
