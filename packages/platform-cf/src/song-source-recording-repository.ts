import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import type {
  SongSourceFailureCode,
  SongSourceRecordingStore,
  SongSourceRegistration,
} from "@pirate/application/media/source-recording-authority";
import { canonicalJson } from "@pirate/domain";
import { Data, Effect, type Layer, Schema } from "effect";

type Row = Readonly<Record<string, unknown>>;

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const Positive = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));
const RegistrationRow = Schema.Struct({
  registration_id: Text,
  asset_id: Text,
  submission_id: Text,
  operation_id: Text,
  audio_revision: Positive,
  analysis_revision: Positive,
  publication_revision: Positive,
  terms_revision: Positive,
  canonical_audio_sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  immutable_audio_ref: Text,
  verification_sample: Schema.Struct({
    objectKey: Text,
    contentType: Schema.Literals(["audio/mpeg", "audio/wav"]),
    byteLength: Positive,
  }),
  provider: Schema.Literal("acrcloud"),
  bucket_id: Text,
  opaque_title: Text,
  state: Schema.Literals([
    "pending_upload",
    "provider_outcome_unknown",
    "provider_processing",
    "ready",
    "failed",
    "deletion_pending",
    "deleted",
  ]),
  provider_file_id: Schema.NullOr(Text),
  provider_match_id: Schema.NullOr(Text),
  claim_owner: Schema.NullOr(Text),
  claim_fence: Schema.Union([Schema.BigInt, Schema.String]),
});

export class SongSourceRecordingRepositoryError extends Data.TaggedError(
  "SongSourceRecordingRepositoryError",
)<{
  readonly operation: "get" | "list" | "claim" | "transition";
  readonly reason: "invalid-input" | "invalid-row" | "unavailable";
}> {}

export interface SongSourceRecordingRepository extends SongSourceRecordingStore {
  readonly listEligible: (limit: number) => Promise<readonly string[]>;
  readonly claim: (
    registrationId: string,
    workerId: string,
    leaseSeconds: number,
  ) => Promise<SongSourceRegistration | null>;
}

const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  value === value.trim() &&
  !value.includes("\u0000");

const decode = (row: Row): SongSourceRegistration => {
  const value = Schema.decodeUnknownSync(RegistrationRow)(row);
  const claimFence =
    typeof value.claim_fence === "bigint" ? value.claim_fence : BigInt(value.claim_fence);
  if (claimFence < 0n) throw new TypeError("invalid claim fence");
  return {
    registrationId: value.registration_id,
    assetId: value.asset_id,
    submissionId: value.submission_id,
    operationId: value.operation_id,
    audioRevision: value.audio_revision,
    analysisRevision: value.analysis_revision,
    publicationRevision: value.publication_revision,
    termsRevision: value.terms_revision,
    canonicalAudioSha256: value.canonical_audio_sha256,
    immutableAudioRef: value.immutable_audio_ref,
    verificationSample: value.verification_sample,
    provider: value.provider,
    bucketId: value.bucket_id,
    opaqueTitle: value.opaque_title,
    state: value.state,
    providerFileId: value.provider_file_id,
    providerMatchId: value.provider_match_id,
    claimOwner: value.claim_owner,
    claimFence,
  };
};

