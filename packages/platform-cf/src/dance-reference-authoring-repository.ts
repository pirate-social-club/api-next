import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
} from "@pirate/application";
import { freezeDanceReferenceInput } from "@pirate/application/dance/reference-processing";
import {
  type ClearDancePresentationResponse,
  type DanceReferenceAction,
  type DanceReferenceActionReplay,
  type DanceReferenceAuthoringAuthority,
  type DanceReferenceStore,
  DanceReferenceStoreError,
  type SetDancePresentationResponse,
} from "@pirate/application/use-cases/dance/reference-services";
import {
  AppendDanceChoreographyRevision,
  ClearSongDancePresentation,
  CreateDanceChoreography,
  DisableDanceChoreography,
  GetDanceChoreographyProcessing,
  GetDanceChoreographyRevision,
  ListReadyDanceChoreographies,
  RetireDanceChoreography,
  SetSongDancePresentation,
} from "@pirate/contracts";
import { Effect, type Layer, Schema } from "effect";

type Row = Readonly<Record<string, unknown>>;
type Failure = DanceReferenceStoreError | ControlPlaneError;
type Executor = Pick<ControlPlaneTransaction, "execute">;

const fail = (
  operation: DanceReferenceStoreError["operation"],
  reason: DanceReferenceStoreError["reason"],
) => new DanceReferenceStoreError({ operation, reason });

const text = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value !== "string") throw fail("action", "invalid-row");
  return value;
};

const nullableText = (row: Row, key: string): string | null => {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") throw fail("action", "invalid-row");
  return value;
};

const integer = (row: Row, key: string): number => {
  const value = row[key];
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[0-9]+$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed)) throw fail("action", "invalid-row");
  return parsed;
};

const nullableInteger = (row: Row, key: string): number | null =>
  row[key] === null ? null : integer(row, key);

const instant = (row: Row, key: string): string => {
  const value = row[key];
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (date === null || !Number.isFinite(date.getTime())) throw fail("action", "invalid-row");
  return date.toISOString();
};

const nullableInstant = (row: Row, key: string): string | null =>
  row[key] === null ? null : instant(row, key);

const bytesText = (value: unknown): string | null =>
  value instanceof Uint8Array ? new TextDecoder().decode(value) : null;

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

async function sha256(value: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(canonicalValue(value)));
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoded)));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalValue(record[key])]),
    );
  }
  return value;
}

const identifier = async (prefix: string, value: unknown): Promise<string> =>
  `${prefix}-${await sha256(value)}`;

function decodeResponse<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
  operation: DanceReferenceStoreError["operation"],
): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
  } catch {
    throw fail(operation, "invalid-row");
  }
}

function choreography(row: Row) {
  return {
    object: "dance_choreography" as const,
    choreography_id: text(row, "choreography_id"),
    song_post_id: text(row, "song_post_id"),
    creator_persona_id: text(row, "creator_persona_id"),
    status: text(row, "choreography_status"),
    active_revision: nullableInteger(row, "active_revision"),
    created_at: instant(row, "choreography_created_at"),
    disabled_at: nullableInstant(row, "disabled_at"),
    retired_at: nullableInstant(row, "retired_at"),
  };
}

function segment(row: Row) {
  if (row.segment_id === null) return null;
  return {
    segment_id: text(row, "segment_id"),
    song_post_id: text(row, "song_post_id"),
    audio_revision: integer(row, "audio_revision"),
    start_ms: integer(row, "segment_start_ms"),
    end_ms: integer(row, "segment_end_ms"),
    duration_ms: integer(row, "segment_duration_ms"),
    canonical_segment_sha256: text(row, "canonical_segment_sha256"),
    extraction_policy_version: text(row, "extraction_policy_version"),
    segment_terms_hash: text(row, "segment_terms_hash"),
  };
}

function processing(row: Row) {
  return {
    object: "dance_reference_processing" as const,
    choreography_id: text(row, "choreography_id"),
    revision: integer(row, "revision"),
    song_post_id: text(row, "song_post_id"),
    audio_revision: integer(row, "audio_revision"),
    reference_video_post_id: text(row, "reference_video_post_id"),
    start_ms: integer(row, "requested_start_ms"),
    end_ms: integer(row, "requested_end_ms"),
    mirror_policy: text(row, "mirror_policy"),
    status: text(row, "revision_status"),
    segment: segment(row),
    reference_video_scored_start_ms: nullableInteger(row, "reference_video_scored_start_ms"),
    reference_video_scored_end_ms: nullableInteger(row, "reference_video_scored_end_ms"),
    processing_failure_code: nullableText(row, "processing_failure_code"),
    revision_terms_hash: text(row, "revision_terms_hash"),
    created_at: instant(row, "revision_created_at"),
    terminal_at: nullableInstant(row, "terminal_at"),
  };
}

