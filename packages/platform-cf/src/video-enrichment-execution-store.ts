import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import { Effect, type Layer, Schema } from "effect";
import type {
  VideoEnrichmentExecution,
  VideoEnrichmentExecutionStore,
} from "../../application/src/video/enrichment-workflow.ts";

const Row = Schema.Struct({
  effect_identity: Schema.String,
  enrichment_kind: Schema.Literals(["stream", "thumbnail"]),
  workflow_generation: Schema.NumberFromString.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
  ),
  started_ms: Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
const authority = `FROM media_video_enrichment_outbox o
  JOIN media_publication_projections p ON p.operation_id=o.operation_id
    AND p.submission_id=o.submission_id AND p.post_id=o.post_id AND p.media_kind='video'
  JOIN media_video_rights r ON r.submission_id=o.submission_id AND r.rights_basis='original'
  WHERE o.effect_identity=$1 AND o.enrichment_kind IN ('stream','thumbnail')
    AND o.state IN ('pending','running')`;

export function makeVideoEnrichmentExecutionStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): VideoEnrichmentExecutionStore {
  const prepare = Effect.fn("prepareVideoEnrichmentExecution")(function* (identity: string) {
    const db = yield* ControlPlaneDb;
    return yield* db.withTransaction(
      Effect.fn("prepareVideoEnrichmentExecution.transaction")(function* (tx) {
        const locked = yield* tx.execute({
          label: "video-enrichment.execution-lock",
          readonly: false,
          text: `SELECT o.effect_identity ${authority} FOR UPDATE OF o,p,r`,
          values: [identity],
        });
        if (locked.rows.length === 0) return null;
        if (locked.rows.length !== 1)
          return yield* Effect.fail(new Error("Ambiguous enrichment authority"));
        const result = yield* tx.execute({
          label: "video-enrichment.execution-prepare",
          readonly: false,
          text: `UPDATE media_video_enrichment_outbox SET
          workflow_started_at=COALESCE(workflow_started_at,clock_timestamp()),
          workflow_dispatched_at=clock_timestamp()
          WHERE effect_identity=$1 RETURNING effect_identity,enrichment_kind,
          workflow_generation::text,floor(extract(epoch FROM workflow_started_at)*1000)::bigint::text AS started_ms`,
          values: [identity],
        });
        const row = yield* Effect.try(() => Schema.decodeUnknownSync(Row)(result.rows[0]));
        return {
          effectIdentity: row.effect_identity,
          kind: row.enrichment_kind,
          generation: row.workflow_generation,
          startedAtMs: row.started_ms,
        } satisfies VideoEnrichmentExecution;
      }),
    );
  });
  const active = Effect.fn("activeVideoEnrichmentExecution")(function* (
    execution: VideoEnrichmentExecution,
  ) {
    const db = yield* ControlPlaneDb;
    const result = yield* db.execute({
      label: "video-enrichment.execution-active",
      readonly: true,
      text: `SELECT o.effect_identity ${authority} AND o.workflow_generation=$2`,
      values: [execution.effectIdentity, execution.generation],
    });
    return result.rows.length === 1;
  });
  const replace = Effect.fn("replaceVideoEnrichmentExecution")(function* (
    execution: VideoEnrichmentExecution,
  ) {
    const db = yield* ControlPlaneDb;
    const result = yield* db.execute<{ state: string }>({
      label: "video-enrichment.execution-replace",
      readonly: false,
      text: `UPDATE media_video_enrichment_outbox o SET
        workflow_generation=LEAST(workflow_generation+1,2),
        workflow_exhausted=(workflow_generation=2),
        state=CASE WHEN workflow_generation=2 THEN 'failed' ELSE state END,
        lease_owner=CASE WHEN workflow_generation=2 THEN NULL ELSE lease_owner END,
        lease_expires_at=CASE WHEN workflow_generation=2 THEN NULL ELSE lease_expires_at END,
        updated_at=clock_timestamp()
        WHERE effect_identity=$1 AND workflow_generation=$2
        AND (state='pending' OR (state='running' AND lease_expires_at<=clock_timestamp()))
        RETURNING workflow_generation::text,state`,
      values: [execution.effectIdentity, execution.generation],
    });
    if (result.rowCount !== 1) return null;
    // Exhaustion is durable/unavailable, not an eligible row acknowledged forever.
    // Keep the ingest identity and ambiguous provider evidence for reconciliation.
    if (result.rows[0]?.state === "failed") return null;
    return { ...execution, generation: execution.generation + 1 };
  });
  return {
    prepare: (id) => Effect.runPromise(prepare(id).pipe(Effect.provide(runtime))),
    active: (execution) => Effect.runPromise(active(execution).pipe(Effect.provide(runtime))),
    replace: (execution) => Effect.runPromise(replace(execution).pipe(Effect.provide(runtime))),
  };
}