export function makeSongSourceRecordingRepository(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): SongSourceRecordingRepository {
  const run = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>): Promise<A> =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(runtime),
        Effect.mapError(
          () =>
            new SongSourceRecordingRepositoryError({
              operation: "transition",
              reason: "unavailable",
            }),
        ),
      ),
    );
  const query = (
    operation: "get" | "list" | "claim" | "transition",
    text: string,
    values: readonly unknown[],
    readonly: boolean,
  ) =>
    run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.execute<Row>({
          label: `song-source-recording.${operation}`,
          text,
          values,
          readonly,
        });
      }),
    );

  const get: SongSourceRecordingStore["get"] = async (registrationId) => {
    if (!validId(registrationId)) {
      throw new SongSourceRecordingRepositoryError({ operation: "get", reason: "invalid-input" });
    }
    const result = await query(
      "get",
      `SELECT r.*,o.claim_owner,o.claim_fence
         FROM song_source_recording_registrations r
         JOIN song_source_recording_outbox o USING (registration_id)
        WHERE r.registration_id=$1`,
      [registrationId],
      true,
    );
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) {
      throw new SongSourceRecordingRepositoryError({ operation: "get", reason: "invalid-row" });
    }
    try {
      return decode(result.rows[0] as Row);
    } catch {
      throw new SongSourceRecordingRepositoryError({ operation: "get", reason: "invalid-row" });
    }
  };

  const transition = async (
    input: Readonly<{
      registrationId: string;
      workerId: string;
      claimFence: bigint;
      event: string;
      evidenceRef: string;
      set: string;
      values: readonly unknown[];
      allowedStates: readonly string[];
      nextDelaySeconds: number | null;
    }>,
  ): Promise<boolean> => {
    if (
      !validId(input.registrationId) ||
      !validId(input.workerId) ||
      input.claimFence < 1n ||
      !validId(input.event) ||
      !validId(input.evidenceRef)
    ) {
      throw new SongSourceRecordingRepositoryError({
        operation: "transition",
        reason: "invalid-input",
      });
    }
    const base = input.values.length;
    const result = await query(
      "transition",
      `WITH locked AS (
         SELECT registration_id,claim_fence FROM song_source_recording_outbox
          WHERE registration_id=$${base + 1} AND claim_owner=$${base + 2}
            AND claim_fence=$${base + 3} AND state='running'
            AND lease_expires_at>clock_timestamp() FOR UPDATE
       ), changed AS (
         UPDATE song_source_recording_registrations r
            SET ${input.set},updated_at=clock_timestamp()
           FROM locked l
          WHERE r.registration_id=l.registration_id AND r.state=ANY($${base + 4}::text[])
          RETURNING r.registration_id,l.claim_fence
       ), released AS (
         UPDATE song_source_recording_outbox o
            SET state=CASE WHEN $${base + 8}::integer IS NULL THEN 'delivered' ELSE 'pending' END,
                claim_owner=NULL,lease_expires_at=NULL,
                next_eligible_at=CASE WHEN $${base + 8}::integer IS NULL THEN 'infinity'::timestamptz
                  ELSE clock_timestamp()+make_interval(secs=>$${base + 8}) END,
                updated_at=clock_timestamp()
           FROM changed c WHERE o.registration_id=c.registration_id
          RETURNING o.registration_id
       )
       INSERT INTO song_source_recording_attempts
         (attempt_id,registration_id,claim_fence,event,evidence_ref,evidence)
       SELECT registration_id || ':f' || claim_fence::text || ':' || $${base + 5},
              registration_id,claim_fence,$${base + 5},$${base + 6},$${base + 7}::jsonb
         FROM changed JOIN released USING (registration_id)
       ON CONFLICT (attempt_id) DO NOTHING
       RETURNING attempt_id`,
      [
        ...input.values,
        input.registrationId,
        input.workerId,
        input.claimFence.toString(),
        input.allowedStates,
        input.event,
        input.evidenceRef,
        canonicalJson({ version: "song-source-recording-attempt-v1", event: input.event }),
        input.nextDelaySeconds,
      ],
      false,
    );
    return result.rowCount === 1;
  };

  return {
    get,
    listEligible: async (limit) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new SongSourceRecordingRepositoryError({
          operation: "list",
          reason: "invalid-input",
        });
      }
      const result = await query(
        "list",
        `SELECT r.registration_id FROM song_source_recording_registrations r
          JOIN song_source_recording_outbox o USING (registration_id)
          WHERE r.state IN ('pending_upload','provider_outcome_unknown','provider_processing')
            AND o.state IN ('pending','running') AND o.next_eligible_at<=clock_timestamp()
            AND (o.claim_owner IS NULL OR o.lease_expires_at<=clock_timestamp())
          ORDER BY o.next_eligible_at,o.created_at,o.outbox_id LIMIT $1`,
        [limit],
        true,
      );
      const ids = result.rows.map((row) => row.registration_id);
      if (!ids.every(validId)) {
        throw new SongSourceRecordingRepositoryError({ operation: "list", reason: "invalid-row" });
      }
      return ids as string[];
    },
    claim: async (registrationId, workerId, leaseSeconds) => {
      if (
        !validId(registrationId) ||
        !validId(workerId) ||
        !Number.isSafeInteger(leaseSeconds) ||
        leaseSeconds < 1 ||
        leaseSeconds > 900
      ) {
        throw new SongSourceRecordingRepositoryError({
          operation: "claim",
          reason: "invalid-input",
        });
      }
      const result = await query(
        "claim",
        `WITH claimed AS (
           UPDATE song_source_recording_outbox
              SET state='running',claim_owner=$2,claim_fence=claim_fence+1,
                  delivery_attempts=delivery_attempts+1,
                  lease_expires_at=clock_timestamp()+make_interval(secs=>$3),updated_at=clock_timestamp()
            WHERE registration_id=$1 AND state IN ('pending','running')
              AND next_eligible_at<=clock_timestamp()
              AND (claim_owner IS NULL OR lease_expires_at<=clock_timestamp())
            RETURNING registration_id,claim_owner,claim_fence
         ) SELECT r.*,c.claim_owner,c.claim_fence
             FROM song_source_recording_registrations r JOIN claimed c USING (registration_id)
            WHERE r.state IN ('pending_upload','provider_outcome_unknown','provider_processing')`,
        [registrationId, workerId, leaseSeconds],
        false,
      );
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) {
        throw new SongSourceRecordingRepositoryError({ operation: "claim", reason: "invalid-row" });
      }
      try {
        return decode(result.rows[0] as Row);
      } catch {
        throw new SongSourceRecordingRepositoryError({ operation: "claim", reason: "invalid-row" });
      }
    },
    acceptProviderFile: (input) =>
      transition({
        ...input,
        event: "provider_file_accepted",
        evidenceRef: input.evidenceDigest,
        set: "state='provider_processing',provider_file_id=$1,provider_match_id=$2,upload_evidence_digest=$3",
        values: [input.file.providerFileId, input.file.providerMatchId, input.evidenceDigest],
        allowedStates: ["pending_upload", "provider_outcome_unknown"],
        nextDelaySeconds: 10,
      }),
    markProviderOutcomeUnknown: (input) =>
      transition({
        ...input,
        event: "provider_outcome_unknown",
        evidenceRef: input.evidenceDigest,
        set: "state='provider_outcome_unknown',upload_evidence_digest=$1",
        values: [input.evidenceDigest],
        allowedStates: ["pending_upload"],
        nextDelaySeconds: 30,
      }),
    markReady: (input) =>
      transition({
        ...input,
        event: "authority_ready",
        evidenceRef: input.identificationEvidence.context.requestId,
        set: "state='ready',provider_file_id=$1,provider_match_id=$2,identification_evidence=$3::jsonb,ready_at=clock_timestamp()",
        values: [
          input.providerFileId,
          input.providerMatchId,
          canonicalJson(input.identificationEvidence),
        ],
        allowedStates: ["provider_processing"],
        nextDelaySeconds: null,
      }),
    fail: (input) =>
      transition({
        ...input,
        event: "authority_failed",
        evidenceRef: input.evidenceRef,
        set: "state='failed',failure_code=$1,failure_evidence_ref=$2",
        values: [input.failureCode, input.evidenceRef],
        allowedStates: ["pending_upload", "provider_outcome_unknown", "provider_processing"],
        nextDelaySeconds: null,
      }),
  };
}

export const songSourceFailureCodes: readonly SongSourceFailureCode[] = [
  "catalog_configuration_invalid",
  "catalog_upload_rejected",
  "catalog_record_ambiguous",
  "catalog_record_invalid",
  "catalog_processing_failed",
  "verification_rejected",
  "verification_mismatch",
];