const privateProjectionSql = `SELECT c.choreography_id,c.song_post_id,c.creator_persona_id,
       c.status AS choreography_status,c.active_revision,c.created_at AS choreography_created_at,
       c.disabled_at,c.retired_at,r.revision,r.audio_revision,r.reference_video_post_id,
       r.requested_start_ms,r.requested_end_ms,r.mirror_policy,r.status AS revision_status,
       r.reference_video_scored_start_ms,r.reference_video_scored_end_ms,
       r.processing_failure_code,r.revision_terms_hash,r.created_at AS revision_created_at,
       r.terminal_at,s.segment_id,s.start_ms AS segment_start_ms,s.end_ms AS segment_end_ms,
       s.duration_ms AS segment_duration_ms,s.canonical_segment_sha256,
       s.extraction_policy_version,s.segment_terms_hash
  FROM dance_choreographies c
  JOIN dance_choreography_revisions r ON r.choreography_id=c.choreography_id
  LEFT JOIN dance_song_segments s ON s.segment_id=r.segment_id`;

function publicRevision(row: Row) {
  const selectedSegment = segment(row);
  if (selectedSegment === null) throw fail("get-revision", "invalid-row");
  return {
    object: "dance_choreography_revision" as const,
    choreography_id: text(row, "choreography_id"),
    revision: integer(row, "revision"),
    song_post_id: text(row, "song_post_id"),
    audio_revision: integer(row, "audio_revision"),
    segment: selectedSegment,
    readiness: "ready" as const,
    mirror_policy: text(row, "mirror_policy"),
    reference_video: {
      post_id: text(row, "reference_video_post_id"),
      href: `/communities/${encodeURIComponent(text(row, "community_id"))}/posts/${encodeURIComponent(
        text(row, "reference_video_post_id"),
      )}`,
    },
    creator_persona: {
      object: "persona" as const,
      persona_id: text(row, "creator_persona_id"),
      display_name: nullableText(row, "display_name"),
      avatar_ref: nullableText(row, "avatar_ref"),
      primary_public_handle: nullableText(row, "primary_public_handle"),
    },
    is_active_revision: row.is_active_revision === true,
    featured: row.featured === true,
    revision_terms_hash: text(row, "revision_terms_hash"),
    created_at: instant(row, "revision_created_at"),
    ready_at: instant(row, "terminal_at"),
  };
}

const publicProjectionSql = `SELECT r.choreography_id,r.revision,r.community_id,r.song_post_id,
       r.audio_revision,r.reference_video_post_id,r.mirror_policy,r.revision_terms_hash,
       r.created_at AS revision_created_at,r.terminal_at,c.creator_persona_id,
       (c.active_revision=r.revision) AS is_active_revision,
       EXISTS (SELECT 1 FROM song_dance_presentations p
                WHERE p.community_id=r.community_id AND p.song_post_id=r.song_post_id
                  AND p.audio_revision=r.audio_revision
                  AND p.featured_choreography_id=r.choreography_id
                  AND p.featured_choreography_revision=r.revision) AS featured,
       s.segment_id,s.start_ms AS segment_start_ms,s.end_ms AS segment_end_ms,
       s.duration_ms AS segment_duration_ms,s.canonical_segment_sha256,
       s.extraction_policy_version,s.segment_terms_hash,
       profile.display_name,profile.avatar_ref,handle.label_display AS primary_public_handle
  FROM dance_choreography_revisions r
  JOIN dance_choreographies c ON c.choreography_id=r.choreography_id
  JOIN dance_song_segments s ON s.segment_id=r.segment_id
  LEFT JOIN persona_profiles profile ON profile.persona_id=c.creator_persona_id
  LEFT JOIN LATERAL (
    SELECT candidate.label_display FROM public_handle_index candidate
     WHERE candidate.owner_persona_id=c.creator_persona_id AND candidate.status='active'
     ORDER BY candidate.updated_at DESC,candidate.handle_id LIMIT 1
  ) handle ON true`;

function actionLock(tx: ControlPlaneTransaction, action: DanceReferenceAction) {
  return tx.execute({
    label: "dance-reference.action.lock",
    text: "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
    values: [
      `dance-action:${action.actorAccountId}:${action.httpMethod}:${action.endpointTemplate}:${action.idempotencyKey}`,
    ],
    readonly: false,
  });
}

function lookupActionEffect(
  executor: Executor,
  action: DanceReferenceAction,
): Effect.Effect<DanceReferenceActionReplay, Failure> {
  return Effect.gen(function* () {
    const result = yield* executor.execute<Row>({
      label: "dance-reference.action.lookup",
      text: "SELECT request_hash,response_snapshot FROM dance_reference_actions WHERE actor_account_id=$1 AND http_method=$2 AND endpoint_template=$3 AND idempotency_key=$4",
      values: [
        action.actorAccountId,
        action.httpMethod,
        action.endpointTemplate,
        action.idempotencyKey,
      ],
      readonly: true,
    });
    if (result.rows.length === 0) return { kind: "miss" };
    if (result.rows.length !== 1) return yield* Effect.fail(fail("action", "invalid-row"));
    const row = result.rows[0] as Row;
    if (text(row, "request_hash") !== action.requestHash) return { kind: "conflict" };
    const snapshot = bytesText(row.response_snapshot);
    if (snapshot === null) return yield* Effect.fail(fail("action", "invalid-row"));
    return yield* Effect.try({
      try: () => ({ kind: "replay" as const, response: JSON.parse(snapshot) as unknown }),
      catch: () => fail("action", "invalid-row"),
    });
  });
}

