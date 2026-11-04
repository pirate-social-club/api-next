import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
} from "@pirate/application";
import { validateVideoStageFact } from "@pirate/application/video/stage-facts";
import { Effect, type Layer, Schema } from "effect";

const Text = Schema.NonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,512}$/u));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Requests = Schema.Array(Text).check(Schema.isMinLength(1), Schema.isMaxLength(2));
const Target = Schema.Struct({ submissionId: Text, requestIds: Requests });
const Entry = Schema.Struct({
  request_id: Text,
  operation_id: Text,
  capability: Schema.Literals(["probe", "frames"]),
  event_sequence: Text,
  video_revision: Text,
  creation_revision: Text,
  analysis_revision: Text,
  canonical_video_sha256: Digest,
  source_binding_sha256: Digest,
  provider_job_id_sha256: Digest,
  provider_job_phase: Schema.Literal("started"),
  reconciliation_state: Schema.Literal("required"),
  attempt_sha256: Digest,
  preserved_attempt_sha256: Digest,
  submission_sha256: Digest,
  accepted_fact_sha256: Digest,
});
const Fence = Schema.Struct({
  version: Schema.Literal("video-accepted-analysis-cleanup-v1"),
  submissionId: Text,
  entries: Schema.Array(Entry).check(Schema.isMinLength(1), Schema.isMaxLength(2)),
});

const Row = Schema.Struct({
  ...Entry.fields,
  authority_matches: Schema.Literal(true),
  accepted_fact_matches: Schema.Literal(true),
  fact_snapshot: Schema.Unknown,
});
const RepairedRow = Schema.Struct({
  ...Row.fields,
  reconciliation_state: Schema.Literal("resolved"),
});
const digestSql = (value: string) => `encode(sha256(convert_to(${value},'UTF8')),'hex')`;
const SELECT = `SELECT a.request_id,a.operation_id,a.capability,s.event_sequence::text,
  a.video_revision::text,a.creation_revision::text,a.analysis_revision::text,
  a.canonical_video_sha256,${digestSql("a.provider_job_id")} AS provider_job_id_sha256,
  ${digestSql("jsonb_build_array(to_jsonb(v),to_jsonb(i))::text")} AS source_binding_sha256,
  a.provider_job_phase,a.reconciliation_state,
  ${digestSql("to_jsonb(a)::text")} AS attempt_sha256,
  ${digestSql("(to_jsonb(a)-ARRAY['reconciliation_state','last_observation','reconciliation_evidence_ref','updated_at'])::text")} AS preserved_attempt_sha256,
  ${digestSql("to_jsonb(s)::text")} AS submission_sha256,
  ${digestSql("to_jsonb(f)::text")} AS accepted_fact_sha256,f.fact_snapshot,
  (s.media_kind='video' AND s.status='processing_failed' AND s.post_id IS NULL
    AND s.phase IS NULL AND s.video_revision=a.video_revision
    AND s.creation_revision=a.creation_revision AND s.analysis_revision=a.analysis_revision
    AND s.video_state_snapshot->>'submissionId'=s.submission_id
    AND s.video_state_snapshot->>'operationId'=a.operation_id
    AND s.video_state_snapshot->>'communityId'=s.community_id
    AND s.video_state_snapshot->>'actorAccountId'=s.actor_user_id
    AND s.video_state_snapshot->>'authorPersonaId'=s.author_persona_id
    AND s.video_state_snapshot->>'status'='processing_failed'
    AND s.video_state_snapshot->'reconciliationRequired'='true'::jsonb
    AND (s.video_state_snapshot->>'videoRevision')::bigint=a.video_revision
    AND (s.video_state_snapshot->>'creationRevision')::bigint=a.creation_revision
    AND (s.video_state_snapshot->>'analysisRevision')::bigint=a.analysis_revision
    AND s.video_state_snapshot #>> '{video,canonicalSha256}'=a.canonical_video_sha256
    AND s.video_state_snapshot #>> '{analysis,operationId}'=a.operation_id
    AND (s.video_state_snapshot #>> '{analysis,analysisRevision}')::bigint=a.analysis_revision
    AND (s.video_state_snapshot #>> '{analysis,videoRevision}')::bigint=a.video_revision
    AND s.video_state_snapshot #>> '{analysis,canonicalVideoSha256}'=a.canonical_video_sha256)
    AS authority_matches,
  (f.analysis_revision=a.analysis_revision AND f.stage=a.capability
    AND f.adapter_revision=f.fact_snapshot->>'adapterRevision'
    AND f.stage=f.fact_snapshot->>'stage' AND CASE a.capability
      WHEN 'probe' THEN f.fact_snapshot->'snapshot'=s.video_state_snapshot #> '{analysis,probe}'
      WHEN 'frames' THEN
        f.fact_snapshot #>> '{snapshot,sourceSha256}'=a.canonical_video_sha256
        AND (f.fact_snapshot #>> '{snapshot,videoRevision}')::bigint=a.video_revision
        AND f.fact_snapshot #> '{snapshot,frames}'=s.video_state_snapshot #> '{analysis,frames,extracted}'
        AND f.fact_snapshot #>> '{snapshot,evidenceRef}'=s.video_state_snapshot #>> '{analysis,frames,evidenceRef}'
        AND f.fact_snapshot #>> '{snapshot,adapterRevision}'=s.video_state_snapshot #>> '{analysis,frames,adapterRevision}'
        AND f.fact_snapshot #>> '{snapshot,posterPolicyRevision}'=s.video_state_snapshot #>> '{analysis,frames,posterPolicyRevision}'
      ELSE false END) AS accepted_fact_matches
  FROM media_video_transform_attempts a
  JOIN media_post_submissions s ON s.submission_id=a.submission_id AND s.operation_id=a.operation_id
  JOIN media_video_revisions v ON v.submission_id=s.submission_id AND v.operation_id=s.operation_id
    AND v.video_revision=a.video_revision AND v.community_id=s.community_id
    AND v.actor_user_id=s.actor_user_id AND v.canonical_sha256=a.canonical_video_sha256
    AND v.immutable_ref=s.video_state_snapshot #>> '{video,immutableRef}'
  JOIN media_immutable_objects i ON i.immutable_ref=v.immutable_ref
    AND i.submission_id=s.submission_id AND i.operation_id=s.operation_id
    AND i.community_id=s.community_id AND i.actor_user_id=s.actor_user_id
    AND i.author_persona_id=s.author_persona_id AND i.canonical_sha256=v.canonical_sha256
    AND i.size_bytes=v.size_bytes AND i.content_type=v.content_type
  JOIN media_video_stage_facts f ON f.submission_id=a.submission_id
    AND f.video_revision=a.video_revision AND f.creation_revision=a.creation_revision AND f.stage=a.capability
  WHERE a.submission_id=$1 AND a.request_id=ANY($2::text[])
  ORDER BY a.request_id`;