function storeAction(
  tx: ControlPlaneTransaction,
  action: DanceReferenceAction,
  response: unknown,
  references: Readonly<{
    readonly choreographyId?: string;
    readonly choreographyRevision?: number;
    readonly presentationRevision?: number;
  }>,
) {
  const snapshot = JSON.stringify(response);
  return tx.execute({
    label: "dance-reference.action.insert",
    text: `INSERT INTO dance_reference_actions (
             actor_account_id,http_method,endpoint_template,idempotency_key,request_hash,
             result_kind,response_snapshot,response_snapshot_sha256,choreography_id,
             choreography_revision,presentation_revision
           ) VALUES ($1,$2,$3,$4,$5,'accepted',convert_to($6,'UTF8'),
             encode(sha256(convert_to($6,'UTF8')),'hex'),$7,$8,$9)`,
    values: [
      action.actorAccountId,
      action.httpMethod,
      action.endpointTemplate,
      action.idempotencyKey,
      action.requestHash,
      snapshot,
      references.choreographyId ?? null,
      references.choreographyRevision ?? null,
      references.presentationRevision ?? null,
    ],
    readonly: false,
  });
}

function replayed<S extends { readonly replayed: boolean }>(response: S): S {
  return { ...response, replayed: true };
}

function authorityValid(
  authority: DanceReferenceAuthoringAuthority,
  audioRevision: number,
  referenceVideoPostId: string,
  startMs: number,
  endMs: number,
): boolean {
  return (
    authority.canonicalAudio.audioRevision === audioRevision &&
    authority.referenceVideo.postId === referenceVideoPostId &&
    Number.isSafeInteger(startMs) &&
    Number.isSafeInteger(endMs) &&
    startMs >= 0 &&
    endMs > startMs &&
    endMs <= authority.canonicalAudio.durationMs
  );
}

type GraphInput = Readonly<{
  readonly choreographyId: string;
  readonly revision: number;
  readonly aggregateVersion: number;
  readonly communityId: string;
  readonly songPostId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly mirrorPolicy: "strict" | "allowed";
  readonly authority: DanceReferenceAuthoringAuthority;
}>;

function insertProcessingGraph(
  tx: ControlPlaneTransaction,
  input: GraphInput,
): Effect.Effect<ReturnType<typeof processing>, Failure> {
  return Effect.gen(function* () {
    if (
      !authorityValid(
        input.authority,
        input.authority.canonicalAudio.audioRevision,
        input.authority.referenceVideo.postId,
        input.startMs,
        input.endMs,
      )
    ) {
      return yield* Effect.fail(fail("create", "invalid-input"));
    }
    const publication = yield* tx.execute<Row>({
      label: "dance-reference.authority.song",
      text: "SELECT submission_id,audio_revision,audio_asset_ref,canonical_audio_sha256 FROM media_publication_projections WHERE community_id=$1 AND post_id=$2 AND audio_revision=$3 FOR SHARE",
      values: [input.communityId, input.songPostId, input.authority.canonicalAudio.audioRevision],
      readonly: false,
    });
    if (publication.rows.length !== 1) {
      return yield* Effect.fail(fail("create", "not-found"));
    }
    const publicationRow = publication.rows[0] as Row;
    if (
      text(publicationRow, "audio_asset_ref") !== input.authority.canonicalAudio.objectKey ||
      text(publicationRow, "canonical_audio_sha256") !== input.authority.canonicalAudio.sha256
    ) {
      return yield* Effect.fail(fail("create", "authority-conflict"));
    }
    const terms = yield* Effect.tryPromise({
      try: async () => {
        const revisionTermsHash = await sha256({
          choreographyId: input.choreographyId,
          revision: input.revision,
          songPostId: input.songPostId,
          audioRevision: input.authority.canonicalAudio.audioRevision,
          startMs: input.startMs,
          endMs: input.endMs,
          mirrorPolicy: input.mirrorPolicy,
          referenceVideo: input.authority.referenceVideo,
          extraction: input.authority.extraction,
          alignment: input.authority.alignment,
          pose: input.authority.pose,
          qualityLimits: input.authority.qualityLimits,
          ownerPolicy: input.authority.ownerPolicy,
        });
        const segmentTermsHash = await sha256({
          songPostId: input.songPostId,
          canonicalAudio: input.authority.canonicalAudio,
          startMs: input.startMs,
          endMs: input.endMs,
          extraction: input.authority.extraction,
        });
        return { revisionTermsHash, segmentTermsHash };
      },
      catch: () => fail("create", "unavailable"),
    });
    const effectIdentity = `dance-reference-${input.choreographyId}-r${input.revision}`;
    const ids = yield* Effect.tryPromise({
      try: async () => ({
        outboxId: await identifier("dance-outbox", effectIdentity),
        segmentId: await identifier("dance-segment", terms.segmentTermsHash),
        artifactId: await identifier("dance-artifact", effectIdentity),
      }),
      catch: () => fail("create", "unavailable"),
    });
    const revision = yield* tx.execute<Row>({
      label: "dance-reference.revision.insert",
      text: `INSERT INTO dance_choreography_revisions (
               choreography_id,revision,aggregate_version,community_id,song_post_id,
               audio_revision,requested_start_ms,requested_end_ms,reference_video_post_id,
               reference_video_song_post_id,reference_video_audio_revision,
               reference_video_object_ref,reference_video_sha256,mirror_policy,
               alignment_policy_version,alignment_adapter,alignment_revision,
               pose_model_version,pose_runtime_version,feature_schema_version,
               scorer_contract_version,fingerprint_policy_version,integrity_policy_version,
               owner_policy_revision,owner_policy_hash,revision_terms_hash
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$5,$6,$10,$11,$12,$13,$14,$15,
               $16,$17,$18,$19,$20,$21,$22,$23,$24)
             RETURNING *,status AS revision_status,created_at AS revision_created_at`,
      values: [
        input.choreographyId,
        input.revision,
        input.aggregateVersion,
        input.communityId,
        input.songPostId,
        input.authority.canonicalAudio.audioRevision,
        input.startMs,
        input.endMs,
        input.authority.referenceVideo.postId,
        input.authority.referenceVideo.objectKey,
        input.authority.referenceVideo.sha256,
        input.mirrorPolicy,
        input.authority.alignment.policyVersion,
        input.authority.alignment.adapterId,
        input.authority.alignment.adapterRevision,
        input.authority.pose.modelVersion,
        input.authority.pose.runtimeVersion,
        input.authority.pose.featureSchemaVersion,
        input.authority.pose.scorerContractVersion,
        input.authority.pose.fingerprintPolicyVersion,
        input.authority.pose.integrityPolicyVersion,
        input.authority.ownerPolicy.revision,
        input.authority.ownerPolicy.hash,
        terms.revisionTermsHash,
      ],
      readonly: false,
    });
    if (revision.rows.length !== 1) {
      return yield* Effect.fail(fail("create", "invalid-row"));
    }
    const payload = {
      choreography_id: input.choreographyId,
      effect_identity: effectIdentity,
      revision: String(input.revision),
      revision_terms_hash: terms.revisionTermsHash,
    };
    const outbox = yield* tx.execute({
      label: "dance-reference.outbox.insert",
      text: `INSERT INTO dance_reference_outbox (
               outbox_event_id,choreography_id,revision,event_type,effect_identity,
               payload,payload_sha256
             ) VALUES ($1,$2,$3,'reference_processing',$4,$5::jsonb,
               encode(sha256(convert_to(($5::jsonb)::text,'UTF8')),'hex'))`,
      values: [
        ids.outboxId,
        input.choreographyId,
        input.revision,
        effectIdentity,
        JSON.stringify(payload),
      ],
      readonly: false,
    });
    if (outbox.rowCount !== 1) return yield* Effect.fail(fail("create", "invalid-row"));
    const frozen = yield* Effect.tryPromise({
      try: () =>
        freezeDanceReferenceInput({
          version: "frozen-dance-reference-input-v1",
          effectIdentity,
          choreographyId: input.choreographyId,
          choreographyRevision: input.revision,
          revisionTermsHash: terms.revisionTermsHash,
          canonicalAudio: input.authority.canonicalAudio,
          referenceVideo: input.authority.referenceVideo,
          requestedStartMs: input.startMs,
          requestedEndMs: input.endMs,
          segmentTermsHash: terms.segmentTermsHash,
          mirrorPolicy: input.mirrorPolicy,
          outputs: {
            segmentId: ids.segmentId,
            segmentObjectKey: `private/dance/${input.choreographyId}/${input.revision}/segment`,
            artifactId: ids.artifactId,
            artifactObjectKey: `private/dance/${input.choreographyId}/${input.revision}/artifact`,
            evidenceObjectKey: `private/dance/${input.choreographyId}/${input.revision}/evidence`,
          },
          extraction: input.authority.extraction,
          alignment: input.authority.alignment,
          pose: input.authority.pose,
          qualityLimits: input.authority.qualityLimits,
          ownerPolicy: input.authority.ownerPolicy,
        }),
      catch: () => fail("create", "invalid-input"),
    });
    const request = yield* tx.execute({
      label: "dance-reference.processing-request.insert",
      text: `INSERT INTO dance_reference_processing_requests (
               choreography_id,revision,effect_identity,request_material,canonical_request,input_digest
             ) VALUES ($1,$2,$3,$4::jsonb,$5,$6)`,
      values: [
        input.choreographyId,
        input.revision,
        effectIdentity,
        JSON.stringify(frozen.frozenInput),
        new TextEncoder().encode(frozen.canonicalRequest),
        frozen.inputDigest,
      ],
      readonly: false,
    });
    if (request.rowCount !== 1) return yield* Effect.fail(fail("create", "invalid-row"));
    return processing({
      ...(revision.rows[0] as Row),
      choreography_id: input.choreographyId,
      song_post_id: input.songPostId,
      segment_id: null,
      segment_start_ms: null,
      segment_end_ms: null,
      segment_duration_ms: null,
      canonical_segment_sha256: null,
      extraction_policy_version: null,
      segment_terms_hash: null,
    });
  });
}