const read = Effect.fn("readAcceptedAnalysisCleanup")(function* (
  db: Pick<ControlPlaneTransaction, "execute">,
  target: typeof Target.Type,
  lock: boolean,
) {
  if (new Set(target.requestIds).size !== target.requestIds.length)
    throw new Error("duplicate accepted-analysis cleanup request");
  const selected = yield* db.execute({
    label: "video-cleanup.accepted-analysis-read",
    text: `${SELECT}${lock ? " FOR UPDATE OF s,a,f,v,i" : ""}`,
    values: [target.submissionId, target.requestIds],
    readonly: !lock,
  });
  if (selected.rows.length !== target.requestIds.length)
    throw new Error("accepted-analysis cleanup exact request set refused");
  const entries = selected.rows.map((raw) => {
    const row = Schema.decodeUnknownSync(Row)(raw);
    const fact = validateVideoStageFact(row.fact_snapshot);
    if (fact.stage !== row.capability) throw new Error("accepted-analysis cleanup stage refused");
    return Schema.decodeUnknownSync(Entry)(row);
  });
  return {
    version: "video-accepted-analysis-cleanup-v1" as const,
    submissionId: target.submissionId,
    entries,
  };
});

/** Marker-only operator: no provider, artifact, workflow, retry or publication port. */
export function makeAcceptedAnalysisCleanup(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
) {
  const run = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    Effect.runPromise(effect.pipe(Effect.provide(runtime)));
  return {
    preview: (input: unknown) =>
      run(
        Effect.gen(function* () {
          const target = Schema.decodeUnknownSync(Target, { onExcessProperty: "error" })(input);
          const db = yield* ControlPlaneDb;
          return yield* read(db, target, false);
        }),
      ),
    apply: (input: unknown) =>
      run(
        Effect.gen(function* () {
          const expected = Schema.decodeUnknownSync(Fence, { onExcessProperty: "error" })(input);
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction(
            Effect.fn("applyAcceptedAnalysisCleanup")(function* (tx) {
              const current = yield* read(
                tx,
                {
                  submissionId: expected.submissionId,
                  requestIds: expected.entries.map((entry) => entry.request_id),
                },
                true,
              );
              // Both values have the same closed schema and deterministic request ordering.
              if (JSON.stringify(current) !== JSON.stringify(expected))
                throw new Error("accepted-analysis cleanup stale fence refused");
              const changed = yield* tx.execute({
                label: "video-cleanup.accepted-analysis-markers",
                text: `UPDATE media_video_transform_attempts SET reconciliation_state='resolved',
            last_observation=jsonb_build_object('status','completed','observedAt',clock_timestamp(),
              'basis','immutable_accepted_stage_fact'),
            reconciliation_evidence_ref='video-accepted-analysis:' || $3,updated_at=clock_timestamp()
            WHERE submission_id=$1 AND request_id=ANY($2::text[])
              AND reconciliation_state='required' AND provider_job_phase='started'`,
                values: [
                  expected.submissionId,
                  expected.entries.map((entry) => entry.request_id),
                  expected.entries.map((entry) => entry.accepted_fact_sha256).join(":"),
                ],
                readonly: false,
              });
              if (changed.rowCount !== expected.entries.length)
                throw new Error("accepted-analysis cleanup write refused");
              const verified = yield* tx.execute({
                label: "video-cleanup.accepted-analysis-verify",
                text: SELECT,
                values: [expected.submissionId, expected.entries.map((entry) => entry.request_id)],
                readonly: true,
              });
              if (verified.rows.length !== expected.entries.length)
                throw new Error("accepted-analysis cleanup post-state refused");
              for (let index = 0; index < verified.rows.length; index++) {
                const row = Schema.decodeUnknownSync(RepairedRow)(verified.rows[index]);
                validateVideoStageFact(row.fact_snapshot);
                const prior = expected.entries[index];
                if (!prior) throw new Error("accepted-analysis cleanup post-state refused");
                // The remaining attempt fields and every authority/fact hash must be unchanged.
                for (const key of Object.keys(prior) as (keyof typeof prior)[]) {
                  if (key === "attempt_sha256" || key === "reconciliation_state") continue;
                  if (row[key] !== prior[key])
                    throw new Error("accepted-analysis cleanup preservation refused");
                }
              }
              return {
                outcome: "accepted_analysis_markers_resolved" as const,
                submissionId: expected.submissionId,
                requestIds: expected.entries.map((entry) => entry.request_id),
                submission_unchanged: true,
                render_unchanged: true,
                immutable_facts_unchanged: true,
                target_verified: true,
              };
            }),
          );
        }),
      ),
  };
}