function runWithRuntime<A>(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  effect: Effect.Effect<A, Failure, ControlPlaneDb>,
): Promise<A> {
  return Effect.runPromise(Effect.provide(runtime)(effect)).catch((error: unknown) => {
    if (error instanceof DanceReferenceStoreError) throw error;
    throw fail("action", "unavailable");
  });
}

export function makeDanceReferenceStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): DanceReferenceStore {
  const run = <A>(effect: Effect.Effect<A, Failure, ControlPlaneDb>) =>
    runWithRuntime(runtime, effect);

  const lookupAction: DanceReferenceStore["lookupAction"] = (action) =>
    run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* lookupActionEffect(db, action);
      }),
    );

  const create: DanceReferenceStore["create"] = (input) =>
    run(
      Effect.gen(function* () {
        if (
          !authorityValid(
            input.authority,
            input.audioRevision,
            input.referenceVideoPostId,
            input.startMs,
            input.endMs,
          )
        ) {
          return yield* Effect.fail(fail("create", "invalid-input"));
        }
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((tx) =>
          Effect.gen(function* () {
            yield* actionLock(tx, input.action);
            const prior = yield* lookupActionEffect(tx, input.action);
            if (prior.kind === "conflict") {
              return yield* Effect.fail(fail("create", "idempotency-conflict"));
            }
            if (prior.kind === "replay") {
              return replayed(
                decodeResponse(CreateDanceChoreography.response, prior.response, "create"),
              );
            }
            const choreographyId = yield* Effect.tryPromise({
              try: () => identifier("dance-choreography", input.action),
              catch: () => fail("create", "unavailable"),
            });
            const aggregate = yield* tx.execute<Row>({
              label: "dance-reference.choreography.insert",
              text: `INSERT INTO dance_choreographies (
                       choreography_id,community_id,song_post_id,creator_account_id,
                       creator_persona_id,status
                     ) VALUES ($1,$2,$3,$4,$5,'processing')
                     RETURNING *,status AS choreography_status,
                               created_at AS choreography_created_at`,
              values: [
                choreographyId,
                input.communityId,
                input.songPostId,
                input.action.actorAccountId,
                input.creatorPersonaId,
              ],
              readonly: false,
            });
            if (aggregate.rows.length !== 1) {
              return yield* Effect.fail(fail("create", "invalid-row"));
            }
            const processingDocument = yield* insertProcessingGraph(tx, {
              choreographyId,
              revision: 1,
              aggregateVersion: 1,
              communityId: input.communityId,
              songPostId: input.songPostId,
              startMs: input.startMs,
              endMs: input.endMs,
              mirrorPolicy: input.mirrorPolicy,
              authority: input.authority,
            });
            const response = decodeResponse(
              CreateDanceChoreography.response,
              {
                choreography: choreography(aggregate.rows[0] as Row),
                processing: processingDocument,
                replayed: false,
              },
              "create",
            );
            yield* storeAction(tx, input.action, response, {
              choreographyId,
              choreographyRevision: 1,
            });
            return response;
          }),
        );
      }),
    );

  const getProcessing: DanceReferenceStore["getProcessing"] = (input) =>
    run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const rows = yield* db.execute<Row>({
          label: "dance-reference.processing.read",
          text: `${privateProjectionSql}
                  WHERE c.community_id=$1 AND c.choreography_id=$2
                    AND c.creator_account_id=$3 ORDER BY r.revision LIMIT 101`,
          values: [input.communityId, input.choreographyId, input.actorAccountId],
          readonly: true,
        });
        if (rows.rows.length === 0) {
          return yield* Effect.fail(fail("get-processing", "not-found"));
        }
        if (rows.rows.length > 100) {
          return yield* Effect.fail(fail("get-processing", "invalid-row"));
        }
        return decodeResponse(
          GetDanceChoreographyProcessing.response,
          {
            choreography: choreography(rows.rows[0] as Row),
            revisions: rows.rows.map(processing),
          },
          "get-processing",
        );
      }),
    );

  const append: DanceReferenceStore["append"] = (input) =>
    run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((tx) =>
          Effect.gen(function* () {
            yield* actionLock(tx, input.action);
            const prior = yield* lookupActionEffect(tx, input.action);
            if (prior.kind === "conflict") {
              return yield* Effect.fail(fail("append", "idempotency-conflict"));
            }
            if (prior.kind === "replay") {
              return replayed(
                decodeResponse(AppendDanceChoreographyRevision.response, prior.response, "append"),
              );
            }
            const current = yield* tx.execute<Row>({
              label: "dance-reference.append.aggregate",
              text: "SELECT * FROM dance_choreographies WHERE community_id=$1 AND choreography_id=$2 AND creator_account_id=$3 FOR UPDATE",
              values: [input.communityId, input.choreographyId, input.action.actorAccountId],
              readonly: false,
            });
            if (current.rows.length !== 1) {
              return yield* Effect.fail(fail("append", "not-found"));
            }
            const currentRow = current.rows[0] as Row;
            if (!["processing", "ready"].includes(text(currentRow, "status"))) {
              return yield* Effect.fail(fail("append", "state-conflict"));
            }
            if (
              !authorityValid(
                input.authority,
                input.audioRevision,
                input.referenceVideoPostId,
                input.startMs,
                input.endMs,
              )
            ) {
              return yield* Effect.fail(fail("append", "invalid-input"));
            }
            const latest = yield* tx.execute<Row>({
              label: "dance-reference.append.next-revision",
              text: "SELECT COALESCE(max(revision),0)::text AS revision FROM dance_choreography_revisions WHERE choreography_id=$1",
              values: [input.choreographyId],
              readonly: false,
            });
            if (latest.rows.length !== 1) {
              return yield* Effect.fail(fail("append", "invalid-row"));
            }
            const latestRevision = integer(latest.rows[0] as Row, "revision");
            if (latestRevision >= 100) {
              return yield* Effect.fail(fail("append", "state-conflict"));
            }
            const revision = latestRevision + 1;
            const aggregateVersion = integer(currentRow, "version") + 1;
            const updated = yield* tx.execute<Row>({
              label: "dance-reference.append.aggregate-version",
              text: `UPDATE dance_choreographies
                        SET version=$1,updated_at=GREATEST(clock_timestamp(),updated_at+interval '1 microsecond')
                      WHERE choreography_id=$2 AND version=$3
                      RETURNING *,status AS choreography_status,
                                created_at AS choreography_created_at`,
              values: [aggregateVersion, input.choreographyId, aggregateVersion - 1],
              readonly: false,
            });
            if (updated.rows.length !== 1) {
              return yield* Effect.fail(fail("append", "state-conflict"));
            }
            const processingDocument = yield* insertProcessingGraph(tx, {
              choreographyId: input.choreographyId,
              revision,
              aggregateVersion,
              communityId: input.communityId,
              songPostId: text(currentRow, "song_post_id"),
              startMs: input.startMs,
              endMs: input.endMs,
              mirrorPolicy: input.mirrorPolicy,
              authority: input.authority,
            });
            const response = decodeResponse(
              AppendDanceChoreographyRevision.response,
              {
                choreography: choreography(updated.rows[0] as Row),
                processing: processingDocument,
                replayed: false,
              },
              "append",
            );
            yield* storeAction(tx, input.action, response, {
              choreographyId: input.choreographyId,
              choreographyRevision: revision,
            });
            return response;
          }),
        );
      }),
    );

  const cutoff = (
    operation: "disable" | "retire",
    input: Parameters<DanceReferenceStore[typeof operation]>[0],
  ) =>
    run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((tx) =>
          Effect.gen(function* () {
            yield* actionLock(tx, input.action);
            const prior = yield* lookupActionEffect(tx, input.action);
            if (prior.kind === "conflict") {
              return yield* Effect.fail(fail(operation, "idempotency-conflict"));
            }
            const responseSchema =
              operation === "disable"
                ? DisableDanceChoreography.response
                : RetireDanceChoreography.response;
            if (prior.kind === "replay") {
              return replayed(decodeResponse(responseSchema, prior.response, operation));
            }
            yield* tx.execute({
              label: `dance-reference.${operation}.revision-lock`,
              text: "SELECT revision FROM dance_choreography_revisions WHERE choreography_id=$1 ORDER BY revision FOR UPDATE",
              values: [input.choreographyId],
              readonly: false,
            });
            const current = yield* tx.execute<Row>({
              label: `dance-reference.${operation}.aggregate-lock`,
              text: "SELECT * FROM dance_choreographies WHERE community_id=$1 AND choreography_id=$2 AND creator_account_id=$3 FOR UPDATE",
              values: [input.communityId, input.choreographyId, input.action.actorAccountId],
              readonly: false,
            });
            if (current.rows.length !== 1) {
              return yield* Effect.fail(fail(operation, "not-found"));
            }
            const currentStatus = text(current.rows[0] as Row, "status");
            if (
              (operation === "disable" &&
                !["draft", "processing", "ready"].includes(currentStatus)) ||
              (operation === "retire" &&
                !["draft", "processing", "disabled"].includes(currentStatus))
            ) {
              return yield* Effect.fail(fail(operation, "state-conflict"));
            }
            if (operation === "disable") {
              const reason = (input as Parameters<DanceReferenceStore["disable"]>[0]).reason;
              yield* tx.execute({
                label: "dance-reference.disable.ready-revisions",
                text: `UPDATE dance_choreography_revisions
                          SET status='disabled',cutoff_reason=$1,
                              cutoff_at=clock_timestamp()
                        WHERE choreography_id=$2 AND status='ready'`,
                values: [reason, input.choreographyId],
                readonly: false,
              });
            }
            const updated = yield* tx.execute<Row>({
              label: `dance-reference.${operation}.aggregate`,
              text:
                operation === "disable"
                  ? `UPDATE dance_choreographies
                        SET status='disabled',active_revision=NULL,
                            disabled_reason=$1,disabled_at=clock_timestamp(),
                            version=version+1,
                            updated_at=GREATEST(clock_timestamp(),updated_at+interval '1 microsecond')
                      WHERE choreography_id=$2
                      RETURNING *,status AS choreography_status,
                                created_at AS choreography_created_at`
                  : `UPDATE dance_choreographies
                        SET status='retired',retired_at=clock_timestamp(),version=version+1,
                            updated_at=GREATEST(clock_timestamp(),updated_at+interval '1 microsecond')
                      WHERE choreography_id=$1
                      RETURNING *,status AS choreography_status,
                                created_at AS choreography_created_at`,
              values:
                operation === "disable"
                  ? [
                      (input as Parameters<DanceReferenceStore["disable"]>[0]).reason,
                      input.choreographyId,
                    ]
                  : [input.choreographyId],
              readonly: false,
            });
            if (updated.rows.length !== 1) {
              return yield* Effect.fail(fail(operation, "state-conflict"));
            }
            const response = decodeResponse(
              responseSchema,
              { choreography: choreography(updated.rows[0] as Row), replayed: false },
              operation,
            );
            yield* storeAction(tx, input.action, response, {
              choreographyId: input.choreographyId,
            });
            return response;
          }),
        );
      }),
    );

  const disable: DanceReferenceStore["disable"] = (input) => cutoff("disable", input);
  const retire: DanceReferenceStore["retire"] = (input) => cutoff("retire", input);

  const listReady: DanceReferenceStore["listReady"] = (input) =>
    run(
      Effect.gen(function* () {
        if (input.limit < 1 || input.limit > 100) {
          return yield* Effect.fail(fail("list-ready", "invalid-input"));
        }
        let cursorId: string | null = null;
        let cursorRevision = 0;
        if (input.cursor !== null) {
          const separator = input.cursor.lastIndexOf("~");
          if (separator < 1) return yield* Effect.fail(fail("list-ready", "invalid-input"));
          cursorId = input.cursor.slice(0, separator);
          cursorRevision = Number(input.cursor.slice(separator + 1));
          if (!Number.isSafeInteger(cursorRevision) || cursorRevision < 1) {
            return yield* Effect.fail(fail("list-ready", "invalid-input"));
          }
        }
        const db = yield* ControlPlaneDb;
        const publication = yield* db.execute<Row>({
          label: "dance-reference.ready.song",
          text: "SELECT 1 FROM media_publication_projections WHERE community_id=$1 AND post_id=$2 AND audio_revision=$3",
          values: [input.communityId, input.songPostId, input.audioRevision],
          readonly: true,
        });
        if (publication.rows.length !== 1) {
          return yield* Effect.fail(fail("list-ready", "not-found"));
        }
        const rows = yield* db.execute<Row>({
          label: "dance-reference.ready.list",
          text: `${publicProjectionSql}
                  WHERE r.community_id=$1 AND r.song_post_id=$2 AND r.audio_revision=$3
                    AND r.status='ready' AND c.status='ready'
                    AND ($4::text IS NULL OR (r.choreography_id,r.revision)>($4,$5))
                  ORDER BY r.choreography_id,r.revision LIMIT $6`,
          values: [
            input.communityId,
            input.songPostId,
            input.audioRevision,
            cursorId,
            cursorRevision,
            input.limit + 1,
          ],
          readonly: true,
        });
        const hasMore = rows.rows.length > input.limit;
        const selected = rows.rows.slice(0, input.limit);
        const items = selected.map(publicRevision);
        const tail = selected.at(-1);
        return decodeResponse(
          ListReadyDanceChoreographies.response,
          {
            object: "dance_choreography_list",
            song_post_id: input.songPostId,
            audio_revision: input.audioRevision,
            items,
            next_cursor:
              hasMore && tail !== undefined
                ? `${text(tail, "choreography_id")}~${integer(tail, "revision")}`
                : null,
          },
          "list-ready",
        );
      }),
    );

  const getRevision: DanceReferenceStore["getRevision"] = (input) =>
    run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const rows = yield* db.execute<Row>({
          label: "dance-reference.ready.get",
          text: `${publicProjectionSql}
                  WHERE r.community_id=$1 AND r.choreography_id=$2 AND r.revision=$3
                    AND r.status='ready' AND c.status='ready'`,
          values: [input.communityId, input.choreographyId, input.revision],
          readonly: true,
        });
        if (rows.rows.length !== 1) {
          return yield* Effect.fail(fail("get-revision", "not-found"));
        }
        return decodeResponse(
          GetDanceChoreographyRevision.response,
          publicRevision(rows.rows[0] as Row),
          "get-revision",
        );
      }),
    );

  const presentation = (
    operation: "set-presentation" | "clear-presentation",
    input:
      | Parameters<DanceReferenceStore["setPresentation"]>[0]
      | Parameters<DanceReferenceStore["clearPresentation"]>[0],
  ) =>
    run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((tx) =>
          Effect.gen(function* () {
            yield* actionLock(tx, input.action);
            const prior = yield* lookupActionEffect(tx, input.action);
            if (prior.kind === "conflict") {
              return yield* Effect.fail(fail(operation, "idempotency-conflict"));
            }
            const responseSchema =
              operation === "set-presentation"
                ? SetSongDancePresentation.response
                : ClearSongDancePresentation.response;
            if (prior.kind === "replay") {
              return replayed(decodeResponse(responseSchema, prior.response, operation));
            }
            yield* tx.execute({
              label: "dance-reference.presentation.lock",
              text: "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
              values: [
                `dance-presentation:${input.communityId}:${input.songPostId}:${input.audioRevision}`,
              ],
              readonly: false,
            });
            const publication = yield* tx.execute<Row>({
              label: "dance-reference.presentation.owner",
              text: "SELECT submission_id,actor_account_id FROM media_publication_projections WHERE community_id=$1 AND post_id=$2 AND audio_revision=$3 FOR SHARE",
              values: [input.communityId, input.songPostId, input.audioRevision],
              readonly: false,
            });
            if (
              publication.rows.length !== 1 ||
              publication.rows[0]?.actor_account_id !== input.action.actorAccountId
            ) {
              return yield* Effect.fail(fail(operation, "not-found"));
            }
            const current = yield* tx.execute<Row>({
              label: "dance-reference.presentation.current",
              text: "SELECT * FROM song_dance_presentations WHERE community_id=$1 AND song_post_id=$2 AND audio_revision=$3 FOR UPDATE",
              values: [input.communityId, input.songPostId, input.audioRevision],
              readonly: false,
            });
            if (current.rows.length > 1) {
              return yield* Effect.fail(fail(operation, "invalid-row"));
            }
            const setInput =
              operation === "set-presentation"
                ? (input as Parameters<DanceReferenceStore["setPresentation"]>[0])
                : null;
            const unchanged =
              current.rows.length === 1 &&
              ((setInput === null && current.rows[0]?.featured_choreography_id === null) ||
                (setInput !== null &&
                  current.rows[0]?.featured_choreography_id === setInput.choreographyId &&
                  integer(current.rows[0] as Row, "featured_choreography_revision") ===
                    setInput.choreographyRevision));
            let presentationRow: Row;
            if (unchanged) {
              presentationRow = current.rows[0] as Row;
            } else if (current.rows.length === 0) {
              const inserted = yield* tx.execute<Row>({
                label: "dance-reference.presentation.insert",
                text: `INSERT INTO song_dance_presentations (
                         community_id,song_post_id,song_submission_id,audio_revision,
                         presentation_revision,featured_choreography_id,
                         featured_choreography_revision,song_owner_account_id,
                         updated_by_account_id
                       ) VALUES ($1,$2,$3,$4,1,$5,$6,$7,$7) RETURNING *`,
                values: [
                  input.communityId,
                  input.songPostId,
                  text(publication.rows[0] as Row, "submission_id"),
                  input.audioRevision,
                  setInput?.choreographyId ?? null,
                  setInput?.choreographyRevision ?? null,
                  input.action.actorAccountId,
                ],
                readonly: false,
              });
              if (inserted.rows.length !== 1) {
                return yield* Effect.fail(fail(operation, "invalid-row"));
              }
              presentationRow = inserted.rows[0] as Row;
            } else {
              const updated = yield* tx.execute<Row>({
                label: "dance-reference.presentation.update",
                text: `UPDATE song_dance_presentations
                          SET presentation_revision=presentation_revision+1,
                              featured_choreography_id=$1,
                              featured_choreography_revision=$2,
                              updated_by_account_id=$3,
                              updated_at=GREATEST(clock_timestamp(),updated_at+interval '1 microsecond')
                        WHERE community_id=$4 AND song_post_id=$5 AND audio_revision=$6
                        RETURNING *`,
                values: [
                  setInput?.choreographyId ?? null,
                  setInput?.choreographyRevision ?? null,
                  input.action.actorAccountId,
                  input.communityId,
                  input.songPostId,
                  input.audioRevision,
                ],
                readonly: false,
              });
              if (updated.rows.length !== 1) {
                return yield* Effect.fail(fail(operation, "state-conflict"));
              }
              presentationRow = updated.rows[0] as Row;
            }
            const presentationRevision = integer(presentationRow, "presentation_revision");
            const response = decodeResponse(
              responseSchema,
              {
                presentation: {
                  object: "song_dance_presentation",
                  song_post_id: input.songPostId,
                  audio_revision: input.audioRevision,
                  presentation_revision: presentationRevision,
                  updated_at: instant(presentationRow, "updated_at"),
                  featured:
                    setInput === null
                      ? null
                      : {
                          choreography_id: setInput.choreographyId,
                          choreography_revision: setInput.choreographyRevision,
                        },
                },
                replayed: false,
              },
              operation,
            );
            yield* storeAction(tx, input.action, response, { presentationRevision });
            return response;
          }),
        );
      }),
    );

  const setPresentation: DanceReferenceStore["setPresentation"] = (input) =>
    presentation("set-presentation", input) as Promise<SetDancePresentationResponse>;
  const clearPresentation: DanceReferenceStore["clearPresentation"] = (input) =>
    presentation("clear-presentation", input) as Promise<ClearDancePresentationResponse>;

  return {
    lookupAction,
    create,
    getProcessing,
    append,
    disable,
    retire,
    listReady,
    getRevision,
    setPresentation,
    clearPresentation,
  };
}
