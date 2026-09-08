import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ControlPlaneDb } from "@pirate/application";
import { MODERATION_POLICY_CATEGORIES_V1, NotFound } from "@pirate/contracts";
import { canonicalTextModerationInput } from "@pirate/domain";
import { Effect } from "effect";
import { Client } from "pg";
import {
  applyPostgresTestBaselineConnection,
  withReusablePostgresTestSchema,
} from "../../../scripts/postgres-test-baseline.ts";
import type {
  MediaProcessingProviders,
  MediaProcessingStore,
} from "../../application/src/media/processing-contracts.ts";
import { runMediaProcessingWorkflow } from "../../application/src/media/processing-workflow.ts";
import { bindMediaReference } from "../../application/src/media/submission-service.ts";
import type {
  MediaTransformProbeInput,
  MediaTransformService,
} from "../../application/src/media/transform.ts";
import type { MediaIdentificationOutcome } from "../../application/src/media-identification-provider.ts";
import type {
  PublicationDecision,
  SongTerms,
  TrustedSongAnalysis,
} from "../../domain/src/media-submission.ts";
import { insertActiveCommunityMembershipFixture } from "./community-follow.pg-fixture";
import { makeControlPlaneKaraokeReadinessStore } from "./karaoke-readiness-repository";
import { makeControlPlaneMediaOutboxRepository } from "./media-outbox-repository";
import { makeMediaProcessingStore } from "./media-processing-store";
import { makeMediaReferenceResolver } from "./media-reference-resolver";
import { makeControlPlaneMediaSubmissionRepository } from "./media-submission-repository";
import { makeMediaUploadApplicationCommands, makeMediaUploadStore } from "./media-upload-store";
import { makeControlPlanePersonaStore } from "./persona-repository";
import {
  activatePendingPersonaFixtures,
  createActivePersonaFixture,
} from "./persona-wallet.pg-fixture";
import { makeDirectPostgresControlPlaneLayer } from "./postgres";
import { makeSongSourceRecordingRepository } from "./song-source-recording-repository";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
const suite = connectionString === undefined ? describe.skip : describe;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_MEDIA_PERSISTENCE_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-media-persistence-suite-complete";
const sentinelContents = "api-next-control-plane-postgres-media-persistence-suite-complete\n";
const testCount = 43;
let completedTestCount = 0;
const actor = "media_pg_actor",
  moderator = "media_pg_moderator",
  community = "media_pg_community",
  operation = "media_pg_operation",
  submission = "media_pg_submission",
  reservation = "media_pg_reservation";
const responseBytes = new TextEncoder().encode('{"status":"accepted"}');
const audioBytes = new TextEncoder().encode("media-fixture-audio");
const sha256 = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const responseSha256 = sha256(responseBytes),
  audioSha256 = sha256(audioBytes),
  requestHash = "a".repeat(64);
const personaIdsByConnection = new Map<string, ReadonlyMap<string, string>>();

function personaFor(connection: string, accountId = actor): string {
  const personaId = personaIdsByConnection.get(connection)?.get(accountId);
  if (personaId === undefined) throw new Error(`missing test persona for ${accountId}`);
  return personaId;
}
const termsFor = (recipientId: string): SongTerms => ({
  licensePreset: "non-commercial",
  commercialRemixShareBps: 0,
  royaltyAllocations: [{ recipientId, shareBps: 10_000 }],
  accessMode: "public",
});
const analysis: TrustedSongAnalysis = {
  version: "song-trusted-analysis-v1",
  operationId: operation,
  analysisRevision: 1,
  audioRevision: 1,
  canonicalAudioSha256: audioSha256,
  finalizedAudioRef: "media_pg_immutable",
  probeEvidenceRef: "probe_evidence_1",
  embeddedMetadata: {
    evidenceRef: "metadata_evidence_1",
    adapterRevision: "metadata_adapter_1",
    trackTitle: null,
    cover: { status: "absent", reasonCode: "not_embedded" },
  },
  lyricsAnalysis: { status: "not_applicable" },
  acr: {
    decision: "allow",
    evidenceRef: "acr_evidence_1",
    policyRevision: "acr_policy_1",
    adapterRevision: "acr_adapter_1",
  },
  mediaSafety: "allow",
  lyricsSafety: "not_applicable",
  contentModeration: {
    decision: "allow",
    resultingContentRating: "general",
    inputSha256: "b".repeat(64),
    matchedCategories: [],
    policyRevision: "moderation_policy_1",
    platformPolicyRevision: "platform_policy_1",
    communityPolicyRevision: "community_policy_1",
    evidenceRef: "evidence_fixture",
    providerEvidence: {
      providerId: "openai",
      requestedModel: "omni-moderation-2024-09-26",
      returnedModel: "omni-moderation-2024-09-26",
      inputs: [{ surface: "song_title" }],
    },
  },
  boundReference: null,
};
const decision: PublicationDecision = {
  decisionRevision: 1,
  outcome: "allow",
  contentRating: "general",
  creationRevision: 2,
  audioRevision: 1,
  analysisRevision: 1,
  lyricsRevision: null,
  canonicalAudioSha256: audioSha256,
  policyRevision: "publication_policy_1",
  evidenceRef: "publication_evidence_1",
};
const reviewDecision: PublicationDecision = { ...decision, outcome: "manual_review" };
function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
function scopedConnection(raw: string, schema: string): string {
  return `${raw}${raw.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

async function seedHnsState(admin: Client): Promise<void> {
  const config = new TextEncoder().encode('{"fixture":"hns"}');
  const configDigest = sha256(config);
  const request = new TextEncoder().encode('{"observation":"media"}');
  await admin.query(
    "INSERT INTO hns_control_observer_configurations (provider_configuration_reference,provider_configuration_version,provider_configuration_digest,configuration_bytes) VALUES ($1,$2,$3,$4)",
    ["media-hns-fixture", "v1", configDigest, config],
  );
  await admin.query(
    "INSERT INTO hns_control_observer_operations (observation_id,provider_configuration_reference,provider_configuration_version,provider_configuration_digest,request_bytes,request_sha256,configuration_bytes,snapshot_reference) VALUES ($1,$2,$3,$4,$5,$6,$7,NULL)",
    [
      "media-hns-operation",
      "media-hns-fixture",
      "v1",
      configDigest,
      request,
      sha256(request),
      config,
    ],
  );
  const now = new Date();
  const lease = new Date(now.getTime() + 10_000);
  await admin.query(
    "INSERT INTO hns_control_observer_reservations (observation_id,state,reservation_lease_seconds,observer_fence,reservation_database_time,lease_expires_at,created_at,updated_at) VALUES ($1,'reserved',10,1,$2,$3,$2,$2)",
    ["media-hns-operation", now, lease],
  );
}
async function withCurrentSchema<A>(
  use: (client: Client, connection: string) => Promise<A>,
  populated = true,
): Promise<A> {
  if (connectionString === undefined) throw new Error("Postgres test configuration is unavailable");
  return withReusablePostgresTestSchema({
    baseConnectionString: connectionString,
    schemaName: "packages_platform_cf_src_media_persistence_pg_test_ts",
    use: async ({ admin, schema }) => {
      const connection = scopedConnection(connectionString, schema);
      await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      if (populated) {
        await admin.query("INSERT INTO users (user_id) VALUES ($1)", [actor]);
        await admin.query("INSERT INTO users (user_id) VALUES ($1)", [moderator]);
        await activatePendingPersonaFixtures(admin);
        await admin.query(
          "INSERT INTO communities (community_id,display_name,status,created_by_user_id,created_at,updated_at) VALUES ($1,'Media fixture','active',$2,now(),now())",
          [community, moderator],
        );
        await insertActiveCommunityMembershipFixture(admin, {
          communityId: community,
          membershipId: "media_pg_membership",
          userId: actor,
        });
        await insertActiveCommunityMembershipFixture(admin, {
          communityId: community,
          membershipId: "media_pg_moderator_membership",
          userId: moderator,
        });
        await seedHnsState(admin);
        const personas = await admin.query<{ account_id: string; persona_id: string }>(
          "SELECT account_id,persona_id FROM personas WHERE is_first_persona",
        );
        personaIdsByConnection.set(
          connection,
          new Map(personas.rows.map(({ account_id, persona_id }) => [account_id, persona_id])),
        );
        await admin.query(
          `INSERT INTO persona_community_bindings (
             persona_id, account_id, community_id, binding_source
           ) SELECT persona_id, account_id, $1, 'first_membership'
               FROM personas WHERE is_first_persona`,
          [community],
        );
      }
      return await use(admin, connection);
    },
  });
}
function run<A>(
  connection: string,
  program: (
    submissionStore: ReturnType<typeof makeControlPlaneMediaSubmissionRepository>,
    outboxStore: ReturnType<typeof makeControlPlaneMediaOutboxRepository>,
  ) => Effect.Effect<A, unknown, ControlPlaneDb>,
  dataRegistrationChainId?: bigint,
): Promise<A> {
  const layer = makeDirectPostgresControlPlaneLayer(connection);
  return Effect.runPromise(
    Effect.scoped(
      program(
        makeControlPlaneMediaSubmissionRepository(
          dataRegistrationChainId === undefined ? {} : { dataRegistrationChainId },
        ),
        makeControlPlaneMediaOutboxRepository(),
      ).pipe(Effect.provide(layer)),
    ),
  );
}
const command = (connection: string, endpointTemplate: string, idempotencyKey: string) => ({
  communityId: community,
  submissionId: submission,
  actorUserId: actor,
  personaId: personaFor(connection),
  endpointTemplate,
  idempotencyKey,
  requestHash,
  responseBytes,
  responseSha256,
});
const finalizeFence = (
  connection: string,
  idempotencyKey = "finalize-key",
  expectedCreationRevision = 2,
) => ({
  communityId: community,
  submissionId: submission,
  actorUserId: actor,
  personaId: personaFor(connection),
  reservationId: reservation,
  idempotencyKey,
  requestHash,
  expectedCreationRevision,
});
const publicationWakeup = (suffix: string) => ({
  outboxEventId: `media_pg_publication_outbox_${suffix}`,
  effectIdentity: `media_pg_publication_effect_${suffix}`,
  payload: {
    kind: "publication" as const,
    submission_id: submission,
    operation_id: operation,
    creation_revision: 2,
    lyrics_revision: null,
    workflow_revision: 1,
    workflow_instance_id: `media-${operation}-r1`,
  },
});
async function createThroughDecision(
  connection: string,
  selectedDecision: PublicationDecision = decision,
  selectedAnalysis: TrustedSongAnalysis = analysis,
  skipDecision = false,
  initialLyrics?: string,
  stopBeforeAnalysis = false,
  fixture = { submission, operation, reservation },
  selectedTerms?: SongTerms,
): Promise<void> {
  const { submission, operation, reservation } = fixture;
  const key = (value: string) =>
    submission === "media_pg_submission" ? value : `${submission}-${value}`;
  const selectedCommand = (connection: string, endpoint: string, idempotencyKey: string) => ({
    ...command(connection, endpoint, key(idempotencyKey)),
    submissionId: submission,
  });
  const fence = {
    ...finalizeFence(connection),
    submissionId: submission,
    reservationId: reservation,
    idempotencyKey: key("finalize-key"),
  };
  expect(
    await run(connection, (store) =>
      store.reserve({
        communityId: community,
        actorUserId: actor,
        personaId: personaFor(connection),
        idempotencyKey: key("reserve-key"),
        requestHash,
        expectedContentType: "audio/mpeg",
        expectedSizeBytes: audioBytes.byteLength,
        expectedSha256: audioSha256,
        uploadUrl: "https://upload.test/media",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        responseBytes,
        responseSha256,
        reservationId: reservation,
      }),
    ),
  ).toMatchObject({ kind: "created" });
  expect(
    await run(connection, (store) =>
      store.createSubmission({
        communityId: community,
        actorUserId: actor,
        personaId: personaFor(connection),
        idempotencyKey: key("create-key"),
        requestHash,
        title: "Fixture song",
        songType: "original",
        reservationId: reservation,
        submissionId: submission,
        operationId: operation,
        responseBytes,
        responseSha256,
      }),
    ),
  ).toMatchObject({ kind: "created" });
  expect(
    await run(connection, (store) =>
      store.bindTerms({
        ...selectedCommand(connection, "/media-post-submissions/:submissionId/terms", "terms-key"),
        expectedCreationRevision: 1,
        terms: selectedTerms ?? termsFor(personaFor(connection)),
      }),
    ),
  ).toEqual({ kind: "committed", submissionId: submission });
  expect(await run(connection, (store) => store.beginFinalize(fence))).toMatchObject({
    kind: "begun",
    submissionId: submission,
    operationId: operation,
  });
  expect(await run(connection, (store) => store.beginFinalize(fence))).toMatchObject({
    kind: "resumed",
    submissionId: submission,
    operationId: operation,
  });
  expect(
    await run(connection, (store) =>
      store.finalizeSealed({
        ...selectedCommand(
          connection,
          "/media-post-submissions/:submissionId/finalize",
          "finalize-key",
        ),
        expectedCreationRevision: 2,
        expectedAudioRevision: 0,
        reservationId: reservation,
        immutableObject: {
          immutableRef: selectedAnalysis.finalizedAudioRef,
          destinationRef:
            submission === "media_pg_submission"
              ? "media://immutable/fixture"
              : selectedAnalysis.finalizedAudioRef,
          etag: "etag-1",
          objectVersion: "version-1",
          sizeBytes: audioBytes.byteLength,
          contentType: "audio/mpeg",
          canonicalSha256: audioSha256,
        },
        outbox: {
          outboxEventId: key("media_pg_analysis_outbox"),
          effectIdentity: key("media_pg_analysis_effect"),
          payload: {
            kind: "analysis_launch",
            submission_id: submission,
            operation_id: operation,
            audio_revision: 1,
            analysis_revision: 0,
            workflow_revision: 1,
            workflow_instance_id: `media-${operation}-r1`,
          },
        },
      }),
    ),
  ).toMatchObject({ kind: "committed" });
  if (initialLyrics !== undefined) {
    expect(
      await run(connection, (store) =>
        store.bindLyrics({
          ...selectedCommand(
            connection,
            "/media-post-submissions/:submissionId/lyrics",
            "lyrics-key",
          ),
          expectedCreationRevision: 2,
          expectedAudioRevision: 1,
          lyrics: initialLyrics,
          outbox: {
            outboxEventId: "media_pg_lyrics_outbox",
            effectIdentity: "media_pg_lyrics_effect",
            payload: {
              kind: "decision_wakeup",
              submission_id: submission,
              operation_id: operation,
              creation_revision: 3,
              lyrics_revision: 1,
              trigger: "lyrics",
              workflow_revision: 1,
              workflow_instance_id: `media-${operation}-r1`,
            },
          },
        }),
      ),
    ).toEqual({ kind: "committed", submissionId: submission });
  }
  if (stopBeforeAnalysis) return;
  expect(
    await run(connection, (store) =>
      store.acceptAnalysis({
        ...selectedCommand(
          connection,
          "/media-post-submissions/:submissionId/analysis",
          "analysis-key",
        ),
        expectedAudioRevision: 1,
        expectedCanonicalAudioSha256: audioSha256,
        analysis: selectedAnalysis,
      }),
    ),
  ).toEqual({ kind: "committed", submissionId: submission });
  if (skipDecision) return;
  expect(
    await run(connection, (store) =>
      store.recordDecision({
        ...selectedCommand(
          connection,
          "/media-post-submissions/:submissionId/decision",
          "decision-key",
        ),
        expectedCreationRevision: selectedDecision.creationRevision,
        expectedAudioRevision: selectedDecision.audioRevision,
        expectedAnalysisRevision: selectedDecision.analysisRevision,
        decision: selectedDecision,
      }),
    ),
  ).toEqual({ kind: "committed", submissionId: submission });
}

async function insertAnalysisSnapshotVariant(
  admin: Client,
  analysisRevision: number,
  snapshot: Readonly<Record<string, unknown>>,
): Promise<void> {
  await admin.query(
    "INSERT INTO media_analysis_evidence (submission_id,community_id,actor_user_id,operation_id,analysis_version,audio_revision,analysis_revision,canonical_audio_sha256,finalized_audio_ref,probe_evidence_ref,embedded_metadata_evidence_ref,embedded_metadata_adapter_revision,embedded_title,embedded_title_provenance,cover_status,cover_artifact_ref,cover_artifact_sha256,cover_media_type,cover_width,cover_height,cover_normalization_revision,cover_safety_policy_revision,cover_facts,speech_status,transcript_artifact_ref,transcript_sha256,explicitness,primary_language_bcp47,secondary_language_bcp47,speech_evidence_ref,speech_policy_revision,speech_adapter_revision,acr_decision,acr_evidence_ref,acr_policy_revision,acr_adapter_revision,media_safety,lyrics_safety,bound_reference_asset_id,bound_reference_audio_revision,bound_reference_analysis_revision,bound_reference_audio_sha256,bound_reference_upstream_share_bps,analysis_snapshot) SELECT submission_id,community_id,actor_user_id,operation_id,analysis_version,audio_revision,$2::bigint,canonical_audio_sha256,finalized_audio_ref,probe_evidence_ref,embedded_metadata_evidence_ref,embedded_metadata_adapter_revision,embedded_title,embedded_title_provenance,cover_status,cover_artifact_ref,cover_artifact_sha256,cover_media_type,cover_width,cover_height,cover_normalization_revision,cover_safety_policy_revision,cover_facts,speech_status,transcript_artifact_ref,transcript_sha256,explicitness,primary_language_bcp47,secondary_language_bcp47,speech_evidence_ref,speech_policy_revision,speech_adapter_revision,acr_decision,acr_evidence_ref,acr_policy_revision,acr_adapter_revision,media_safety,lyrics_safety,bound_reference_asset_id,bound_reference_audio_revision,bound_reference_analysis_revision,bound_reference_audio_sha256,bound_reference_upstream_share_bps,$3::jsonb FROM media_analysis_evidence WHERE submission_id=$1 AND analysis_revision=1",
    [submission, analysisRevision, JSON.stringify(snapshot)],
  );
}

async function expectHostileLyricsProjectionLeakRejected(
  admin: Client,
  injectFailureFields = false,
): Promise<void> {
  await admin.query("BEGIN");
  await admin.query(
    "INSERT INTO media_submission_terms (submission_id,community_id,actor_user_id,operation_id,creation_revision,license_preset,commercial_remix_share_bps,royalty_allocations,access_mode,terms_snapshot,author_persona_id) SELECT s.submission_id,s.community_id,s.actor_user_id,s.operation_id,s.creation_revision+1,t.license_preset,t.commercial_remix_share_bps,t.royalty_allocations,t.access_mode,t.terms_snapshot,s.author_persona_id FROM media_post_submissions s JOIN media_submission_terms t ON t.submission_id=s.submission_id AND t.creation_revision=s.current_terms_revision WHERE s.submission_id=$1",
    [submission],
  );
  await admin.query(
    "INSERT INTO media_song_lyrics_revisions (submission_id,community_id,actor_user_id,author_persona_id,operation_id,lyrics_revision,creation_revision,audio_revision,canonical_audio_sha256,lyrics_text,lyrics_sha256,base_transcript_revision,provenance) SELECT s.submission_id,s.community_id,s.actor_user_id,s.author_persona_id,s.operation_id,s.lyrics_revision+1,s.creation_revision+1,s.audio_revision,a.canonical_sha256,'hostile retained fields',encode(sha256(convert_to('hostile retained fields','UTF8')),'hex'),NULL,'pasted' FROM media_post_submissions s JOIN media_audio_revisions a ON a.submission_id=s.submission_id AND a.audio_revision=s.audio_revision WHERE s.submission_id=$1",
    [submission],
  );
  await expect(
    admin.query(
      `UPDATE media_post_submissions SET creation_revision=creation_revision+1,current_terms_revision=creation_revision+1,lyrics_revision=lyrics_revision+1,current_lyrics_revision=lyrics_revision+1,current_analysis_revision=NULL,decision_revision=0,current_decision_revision=NULL,status='processing',phase='analysis',${
        injectFailureFields
          ? "failure_code='probe_failed',failure_retry_count=1,retryable=TRUE,last_safe_phase='analysis',"
          : ""
      }event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE submission_id=$1`,
      [submission],
    ),
  ).rejects.toThrow("lyrics projection transition is not exact");
  await admin.query("ROLLBACK");
}

suite("song media persistence PostgreSQL 17 race suite", () => {
  for (const stage of [
    "probe",
    "probe_recovery",
    "sample_primary",
    "sample_alternate",
    "acr_primary",
    "acr_alternate",
    "metadata",
    "classifier",
    "audio_read",
    "cover_read",
    "text",
    "cover",
    "alignment",
    "publication_commit",
    "alignment_commit",
  ] as const) {
    test(`preserves durable state when interrupted during ${stage}`, async () => {
      await withCurrentSchema(async (admin, connection) => {
        const targetStage = stage === "probe_recovery" ? "probe" : stage;
        const store = makeMediaProcessingStore(
          makeDirectPostgresControlPlaneLayer(connection),
          stage === "probe_recovery" ? { attemptLeaseSeconds: 3 } : {},
        );
        if (
          stage === "alignment" ||
          stage === "publication_commit" ||
          stage === "alignment_commit"
        ) {
          const ready: TrustedSongAnalysis = {
            ...analysis,
            lyricsAnalysis: {
              status: "ready",
              lyricsRevision: 1,
              explicitness: "not_explicit",
              primaryLanguageBcp47: "en",
              secondaryLanguageBcp47: null,
              evidenceRef: "fixture-lyrics",
              policyRevision: "fixture-v1",
              adapterRevision: "fixture-v1",
            },
            lyricsSafety: "allow",
          };
          await createThroughDecision(
            connection,
            { ...decision, creationRevision: 3, lyricsRevision: 1 },
            ready,
            false,
            "accepted fixture lyrics",
          );
          const current = await store.loadAuthority(submission, operation);
          if (current === null) throw new Error("missing publication fixture");
          if (stage !== "publication_commit")
            expect(await store.commitPublication(current)).toBe("committed");
          else
            await run(connection, (_submissions, outbox) =>
              outbox.enqueue({
                outboxEventId: "media_pg_publication_checkpoint",
                effectIdentity: "media-pg-publication-checkpoint",
                submissionId: submission,
                communityId: community,
                actorUserId: actor,
                personaId: personaFor(connection),
                operationId: operation,
                creationRevision: 3,
                audioRevision: 1,
                analysisRevision: 1,
                lyricsRevision: 1,
                workflowRevision: 1,
                workflowInstanceId: `media-${operation}-r1`,
                eventType: "publication",
                payload: {
                  kind: "publication",
                  submission_id: submission,
                  operation_id: operation,
                  creation_revision: 3,
                  lyrics_revision: 1,
                  workflow_revision: 1,
                  workflow_instance_id: `media-${operation}-r1`,
                },
              }),
            );
        } else {
          await createThroughDecision(
            connection,
            decision,
            analysis,
            true,
            "accepted fixture lyrics",
            true,
          );
        }
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let selectedInput: Parameters<MediaProcessingStore["startAttempt"]>[0] | undefined;
        let claimed:
          | Extract<Awaited<ReturnType<MediaProcessingStore["startAttempt"]>>, { kind: "run" }>
          | undefined;
        const observedStore: MediaProcessingStore = {
          ...store,
          commitPublication: async (authority) => {
            const result = await store.commitPublication(authority);
            await pause("publication_commit");
            return result;
          },
          commitAlignment: async (authority, result) => {
            const committed = await store.commitAlignment(authority, result);
            await pause("alignment_commit");
            return committed;
          },
          startAttempt: async (input) => {
            if (
              input.stage === targetStage ||
              (stage === "audio_read" && input.stage === "acr_primary") ||
              (stage === "publication_commit" && input.stage === "publication") ||
              (stage === "alignment_commit" && input.stage === "alignment")
            )
              selectedInput = input;
            const result = await store.startAttempt(input);
            if (input === selectedInput && result.kind === "run") claimed = result;
            return result;
          },
        };
        let targetCalls = 0;
        const pause = async (selected: string) => {
          if (selected !== targetStage) return;
          targetCalls += 1;
          if (stage === "probe_recovery" && targetCalls > 1) return;
          entered.resolve();
          await release.promise;
        };
        const context = (
          binding: {
            operationId: string;
            audioRevision: number;
            analysisRevision: number;
            canonicalAudioSha256: string;
            requestId: string;
          },
          version: string,
        ) => ({
          operationId: binding.operationId,
          audioRevision: binding.audioRevision,
          analysisRevision: binding.analysisRevision,
          canonicalAudioSha256: binding.canonicalAudioSha256,
          requestId: binding.requestId,
          version,
          adapterRevision: "fixture-v1",
        });
        const unexpected = () => Effect.die(new Error("unexpected fixture provider"));
        let acrCalls = 0;
        const provider: MediaProcessingProviders = {
          transform: {
            probe: ((input: MediaTransformProbeInput) =>
              Effect.promise(async () => {
                await pause("probe");
                return {
                  status: "completed" as const,
                  attempt: input.attempt,
                  context: {
                    ...context(input.binding, "media-transform-attempt-context-v1"),
                    version: "media-transform-attempt-context-v1" as const,
                  },
                  probe: {
                    version: "media-transform-probe-v1" as const,
                    durationMs: 180000,
                    container: "mp3" as const,
                    mimeType: "audio/mpeg" as const,
                    tracks: [
                      {
                        kind: "audio" as const,
                        codec: "mp3",
                        channels: 2,
                        sampleRateHz: 44100,
                        bitrateBps: 192000,
                        bitrateMode: "constant" as const,
                      },
                    ],
                  },
                };
              })) as unknown as MediaTransformService["probe"],
            extractAudioSample: (input) =>
              Effect.promise(async () => {
                await pause(`sample_${input.variant}`);
                return {
                  status: "completed" as const,
                  attempt: {
                    ...input.attempt,
                    providerJobId:
                      input.attempt.providerJobId ?? `fixture-${input.binding.requestId}`,
                  },
                  context: {
                    ...context(input.binding, "media-transform-attempt-context-v1"),
                    version: "media-transform-attempt-context-v1" as const,
                  },
                  artifact: {
                    version: "media-transform-sample-artifact-v1" as const,
                    objectKey: `sample/${input.variant}`,
                    contentType: "audio/mpeg" as const,
                    byteLength: 4,
                    offsetMs: input.variant === "primary" ? 42000 : 126000,
                    durationMs: 12000,
                    variant: input.variant,
                    retainedObjectVerification: "required" as const,
                  },
                };
              }),
            extractCanonicalAudioSegment: unexpected,
            alignVideoSoundtrackToSong: unexpected,
            extractVideoAudio: unexpected,
            extractVideoFrames: unexpected,
            cancelJob: unexpected,
          },
          identification: {
            identify: (input) =>
              Effect.promise(async () => {
                acrCalls += 1;
                const selected = acrCalls === 1 ? "acr_primary" : "acr_alternate";
                await pause(selected);
                return {
                  context: {
                    ...context(input, "media-identification-attempt-context-v1"),
                    version: "media-identification-attempt-context-v1" as const,
                  },
                  outcome:
                    selected === "acr_primary"
                      ? ("inconclusive_fingerprint" as const)
                      : ("no_match" as const),
                };
              }),
          },
          artifactReader: {
            readAudioSample: async () => {
              await pause("audio_read");
              return new Uint8Array([1, 2, 3, 4]);
            },
            readCoverArtifact: async () => {
              await pause("cover_read");
              return new Uint8Array([5, 6, 7, 8]);
            },
          },
          metadata: {
            extract: async () => {
              await pause("metadata");
              return {
                evidenceRef: "fixture-metadata",
                adapterRevision: "fixture-v1",
                trackTitle: "Fixture song",
                cover:
                  stage === "cover" || stage === "cover_read"
                    ? {
                        status: "ready",
                        artifactRef: "fixture-cover",
                        artifactSha256: "b".repeat(64),
                        mediaType: "image/jpeg",
                        width: 1200,
                        height: 1200,
                        normalizationRevision: "fixture-v1",
                        safetyPolicyRevision: "fixture-v1",
                      }
                    : { status: "absent", reasonCode: "not_embedded" },
              };
            },
          },
          textModeration: {
            evaluate: (input) => {
              const canonical = canonicalTextModerationInput(input);
              if (canonical.kind !== "accepted") throw new Error("invalid text fixture");
              return Effect.gen(function* () {
                yield* Effect.promise(() => pause("text"));
                return {
                  provider_id: "openai",
                  requested_model: "omni-moderation-2024-09-26",
                  returned_model: "omni-moderation-2024-09-26",
                  input_sha256: canonical.sha256,
                  matched_categories: [],
                  inputs: [],
                } as const;
              });
            },
          },
          imageModeration: {
            evaluateImage: (input) =>
              Effect.gen(function* () {
                yield* Effect.promise(() => pause("cover"));
                return {
                  provider_id: "openai" as const,
                  requested_model: "omni-moderation-2024-09-26",
                  returned_model: "omni-moderation-2024-09-26",
                  input_sha256: input.sha256,
                  matched_categories: [],
                  evidence: {
                    input_sha256: input.sha256,
                    categories: Object.fromEntries(
                      MODERATION_POLICY_CATEGORIES_V1.map((category) => [category, false]),
                    ) as Record<(typeof MODERATION_POLICY_CATEGORIES_V1)[number], boolean>,
                    scores: Object.fromEntries(
                      MODERATION_POLICY_CATEGORIES_V1.map((category) => [category, 0]),
                    ) as Record<(typeof MODERATION_POLICY_CATEGORIES_V1)[number], number>,
                    applied_input_types: {
                      harassment: [],
                      "harassment/threatening": [],
                      hate: [],
                      "hate/threatening": [],
                      illicit: [],
                      "illicit/violent": [],
                      "self-harm": [],
                      "self-harm/instructions": [],
                      "self-harm/intent": [],
                      sexual: [],
                      "sexual/minors": [],
                      violence: [],
                      "violence/graphic": [],
                    },
                  },
                };
              }),
          },
          classifier: {
            classify: (input) =>
              Effect.gen(function* () {
                yield* Effect.promise(() => pause("classifier"));
                return {
                  version: "media-explicitness-classifier-result-v1" as const,
                  status: "classified" as const,
                  explicitness: "not_explicit" as const,
                  primary_language_bcp47: "en",
                  secondary_language_bcp47: null,
                  confidence: {
                    explicitness: 0.98,
                    primary_language: 0.97,
                    secondary_language: null,
                  },
                  evidence: [
                    { kind: "explicitness" as const, confidence: 0.98 },
                    { kind: "primary_language" as const, confidence: 0.97 },
                  ],
                  lyrics_identity: {
                    operation_id: input.accepted_lyrics.operation_id,
                    audio_revision: input.accepted_lyrics.audio_revision,
                    lyrics_revision: input.accepted_lyrics.lyrics_revision,
                    canonical_audio_sha256: input.accepted_lyrics.canonical_audio_sha256,
                  },
                  attempt_id: input.attempt.attempt_id,
                  policy_revision: "fixture-v1",
                  prompt_revision: "fixture-v1",
                  classifier_revision: "fixture-v1",
                  adapter_revision: "fixture-v1",
                };
              }),
          },
          alignment: {
            align: async () => {
              await pause("alignment");
              return { status: "unavailable", failureCode: "alignment_failed" };
            },
          },
        };
        const controller = new AbortController();
        const runWorkflowEffect = (activeStore: MediaProcessingStore = observedStore) =>
          runMediaProcessingWorkflow(
            {
              outboxId:
                stage === "alignment" || stage === "alignment_commit"
                  ? `media-alignment-outbox-${operation}-r2`
                  : stage === "publication_commit"
                    ? "media_pg_publication_checkpoint"
                    : "media_pg_analysis_outbox",
              submissionId: submission,
              operationId: operation,
              workflowRevision: stage === "alignment" || stage === "alignment_commit" ? 2 : 1,
            },
            stage === "alignment" || stage === "alignment_commit"
              ? "alignment"
              : stage === "publication_commit"
                ? "publication"
                : "analysis_launch",
            {
              store: activeStore,
              providers: provider,
              options: {
                enabled: true,
                workerId: "media-interruption-worker",
                now: Date.now,
                policyRevision: "fixture-v1",
                transformAdapterRevision: "fixture-v1",
                metadataAdapterRevision: "fixture-v1",
                classifierTimeoutMs: 10000,
                transformRuntimeMs: 60000,
                maximumSampleBytes: 1000000,
              },
            },
          );
        const runWorkflow = (activeStore: MediaProcessingStore = observedStore) =>
          Effect.runPromise(runWorkflowEffect(activeStore));
        const workflow = runWorkflowEffect();
        const parent = Effect.runPromiseExit(workflow, { signal: controller.signal });
        let workflowFailure: unknown;
        let parentSettled = false;
        const completed = parent.then(
          () => {
            parentSettled = true;
            return "completed";
          },
          (error: unknown) => {
            parentSettled = true;
            workflowFailure = error;
            return "rejected";
          },
        );
        try {
          const reached = await Promise.race([entered.promise.then(() => "entered"), completed]);
          if (reached === "rejected")
            throw new Error("workflow rejected before target barrier", { cause: workflowFailure });
          expect(reached).toBe("entered");
          const hasClaim = !["text", "cover", "cover_read"].includes(stage);
          if (hasClaim && selectedInput === undefined)
            throw new Error("target attempt was not reached");
          const rows = async () =>
            (
              await admin.query(
                "SELECT attempt_id,state,claim_owner,claim_fence,attempt_number,result AS result_snapshot,failure_code,lease_expires_at,lease_expires_at > clock_timestamp() AS live FROM media_processing_attempts ORDER BY attempt_id",
              )
            ).rows;
          const before = await rows();
          const beforeAuthority = await store.loadAuthority(submission, operation);
          if (stage === "publication_commit" || stage === "alignment_commit") {
            const durable = await store.loadAuthority(submission, operation);
            expect(durable).toMatchObject({
              status: "published",
              postId: `media-post-${operation}`,
              publishedLyricsRevision: 1,
            });
          }

          if (hasClaim) {
            if (claimed === undefined) throw new Error("target claim did not succeed");
            const targetAttemptId = claimed.lease.attemptId;
            const targetRows = before.filter((row) => row.attempt_id === targetAttemptId);
            expect(targetRows).toHaveLength(1);
            expect(targetRows[0]).toMatchObject({
              state: "running",
              claim_owner: claimed.lease.claimOwner,
              claim_fence: String(claimed.lease.claimFence),
              attempt_number: claimed.lease.attemptNumber,
              live: true,
              result_snapshot: null,
              failure_code: null,
            });
          }
          controller.abort();
          // The database mutation has already settled; release the harness's
          // post-commit observation barrier so the interrupted Effect can
          // reach its next checkpoint without holding the test open.
          if (stage === "publication_commit" || stage === "alignment_commit") {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            expect(parentSettled).toBe(false);
            release.resolve();
          }
          expect((await parent)._tag).toBe("Failure");
          if (selectedInput !== undefined)
            expect(
              await store.startAttempt({ ...selectedInput, workerId: "competing-worker" }),
            ).toEqual({ kind: "busy" });
          if (stage === "publication_commit" || stage === "alignment_commit") {
            expect(await runWorkflow(store)).toEqual({
              outcome: stage === "publication_commit" ? "inert" : "waiting_for_provider",
            });
            expect(await store.loadAuthority(submission, operation)).toEqual(beforeAuthority);
            const projection = await admin.query(
              "SELECT status,alignment_revision FROM media_alignment_projections WHERE submission_id=$1",
              [submission],
            );
            expect(projection.rows).toEqual([
              {
                status: stage === "publication_commit" ? "pending" : "unavailable",
                alignment_revision: stage === "publication_commit" ? "0" : "1",
              },
            ]);
          }
          if (stage === "probe_recovery") {
            if (claimed === undefined) throw new Error("missing interrupted lease");
            await admin.query(
              "SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM (lease_expires_at-clock_timestamp())))) FROM media_processing_attempts WHERE attempt_id=$1",
              [claimed.lease.attemptId],
            );
            const recoveredAttemptId = claimed.lease.attemptId;
            const recovery = await runWorkflow(store);
            expect(recovery).toEqual({ outcome: "published" });
            const recoveredRows = await rows();
            const recoveredAuthority = await store.loadAuthority(submission, operation);
            expect(recoveredAuthority).toMatchObject({
              status: "published",
              postId: `media-post-${operation}`,
              phase: null,
            });
            expect(recoveredAuthority?.analysis).not.toBeNull();
            expect(
              recoveredRows.filter((row) => row.attempt_id === recoveredAttemptId),
            ).toMatchObject([
              {
                state: "succeeded",
                attempt_number: 1,
                claim_fence: String(claimed.lease.claimFence + 1),
                failure_code: null,
              },
            ]);
            expect(targetCalls).toBe(2);
            release.resolve();
            expect(await completed).toBe("completed");
            expect({
              attempts: await rows(),
              authority: await store.loadAuthority(submission, operation),
            }).toEqual({ attempts: recoveredRows, authority: recoveredAuthority });
            return;
          }
          release.resolve();
          await completed;
          const after = await rows();
          const afterAuthority = await store.loadAuthority(submission, operation);
          expect({ attempts: after, authority: afterAuthority }).toEqual({
            attempts: before,
            authority: beforeAuthority,
          });
        } finally {
          controller.abort();
          release.resolve();
          await completed;
        }
      });
      completedTestCount += 1;
    }, 40000);
  }

  test("reclaims an expired processing lease with prior progress and rejects every stale mutation", async () => {
    await withCurrentSchema(async (admin, connection) => {
      await createThroughDecision(connection);
      const store = makeMediaProcessingStore(makeDirectPostgresControlPlaneLayer(connection), {
        attemptLeaseSeconds: 1,
        retryBaseMs: 1,
      });
      const current = await store.loadAuthority(submission, operation);
      if (current === null) throw new Error("missing fixture authority");
      const input = {
        authority: current,
        stage: "probe" as const,
        attemptId: "media-pg-expiry-probe",
        workerId: "original-worker",
        inputRevision: 1,
        inputHash: audioSha256,
        policyRevision: "fixture-v1",
        adapterRevision: "fixture-v1",
      };
      const first = await store.startAttempt(input);
      if (first.kind !== "run") throw new Error("initial claim did not run");
      const progress = {
        kind: "probe" as const,
        value: {
          status: "submitted" as const,
          attempt: {
            version: "media-transform-attempt-v1" as const,
            runtimeFence: { submittedAtMs: 1, runtimeDeadlineMs: 60001 },
            providerJobId: "preserved-provider-job",
          },
        },
      };
      expect(await store.deferAttempt(first.lease, progress, 1)).toBe(true);
      await admin.query(
        "SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM (next_eligible_at-clock_timestamp())))) FROM media_processing_attempts WHERE attempt_id=$1",
        [first.lease.attemptId],
      );
      const resumed = await store.startAttempt(input);
      if (resumed.kind !== "run") throw new Error("progress claim did not resume");
      expect(resumed.lease).toMatchObject({ attemptNumber: 1, priorResult: progress });
      expect(await store.startAttempt({ ...input, workerId: "recovery-worker" })).toEqual({
        kind: "busy",
      });
      await admin.query(
        "SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM (lease_expires_at-clock_timestamp())))) FROM media_processing_attempts WHERE attempt_id=$1",
        [resumed.lease.attemptId],
      );
      const reclaimed = await store.startAttempt({ ...input, workerId: "recovery-worker" });
      if (reclaimed.kind !== "run") throw new Error("expired claim did not resume");
      expect(reclaimed.lease).toMatchObject({ attemptNumber: 1, priorResult: progress });
      expect(reclaimed.lease.claimFence).toBeGreaterThan(resumed.lease.claimFence);
      const result = {
        kind: "probe" as const,
        value: {
          status: "rejected" as const,
          reason: "unsupported_codec" as const,
          attempt: progress.value.attempt,
        },
      };
      expect(await store.completeAttempt(resumed.lease, result)).toBe(false);
      expect(await store.deferAttempt(resumed.lease, progress, 1)).toBe(false);
      expect(await store.failAttempt(resumed.lease, "provider_unavailable", true)).toBe(false);
      expect(await store.completeAttempt(reclaimed.lease, result)).toBe(true);
      expect(await store.startAttempt(input)).toEqual({ kind: "replay", result });
    });
    completedTestCount += 1;
  }, 40000);

  test("installs the general-audience cover evidence and projection gate", async () => {
    await withCurrentSchema(async (admin) => {
      const columns = await admin.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'media_analysis_evidence'
            AND column_name IN (
              'cover_moderation_decision', 'cover_moderation_reason',
              'cover_moderation_matched_categories', 'cover_moderation_evidence'
            )
          ORDER BY column_name`,
      );
      const projection = await admin.query<{ definition: string }>(
        `SELECT pg_get_functiondef(
           'validate_media_publication_projection_insert_v2()'::regprocedure
         ) AS definition`,
      );

      expect(columns.rows).toEqual([
        { column_name: "cover_moderation_decision", is_nullable: "NO" },
        { column_name: "cover_moderation_evidence", is_nullable: "YES" },
        { column_name: "cover_moderation_matched_categories", is_nullable: "NO" },
        { column_name: "cover_moderation_reason", is_nullable: "NO" },
      ]);
      expect(projection.rows[0]?.definition).toContain(
        "analysis_record.cover_moderation_decision='allow'",
      );
    }, false);
    completedTestCount += 1;
  }, 40_000);

  test("persists provider unavailability as a review hold without a publication decision", async () => {
    await withCurrentSchema(async (admin, connection) => {
      await createThroughDecision(connection, decision, analysis, true);
      const layer = makeDirectPostgresControlPlaneLayer(connection);
      const store = makeMediaProcessingStore(layer);
      const authority = await store.loadAuthority(submission, operation);
      expect(authority).not.toBeNull();
      if (authority === null) return;
      expect(await store.commitProviderUnavailableReview(authority, "provider_exhausted")).toBe(
        "committed",
      );
      const held = await admin.query<{
        status: string;
        review_reason_code: string | null;
        review_exhaustion_code: string | null;
        current_decision_revision: number | null;
        event_kind: string;
      }>(
        `SELECT submission.status, submission.review_reason_code,
                submission.review_exhaustion_code, submission.current_decision_revision,
                event.event_kind
         FROM media_post_submissions submission
         JOIN media_submission_events event
           ON event.submission_id=submission.submission_id
          AND event.event_sequence=submission.event_sequence
         WHERE submission.submission_id=$1`,
        [submission],
      );
      expect(held.rows).toEqual([
        {
          status: "manual_review",
          review_reason_code: "moderation_unavailable",
          review_exhaustion_code: null,
          current_decision_revision: null,
          event_kind: "provider_unavailable_review_recorded",
        },
      ]);
      expect(
        await admin.query("SELECT 1 FROM media_publication_decisions WHERE submission_id=$1", [
          submission,
        ]),
      ).toMatchObject({ rowCount: 0 });
    });
    completedTestCount += 1;
  }, 40_000);

  test("reloads authority and durably resumes provider polling and numbered retries", async () => {
    await withCurrentSchema(async (_admin, connection) => {
      await createThroughDecision(connection);
      const layer = makeDirectPostgresControlPlaneLayer(connection);
      const store = makeMediaProcessingStore(layer, { retryBaseMs: 1 });
      const authority = await store.loadAuthority(submission, operation);
      expect(authority).not.toBeNull();
      if (authority === null) return;
      expect(authority).toMatchObject({ analysisRevision: 1, retryCount: 0 });

      const startInput = {
        authority,
        stage: "probe" as const,
        attemptId: "media-pg-runtime-probe",
        workerId: "media-pg-worker",
        inputRevision: 1,
        inputHash: audioSha256,
        policyRevision: "media-pg-policy-v1",
        adapterRevision: "media-pg-adapter-v1",
      };
      const first = await store.startAttempt(startInput);
      expect(first).toMatchObject({ kind: "run", lease: { attemptNumber: 1 } });
      if (first.kind !== "run") return;
      const progress = {
        kind: "probe" as const,
        value: {
          status: "submitted" as const,
          attempt: {
            version: "media-transform-attempt-v1" as const,
            runtimeFence: { submittedAtMs: 1, runtimeDeadlineMs: 60_001 },
            providerJobId: "media-pg-assembly-1",
          },
        },
      };
      expect(await store.deferAttempt(first.lease, progress, 1)).toBe(true);
      await Bun.sleep(5);
      const resumed = await store.startAttempt(startInput);
      expect(resumed).toMatchObject({
        kind: "run",
        lease: {
          attemptNumber: 1,
          priorResult: { value: { attempt: { providerJobId: "media-pg-assembly-1" } } },
        },
      });
      if (resumed.kind !== "run") return;
      expect(
        await store.completeAttempt(resumed.lease, {
          kind: "probe",
          value: {
            status: "rejected",
            reason: "unsupported_codec",
            attempt: progress.value.attempt,
          },
        }),
      ).toBe(true);
      expect(await store.startAttempt(startInput)).toMatchObject({
        kind: "replay",
        result: { kind: "probe", value: { reason: "unsupported_codec" } },
      });

      const retryInput = {
        ...startInput,
        stage: "sample_primary" as const,
        attemptId: "media-pg-runtime-sample",
      };
      const retryOne = await store.startAttempt(retryInput);
      if (retryOne.kind !== "run") return;
      expect(await store.failAttempt(retryOne.lease, "provider_timeout", true)).toBe(true);
      await Bun.sleep(5);
      const retryTwo = await store.startAttempt(retryInput);
      expect(retryTwo).toMatchObject({ kind: "run", lease: { attemptNumber: 2 } });
      if (retryTwo.kind !== "run") return;
      expect(await store.failAttempt(retryTwo.lease, "provider_timeout", true)).toBe(true);
      await Bun.sleep(5);
      const retryThree = await store.startAttempt(retryInput);
      expect(retryThree).toMatchObject({ kind: "run", lease: { attemptNumber: 3 } });
      if (retryThree.kind !== "run") return;
      expect(await store.failAttempt(retryThree.lease, "provider_timeout", true)).toBe(true);
      expect(await store.startAttempt(retryInput)).toEqual({ kind: "exhausted" });

      expect(
        await run(connection, (_submissionStore, outboxStore) => outboxStore.listEligible(10)),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ outboxEventId: "media_pg_analysis_outbox" }),
        ]),
      );
    });
    completedTestCount += 1;
  }, 40_000);

  test("binds lyrics after sealed finalization before independent terms", async () => {
    await withCurrentSchema(async (admin, connection) => {
      const authorReviewedLyrics = "Author reviewed lyrics ".repeat(30);
      expect(
        await run(connection, (store) =>
          store.reserve({
            communityId: community,
            actorUserId: actor,
            personaId: personaFor(connection),
            idempotencyKey: "reserve-key",
            requestHash,
            expectedContentType: "audio/mpeg",
            expectedSizeBytes: audioBytes.byteLength,
            expectedSha256: audioSha256,
            uploadUrl: "https://upload.test/media",
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            responseBytes,
            responseSha256,
            reservationId: reservation,
          }),
        ),
      ).toMatchObject({ kind: "created" });
      expect(
        await run(connection, (store) =>
          store.createSubmission({
            communityId: community,
            actorUserId: actor,
            personaId: personaFor(connection),
            idempotencyKey: "create-key",
            requestHash,
            title: "Independent lyrics song",
            songType: "original",
            reservationId: reservation,
            submissionId: submission,
            operationId: operation,
            responseBytes,
            responseSha256,
          }),
        ),
      ).toMatchObject({ kind: "created" });
      expect(
        await run(connection, (store) =>
          store.beginFinalize(finalizeFence(connection, "finalize-key", 1)),
        ),
      ).toMatchObject({ kind: "begun", submissionId: submission, operationId: operation });
      expect(
        await run(connection, (store) =>
          store.finalizeSealed({
            ...command(
              connection,
              "/media-post-submissions/:submissionId/finalize",
              "finalize-key",
            ),
            expectedCreationRevision: 1,
            expectedAudioRevision: 0,
            reservationId: reservation,
            immutableObject: {
              immutableRef: analysis.finalizedAudioRef,
              destinationRef: "media://immutable/fixture",
              etag: "etag-1",
              objectVersion: "version-1",
              sizeBytes: audioBytes.byteLength,
              contentType: "audio/mpeg",
              canonicalSha256: audioSha256,
            },
            outbox: {
              outboxEventId: "media_pg_analysis_outbox",
              effectIdentity: "media_pg_analysis_effect",
              payload: {
                kind: "analysis_launch",
                submission_id: submission,
                operation_id: operation,
                audio_revision: 1,
                analysis_revision: 0,
                workflow_revision: 1,
                workflow_instance_id: `media-${operation}-r1`,
              },
            },
          }),
        ),
      ).toMatchObject({ kind: "committed" });
      expect(
        await run(connection, (store) =>
          store.bindLyrics({
            ...command(connection, "/media-post-submissions/:submissionId/lyrics", "lyrics-key"),
            expectedCreationRevision: 1,
            expectedAudioRevision: 1,
            lyrics: authorReviewedLyrics,
            outbox: {
              outboxEventId: "media_pg_lyrics_outbox",
              effectIdentity: "media_pg_lyrics_effect",
              payload: {
                kind: "decision_wakeup",
                submission_id: submission,
                operation_id: operation,
                creation_revision: 2,
                lyrics_revision: 1,
                trigger: "lyrics",
                workflow_revision: 1,
                workflow_instance_id: `media-${operation}-r1`,
              },
            },
          }),
        ),
      ).toEqual({ kind: "committed", submissionId: submission });
      expect(authorReviewedLyrics.length).toBeGreaterThan(512);
      expect(
        await run(connection, (store) =>
          store.getForAuthor({
            communityId: community,
            submissionId: submission,
            actorUserId: actor,
            personaId: personaFor(connection),
          }),
        ),
      ).toMatchObject({ lyrics: { text: authorReviewedLyrics, lyricsRevision: 1 } });
      expect(
        (
          await admin.query(
            "SELECT creation_revision,current_terms_revision,current_lyrics_revision,status,phase FROM media_post_submissions WHERE submission_id=$1",
            [submission],
          )
        ).rows[0],
      ).toEqual({
        creation_revision: "2",
        current_terms_revision: null,
        current_lyrics_revision: "1",
        status: "processing",
        phase: "analysis",
      });
      expect(
        (
          await admin.query(
            "SELECT count(*)::text AS count FROM media_submission_terms WHERE submission_id=$1",
            [submission],
          )
        ).rows[0]?.count,
      ).toBe("0");
      await expect(
        run(connection, (_store, outbox) =>
          outbox.enqueue({
            outboxEventId: "media_pg_analysis_outbox",
            submissionId: submission,
            communityId: community,
            actorUserId: actor,
            personaId: personaFor(connection),
            operationId: operation,
            creationRevision: 2,
            audioRevision: 1,
            analysisRevision: 0,
            lyricsRevision: 1,
            workflowRevision: 1,
            workflowInstanceId: `media-${operation}-r1`,
            eventType: "analysis_launch",
            effectIdentity: "media_pg_analysis_effect",
            payload: {
              kind: "analysis_launch",
              submission_id: submission,
              operation_id: operation,
              audio_revision: 1,
              analysis_revision: 0,
              workflow_revision: 1,
              workflow_instance_id: `media-${operation}-r1`,
            },
          }),
        ),
      ).rejects.toMatchObject({ reason: "identity-conflict" });
      await expect(
        run(connection, (store) =>
          store.bindTerms({
            ...command(
              connection,
              "/media-post-submissions/:submissionId/terms",
              "account-recipient-terms-key",
            ),
            expectedCreationRevision: 2,
            terms: termsFor(actor),
            outbox: {
              outboxEventId: "media_pg_account_recipient_terms_outbox",
              effectIdentity: "media_pg_account_recipient_terms_effect",
              payload: {
                kind: "decision_wakeup",
                submission_id: submission,
                operation_id: operation,
                creation_revision: 3,
                lyrics_revision: 1,
                trigger: "terms",
                workflow_revision: 1,
                workflow_instance_id: `media-${operation}-r1`,
              },
            },
          }),
        ),
      ).rejects.toBeDefined();
      expect(
        (
          await admin.query(
            "SELECT count(*)::text AS count FROM media_submission_terms WHERE submission_id=$1",
            [submission],
          )
        ).rows[0]?.count,
      ).toBe("0");
      expect(
        await run(connection, (store) =>
          store.bindTerms({
            ...command(connection, "/media-post-submissions/:submissionId/terms", "terms-key"),
            expectedCreationRevision: 2,
            terms: termsFor(personaFor(connection)),
            outbox: {
              outboxEventId: "media_pg_terms_outbox",
              effectIdentity: "media_pg_terms_effect",
              payload: {
                kind: "decision_wakeup",
                submission_id: submission,
                operation_id: operation,
                creation_revision: 3,
                lyrics_revision: 1,
                trigger: "terms",
                workflow_revision: 1,
                workflow_instance_id: `media-${operation}-r1`,
              },
            },
          }),
        ),
      ).toEqual({ kind: "committed", submissionId: submission });
      expect(
        (
          await admin.query(
            "SELECT creation_revision,current_terms_revision,current_lyrics_revision FROM media_post_submissions WHERE submission_id=$1",
            [submission],
          )
        ).rows[0],
      ).toEqual({
        creation_revision: "3",
        current_terms_revision: "3",
        current_lyrics_revision: "1",
      });
      expect(
        (
          await admin.query(
            "SELECT creation_revision FROM media_submission_terms WHERE submission_id=$1",
            [submission],
          )
        ).rows,
      ).toEqual([{ creation_revision: "3" }]);
    });
    completedTestCount += 1;
  }, 40_000);
  test("emits exact terms decision wakeup and lost-workflow replacement identities", async () => {
    await withCurrentSchema(async (admin, connection) => {
      await createThroughDecision(connection, decision, analysis, true);
      expect(
        await run(connection, (store) =>
          store.bindTerms({
            ...command(connection, "/media-post-submissions/:submissionId/terms", "terms-refresh"),
            expectedCreationRevision: 2,
            terms: termsFor(personaFor(connection)),
            outbox: {
              outboxEventId: "media_pg_terms_wakeup_outbox",
              effectIdentity: "media_pg_terms_wakeup_effect",
              payload: {
                kind: "decision_wakeup",
                submission_id: submission,
                operation_id: operation,
                creation_revision: 3,
                lyrics_revision: null,
                trigger: "terms",
                workflow_revision: 1,
                workflow_instance_id: `media-${operation}-r1`,
              },
            },
          }),
        ),
      ).toEqual({ kind: "committed", submissionId: submission });
      expect(
        await run(connection, (store) =>
          store.replaceLostWorkflow({
            communityId: community,
            submissionId: submission,
            actorUserId: actor,
            personaId: personaFor(connection),
            expectedWorkflowRevision: 1,
            outbox: {
              outboxEventId: "media_pg_workflow_replacement_outbox",
              effectIdentity: "media_pg_workflow_replacement_effect",
              payload: {
                kind: "workflow_replacement",
                submission_id: submission,
                operation_id: operation,
                replacement_sequence: 1,
                workflow_revision: 2,
                workflow_instance_id: `media-${operation}-r2`,
              },
            },
          }),
        ),
      ).toMatchObject({
        kind: "committed",
        submissionId: submission,
        outboxEventId: "media_pg_workflow_replacement_outbox",
      });
      expect(
        (
          await admin.query(
            "SELECT workflow_revision,workflow_replacement_sequence FROM media_post_submissions WHERE submission_id=$1",
            [submission],
          )
        ).rows[0],
      ).toEqual({ workflow_revision: "2", workflow_replacement_sequence: "1" });
      expect(
        (
          await admin.query(
            "SELECT event_type,payload FROM media_submission_outbox WHERE outbox_event_id IN ('media_pg_terms_wakeup_outbox','media_pg_workflow_replacement_outbox') ORDER BY event_type",
          )
        ).rows.map(({ event_type, payload }) => ({
          event_type,
          payload: typeof payload === "string" ? JSON.parse(payload) : payload,
        })),
      ).toEqual([
        {
          event_type: "decision_wakeup",
          payload: {
            kind: "decision_wakeup",
            submission_id: submission,
            operation_id: operation,
            creation_revision: 3,
            lyrics_revision: null,
            trigger: "terms",
            workflow_revision: 1,
            workflow_instance_id: `media-${operation}-r1`,
          },
        },
        {
          event_type: "workflow_replacement",
          payload: {
            kind: "workflow_replacement",
            submission_id: submission,
            operation_id: operation,
            replacement_sequence: 1,
            workflow_revision: 2,
            workflow_instance_id: `media-${operation}-r2`,
          },
        },
      ]);
    });
    completedTestCount += 1;
  }, 40_000);
  test("scopes media reservation and submission replay by persona", async () => {
    await withCurrentSchema(async (admin, connection) => {
      const firstPersona = (
        await admin.query<{ persona_id: string }>(
          "SELECT persona_id FROM personas WHERE account_id=$1 AND is_first_persona",
          [actor],
        )
      ).rows[0]?.persona_id;
      if (firstPersona === undefined) throw new Error("missing first test persona");
      const secondPersona = "media_pg_second_persona";
      await createActivePersonaFixture(admin, {
        accountId: actor,
        personaId: secondPersona,
        profile: { displayName: "Second media persona" },
      });
      await admin.query(
        `INSERT INTO persona_community_bindings (
           persona_id, account_id, community_id, binding_source
         ) VALUES ($1,$2,$3,'first_membership')`,
        [secondPersona, actor, community],
      );
      const reserve = (personaId: string, reservationId: string) =>
        run(connection, (store) =>
          store.reserve({
            communityId: community,
            actorUserId: actor,
            personaId,
            idempotencyKey: "same-persona-replay-key",
            requestHash,
            expectedContentType: "audio/mpeg",
            expectedSizeBytes: audioBytes.byteLength,
            expectedSha256: audioSha256,
            uploadUrl: "https://upload.test/persona",
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            responseBytes,
            responseSha256,
            reservationId,
          }),
        );
      expect(await reserve(firstPersona, "persona-reservation-first")).toMatchObject({
        kind: "created",
      });
      expect(await reserve(secondPersona, "persona-reservation-second")).toMatchObject({
        kind: "created",
      });
      await run(connection, (store) =>
        store.createSubmission({
          communityId: community,
          actorUserId: actor,
          personaId: firstPersona,
          idempotencyKey: "same-persona-submission-key",
          requestHash,
          title: "First persona song",
          songType: "original",
          reservationId: "persona-reservation-first",
          submissionId: "persona-submission-first",
          operationId: "persona-operation-first",
          responseBytes,
          responseSha256,
        }),
      );
      await run(connection, (store) =>
        store.createSubmission({
          communityId: community,
          actorUserId: actor,
          personaId: secondPersona,
          idempotencyKey: "same-persona-submission-key",
          requestHash,
          title: "Second persona song",
          songType: "original",
          reservationId: "persona-reservation-second",
          submissionId: "persona-submission-second",
          operationId: "persona-operation-second",
          responseBytes,
          responseSha256,
        }),
      );
      const rows = await admin.query<{
        submission_id: string;
        author_persona_id: string;
        persona_id: string | null;
      }>(
        "SELECT submission_id,author_persona_id,start_input->>'persona_id' AS persona_id FROM media_post_submissions WHERE submission_id IN ('persona-submission-first','persona-submission-second') ORDER BY submission_id",
      );
      expect(rows.rows).toEqual([
        {
          submission_id: "persona-submission-first",
          author_persona_id: firstPersona,
          persona_id: firstPersona,
        },
        {
          submission_id: "persona-submission-second",
          author_persona_id: secondPersona,
          persona_id: secondPersona,
        },
      ]);
      const reservations = await admin.query<{
        reservation_id: string;
        actor_persona_id: string;
      }>(
        "SELECT reservation_id,actor_persona_id FROM media_upload_reservations WHERE idempotency_key='same-persona-replay-key' ORDER BY reservation_id",
      );
      expect(reservations.rows).toEqual([
        { reservation_id: "persona-reservation-first", actor_persona_id: firstPersona },
        { reservation_id: "persona-reservation-second", actor_persona_id: secondPersona },
      ]);
    });
    completedTestCount += 1;
  }, 40_000);
  test("reclaims an expired outbox lease and rejects the stale fence", async () => {
    await withCurrentSchema(async (_admin, connection) => {
      await createThroughDecision(connection);
      expect(
        await run(connection, (store) =>
          store.recordProcessingAttempt({
            attemptId: "media_pg_attempt",
            communityId: community,
            submissionId: submission,
            actorUserId: actor,
            personaId: personaFor(connection),
            operationId: operation,
            audioRevision: 1,
            analysisRevision: 1,
            stage: "probe",
            inputKind: "audio",
            inputRevision: 1,
            policyRevision: "probe-policy-1",
            adapterRevision: "probe-adapter-1",
            inputHash: "c".repeat(64),
          }),
        ),
      ).toBeUndefined();
      await expect(
        run(connection, (store) =>
          store.recordProcessingAttempt({
            attemptId: "media_pg_attempt",
            communityId: community,
            submissionId: submission,
            actorUserId: actor,
            personaId: personaFor(connection),
            operationId: operation,
            audioRevision: 1,
            analysisRevision: 1,
            stage: "probe",
            inputKind: "audio",
            inputRevision: 1,
            policyRevision: "probe-policy-1",
            adapterRevision: "probe-adapter-1",
            inputHash: "c".repeat(64),
            providerIdempotencyKey: "changed-provider-key",
          }),
        ),
      ).rejects.toThrow();
      expect(
        await run(connection, (store) =>
          store.claimProcessingAttempt({
            attemptId: "media_pg_attempt",
            workerId: "attempt_worker",
            leaseSeconds: 30,
          }),
        ),
      ).toBe(true);
      expect(
        await run(connection, (store) =>
          store.failProcessingAttempt({
            attemptId: "media_pg_attempt",
            workerId: "attempt_worker",
            claimFence: 1,
            failureCode: "probe_failed",
            retryable: true,
            nextEligibleAt: new Date(Date.now() + 1_000).toISOString(),
          }),
        ),
      ).toBe(true);
      const first = await run(connection, (_store, outbox) =>
        outbox.claim({
          outboxEventId: "media_pg_analysis_outbox",
          workflowRevision: 1,
          workerId: "worker_a",
          leaseSeconds: 1,
        }),
      );
      expect(first).toMatchObject({ state: "running", claimOwner: "worker_a", claimFence: 1 });
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const second = await run(connection, (_store, outbox) =>
        outbox.claim({
          outboxEventId: "media_pg_analysis_outbox",
          workflowRevision: 1,
          workerId: "worker_b",
          leaseSeconds: 30,
        }),
      );
      expect(second).toMatchObject({ state: "running", claimOwner: "worker_b", claimFence: 2 });
      expect(
        await run(connection, (_store, outbox) =>
          outbox.markDelivered({
            outboxEventId: "media_pg_analysis_outbox",
            workflowRevision: 1,
            workflowInstanceId: `media-${operation}-r1`,
            workerId: "worker_a",
            claimFence: 1,
          }),
        ),
      ).toBe(false);
      expect(
        await run(connection, (_store, outbox) =>
          outbox.markDelivered({
            outboxEventId: "media_pg_analysis_outbox",
            workflowRevision: 1,
            workflowInstanceId: `media-${operation}-r1`,
            workerId: "worker_b",
            claimFence: 2,
          }),
        ),
      ).toBe(true);
    });
    completedTestCount += 1;
  }, 40_000);
  test("aligns owner application authority with the media action trigger", async () => {
    await withCurrentSchema(async (admin, connection) => {
      await createThroughDecision(connection, reviewDecision);
      await expectHostileLyricsProjectionLeakRejected(admin);
      const unused = async (): Promise<never> => {
        throw new Error("unused media application dependency");
      };
      const commands = makeMediaUploadApplicationCommands({
        store: makeMediaUploadStore(makeDirectPostgresControlPlaneLayer(connection)),
        personaStore: {
          findOwned: () => Effect.die("unused media moderation persona lookup"),
        },
        presigner: {
          presign: () => Effect.die("unused media moderation presigner"),
        },
        sealer: { inspect: unused, seal: unused },
        nowIso: () => "2026-08-27T00:00:00.000Z",
      });
      const body = {
        idempotency_key: "moderate-key",
        expected_creation_revision: 2,
        action: "approve" as const,
        approval_kind: "standard" as const,
      };

      await expect(
        commands.moderate({
          submissionId: submission,
          actor: { userId: actor, kind: "admin", scopes: ["moderation", "moderator"] },
          body: { ...body, idempotency_key: "scope-only-admin" },
        }),
      ).rejects.toBeInstanceOf(NotFound);
      expect(
        await admin.query("SELECT 1 FROM media_moderation_actions WHERE submission_id=$1", [
          submission,
        ]),
      ).toMatchObject({ rowCount: 0 });

      await expect(
        commands.moderate({
          submissionId: submission,
          actor: { userId: moderator, kind: "user" },
          body,
        }),
      ).resolves.toMatchObject({ status: "processing", phase: "publish" });
      const state = await run(connection, (store) =>
        store.getForAuthor({
          communityId: community,
          submissionId: submission,
          actorUserId: actor,
          personaId: personaFor(connection),
        }),
      );
      expect(state).toMatchObject({ status: "processing", phase: "publish", decisionRevision: 2 });
      const persisted = await admin.query(
        "SELECT moderator_actor_id,decision_revision FROM media_moderation_projections WHERE submission_id=$1",
        [submission],
      );
      expect(persisted.rows[0]).toEqual({ moderator_actor_id: moderator, decision_revision: "2" });
    });
    completedTestCount += 1;
  }, 40_000);
  test("persists policy-violation moderator blocks and scopes replay to authority", async () => {
    await withCurrentSchema(async (admin, connection) => {
      await createThroughDecision(connection, reviewDecision);
      const endpointTemplate = "/media-post-submissions/:submissionId/moderate";
      const idempotencyKey = "moderator-block-key";
      expect(
        await run(connection, (store) =>
          store.moderate({
            ...command(connection, endpointTemplate, idempotencyKey),
            expectedCreationRevision: 2,
            action: "block",
            actor: { userId: moderator, kind: "user" },
          }),
        ),
      ).toMatchObject({ kind: "committed" });
      expect(
        (
          await admin.query(
            "SELECT status,moderator_reason_code FROM media_post_submissions WHERE submission_id=$1",
            [submission],
          )
        ).rows[0],
      ).toEqual({ status: "blocked", moderator_reason_code: "policy_violation" });
      expect(
        (
          await admin.query(
            "SELECT action_kind,reason_code,authority_actor_user_id,decision_snapshot FROM media_moderation_actions WHERE submission_id=$1",
            [submission],
          )
        ).rows[0],
      ).toEqual({
        action_kind: "block",
        reason_code: "policy_violation",
        authority_actor_user_id: moderator,
        decision_snapshot: { reasonCode: "policy_violation" },
      });
      expect(
        await run(connection, (store) =>
          store.getForAuthor({
            communityId: community,
            submissionId: submission,
            actorUserId: actor,
            personaId: personaFor(connection),
          }),
        ),
      ).toMatchObject({
        status: "blocked",
        moderatorApproval: { reasonCode: "policy_violation", moderatorActorId: moderator },
      });
      expect(
        (
          await admin.query(
            "SELECT event_kind,evidence->>'reason_code' AS reason_code FROM media_submission_events WHERE submission_id=$1 ORDER BY event_sequence DESC LIMIT 1",
            [submission],
          )
        ).rows[0],
      ).toEqual({ event_kind: "moderator_blocked", reason_code: "policy_violation" });
      expect(
        await run(connection, (store) =>
          store.replay({
            communityId: community,
            actorUserId: moderator,
            personaId: null,
            endpointTemplate,
            idempotencyKey,
            requestHash,
          }),
        ),
      ).toMatchObject({ kind: "replay", submissionId: submission });
      expect(
        await run(connection, (store) =>
          store.replay({
            communityId: community,
            actorUserId: "media_pg_other_moderator",
            personaId: null,
            endpointTemplate,
            idempotencyKey,
            requestHash,
          }),
        ),
      ).toEqual({ kind: "none" });
      await admin.query("BEGIN");
      await admin.query(
        "INSERT INTO media_song_lyrics_revisions (submission_id,community_id,actor_user_id,author_persona_id,operation_id,lyrics_revision,creation_revision,audio_revision,canonical_audio_sha256,lyrics_text,lyrics_sha256,base_transcript_revision,provenance) VALUES ($1,$2,$3,$4,$5,1,3,1,$6,'hostile blocked edit',encode(sha256(convert_to('hostile blocked edit','UTF8')),'hex'),NULL,'pasted')",
        [submission, community, actor, personaFor(connection), operation, audioSha256],
      );
      await expect(
        admin.query(
          "UPDATE media_post_submissions SET creation_revision=3,current_terms_revision=3,lyrics_revision=1,current_lyrics_revision=1,current_analysis_revision=NULL,decision_revision=0,current_decision_revision=NULL,status='processing',phase='analysis',moderator_action_id=NULL,moderator_actor_id=NULL,moderator_evidence_ref=NULL,moderator_approval_kind=NULL,moderator_reason_code=NULL,event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE submission_id=$1",
          [submission],
        ),
      ).rejects.toThrow("lyrics projection transition is not exact");
      await admin.query("ROLLBACK");
    });
    completedTestCount += 1;
  }, 40_000);
  test("rejects abandoned submissions reopening through a hostile lyrics edit", async () => {
    await withCurrentSchema(async (admin, connection) => {
      const requiresReference = {
        ...analysis,
        acr: { ...analysis.acr, decision: "requires_reference" as const },
      };
      await createThroughDecision(connection, decision, requiresReference, true);
      expect(
        await run(connection, (store) =>
          store.requireReference({
            ...command(
              connection,
              "/media-post-submissions/:submissionId/reference",
              "abandon-reference-required",
            ),
            expectedCreationRevision: 2,
            expectedAudioRevision: 1,
            expectedAnalysisRevision: 1,
            referenceRequestRef: "abandon-reference-request",
            actionExpiresAt: new Date(Date.now() + 100).toISOString(),
          }),
        ),
      ).toMatchObject({ kind: "committed" });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(
        await run(connection, (store) =>
          store.actionDeadlineElapsed({
            ...command(connection, "/media-post-submissions/:submissionId/expire", "deadline-key"),
            expectedCreationRevision: 2,
          }),
        ),
      ).toMatchObject({ kind: "committed" });
      await admin.query("BEGIN");
      await admin.query(
        "INSERT INTO media_song_lyrics_revisions (submission_id,community_id,actor_user_id,author_persona_id,operation_id,lyrics_revision,creation_revision,audio_revision,canonical_audio_sha256,lyrics_text,lyrics_sha256,base_transcript_revision,provenance) VALUES ($1,$2,$3,$4,$5,1,3,1,$6,'hostile abandoned edit',encode(sha256(convert_to('hostile abandoned edit','UTF8')),'hex'),NULL,'pasted')",
        [submission, community, actor, personaFor(connection), operation, audioSha256],
      );
      await expect(
        admin.query(
          "UPDATE media_post_submissions SET creation_revision=3,current_terms_revision=3,lyrics_revision=1,current_lyrics_revision=1,current_analysis_revision=NULL,decision_revision=0,current_decision_revision=NULL,status='processing',phase='analysis',action_kind=NULL,action_reference_request_ref=NULL,action_expires_at=NULL,abandonment_reason=NULL,retention_disposition=NULL,event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE submission_id=$1",
          [submission],
        ),
      ).rejects.toThrow("lyrics projection transition is not exact");
      await admin.query("ROLLBACK");
      expect(
        (
          await admin.query("SELECT status FROM media_post_submissions WHERE submission_id=$1", [
            submission,
          ])
        ).rows[0],
      ).toEqual({ status: "abandoned" });
    });
    completedTestCount += 1;
  }, 40_000);
  test("records bounded typed failure retries and exact abandonment reasons", async () => {
    await withCurrentSchema(async (admin, connection) => {
      await createThroughDecision(connection);
      for (const retryCount of [0, 1, 2] as const) {
        const failureResult = await run(connection, (store) =>
          store.recordMediaFailure({
            ...command(
              connection,
              "/media-post-submissions/:submissionId/failure",
              `failure-${retryCount}`,
            ),
            expectedCreationRevision: retryCount + 2,
            failure: {
              code: "probe_failed",
              retryable: true,
              retryCount,
              lastSafePhase: "analysis",
            },
          }),
        );
        expect(failureResult).toMatchObject({ kind: "committed" });
        expect(
          await run(connection, (store) =>
            store.retry({
              ...command(
                connection,
                "/media-post-submissions/:submissionId/retry",
                `retry-${retryCount}`,
              ),
              expectedCreationRevision: retryCount + 2,
            }),
          ),
        ).toMatchObject({ kind: "committed" });
      }
      expect(
        await run(connection, (store) =>
          store.recordMediaFailure({
            ...command(
              connection,
              "/media-post-submissions/:submissionId/failure",
              "failure-fourth",
            ),
            expectedCreationRevision: 5,
            failure: {
              code: "probe_failed",
              retryable: true,
              retryCount: 3,
              lastSafePhase: "analysis",
            },
          }),
        ),
      ).toMatchObject({ kind: "committed" });
      await expect(
        run(connection, (store) =>
          store.retry({
            ...command(connection, "/media-post-submissions/:submissionId/retry", "retry-fourth"),
            expectedCreationRevision: 5,
          }),
        ),
      ).rejects.toMatchObject({
        _tag: "MediaSubmissionRepositoryError",
        reason: "transition-rejected",
      });
      await admin.query("BEGIN");
      await expect(
        admin.query(
          "UPDATE media_post_submissions SET phase='analysis',last_safe_phase=NULL,event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE submission_id=$1",
          [submission],
        ),
      ).rejects.toThrow();
      await admin.query("ROLLBACK");
      const events = await admin.query<{ event_kind: string }>(
        "SELECT event_kind FROM media_submission_events WHERE submission_id=$1 ORDER BY event_sequence",
        [submission],
      );
      expect(events.rows.map((row) => row.event_kind)).toContain("media_failure_recorded");
      expect(events.rows.map((row) => row.event_kind)).toContain("retry_authorized");
    });
    completedTestCount += 1;
  }, 40_000);
  test("persists author cancellation with typed retention", async () => {
    await withCurrentSchema(async (admin, connection) => {
      expect(
        await run(connection, (store) =>
          store.reserve({
            communityId: community,
            actorUserId: actor,
            personaId: personaFor(connection),
            idempotencyKey: "cancel-reserve",
            requestHash,
            expectedContentType: "audio/mpeg",
            expectedSizeBytes: audioBytes.byteLength,
            expectedSha256: audioSha256,
            uploadUrl: "https://upload.test/media",
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            responseBytes,
            responseSha256,
            reservationId: reservation,
          }),
        ),
      ).toMatchObject({ kind: "created" });
      expect(
        await run(connection, (store) =>
          store.createSubmission({
            communityId: community,
            actorUserId: actor,
            personaId: personaFor(connection),
            idempotencyKey: "cancel-create",
            requestHash,
            title: "Fixture song",
            songType: "original",
            reservationId: reservation,
            submissionId: submission,
            operationId: operation,
            responseBytes,
            responseSha256,
          }),
        ),
      ).toMatchObject({ kind: "created" });
      expect(
        await run(connection, (store) =>
          store.authorCancel({
            ...command(connection, "/media-post-submissions/:submissionId/cancel", "cancel-key"),
            expectedCreationRevision: 1,
          }),
        ),
      ).toMatchObject({ kind: "committed" });
      expect(
        (
          await admin.query(
            "SELECT status,abandonment_reason,retention_disposition,(SELECT state FROM media_upload_reservations WHERE reservation_id=audio_reservation_id) AS reservation_state FROM media_post_submissions WHERE submission_id=$1",
            [submission],
          )
        ).rows[0],
      ).toEqual({
        status: "abandoned",
        abandonment_reason: "author_cancelled",
        retention_disposition: "no_object",
        reservation_state: "claimed",
      });
    });
    completedTestCount += 1;
  }, 40_000);
  test("serializes finalize fencing against author cancellation", async () => {
    await withCurrentSchema(async (admin, connection) => {
      expect(
        await run(connection, (store) =>
          store.reserve({
            communityId: community,
            actorUserId: actor,
            personaId: personaFor(connection),
            idempotencyKey: "race-reserve",
            requestHash,
            expectedContentType: "audio/mpeg",
            expectedSizeBytes: audioBytes.byteLength,
            expectedSha256: audioSha256,
            uploadUrl: "https://upload.test/media",
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            responseBytes,
            responseSha256,
            reservationId: reservation,
          }),
        ),
      ).toMatchObject({ kind: "created" });
      expect(
        await run(connection, (store) =>
          store.createSubmission({
            communityId: community,
            actorUserId: actor,
            personaId: personaFor(connection),
            idempotencyKey: "race-create",
            requestHash,
            title: "Finalize race song",
            songType: "original",
            reservationId: reservation,
            submissionId: submission,
            operationId: operation,
            responseBytes,
            responseSha256,
          }),
        ),
      ).toMatchObject({ kind: "created" });

      const outcomes = await Promise.allSettled([
        run(connection, (store) =>
          store.beginFinalize(finalizeFence(connection, "race-finalize", 1)),
        ),
        run(connection, (store) =>
          store.authorCancel({
            ...command(connection, "/media-post-submissions/:submissionId/cancel", "race-cancel"),
            expectedCreationRevision: 1,
          }),
        ),
      ]);
      expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);

      const state = await admin.query<{ status: string; phase: string | null }>(
        "SELECT status,phase FROM media_post_submissions WHERE submission_id=$1",
        [submission],
      );
      expect(state.rows).toHaveLength(1);
      if (state.rows[0] === undefined) throw new Error("missing finalize race state");
      expect([
        { status: "processing", phase: "finalize" },
        { status: "abandoned", phase: null },
      ]).toContainEqual(state.rows[0]);
      const terminalEvents = await admin.query<{ event_kind: string }>(
        "SELECT event_kind FROM media_submission_events WHERE submission_id=$1 AND event_kind IN ('finalize_requested','author_cancelled')",
        [submission],
      );
      expect(terminalEvents.rows).toHaveLength(1);
    });
    completedTestCount += 1;
  }, 40_000);
  test("expires a claimed reservation only with its abandoned submission", async () => {
    await withCurrentSchema(async (admin, connection) => {
      expect(
        await run(connection, (store) =>
          store.reserve({
            communityId: community,
            actorUserId: actor,
            personaId: personaFor(connection),
            idempotencyKey: "expire-reserve",
            requestHash,
            expectedContentType: "audio/mpeg",
            expectedSizeBytes: audioBytes.byteLength,
            expectedSha256: audioSha256,
            uploadUrl: "https://upload.test/media",
            expiresAt: new Date(Date.now() + 100).toISOString(),
            responseBytes,
            responseSha256,
            reservationId: reservation,
          }),
        ),
      ).toMatchObject({ kind: "created" });
      expect(
        await run(connection, (store) =>
          store.createSubmission({
            communityId: community,
            actorUserId: actor,
            personaId: personaFor(connection),
            idempotencyKey: "expire-create",
            requestHash,
            title: "Fixture song",
            songType: "original",
            reservationId: reservation,
            submissionId: submission,
            operationId: operation,
            responseBytes,
            responseSha256,
          }),
        ),
      ).toMatchObject({ kind: "created" });
      await new Promise((resolve) => setTimeout(resolve, 150));
      await admin.query("BEGIN");
      await admin.query(
        "UPDATE media_post_submissions SET status='abandoned',phase=NULL,abandonment_reason='reservation_expired',retention_disposition='no_object',event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE submission_id=$1",
        [submission],
      );
      await admin.query(
        "INSERT INTO media_submission_events (submission_id,community_id,actor_user_id,operation_id,event_sequence,event_id,event_kind,creation_revision,audio_revision,analysis_revision,decision_revision,workflow_revision,evidence) VALUES ($1,$2,$3,$4,3,'media_pg_forged_expiry','reservation_expired',1,0,0,0,0,jsonb_build_object('event_kind','reservation_expired'))",
        [submission, community, actor, operation],
      );
      await expect(admin.query("COMMIT")).rejects.toThrow();
      await admin.query("ROLLBACK").catch(() => undefined);
      expect(
        await run(connection, (store) =>
          store.reservationExpire({
            ...command(connection, "/media-post-submissions/:submissionId/expire", "expire-key"),
            expectedCreationRevision: 1,
          }),
        ),
      ).toMatchObject({ kind: "committed" });
      expect(
        (
          await admin.query(
            "SELECT s.status,s.abandonment_reason,r.state,r.submission_id,r.claim_fence FROM media_post_submissions s JOIN media_upload_reservations r ON r.reservation_id=s.audio_reservation_id WHERE s.submission_id=$1",
            [submission],
          )
        ).rows[0],
      ).toEqual({
        status: "abandoned",
        abandonment_reason: "reservation_expired",
        state: "expired",
        submission_id: submission,
        claim_fence: "1",
      });
    });
    completedTestCount += 1;
  }, 40_000);
  test("resolves a published source using retained database evidence and rejects inaccessible sources", async () => {
    await withCurrentSchema(async (admin, connection) => {
      await createThroughDecision(
        connection,
        decision,
        analysis,
        false,
        undefined,
        false,
        { submission, operation, reservation },
        {
          ...termsFor(personaFor(connection)),
          licensePreset: "commercial-remix",
          commercialRemixShareBps: 1234,
        },
      );
      const runtime = makeDirectPostgresControlPlaneLayer(connection);
      const processing = makeMediaProcessingStore(runtime, { songSourceCatalogBucketId: "8891" });
      const retainMatch = async (submissionId: string, operationId: string) => {
        const authority = await processing.loadAuthority(submissionId, operationId);
        if (authority === null) throw new Error("missing reference fixture");
        const retainedMatch: MediaIdentificationOutcome = {
          outcome: "retained_reference_match",
          context: {
            version: "media-identification-attempt-context-v1",
            operationId,
            audioRevision: 1,
            analysisRevision: 1,
            canonicalAudioSha256: audioSha256,
            requestId: `request-${submissionId}`,
            adapterRevision: "acr_adapter_1",
          },
          evidence: {
            version: "media-identification-match-evidence-v1",
            provider: "acrcloud",
            matchKind: "custom",
            providerMatchId: "same-recording",
            title: "Fixture",
            artists: ["Fixture artist"],
            score: 99,
          },
        };
        const claim = await processing.startAttempt({
          authority,
          stage: "acr_primary",
          attemptId: `match-${submissionId}`,
          workerId: "reference-test",
          inputRevision: 1,
          inputHash: audioSha256,
          policyRevision: "acr_policy_1",
          adapterRevision: "identification-port-v1",
        });
        if (claim.kind !== "run") throw new Error("reference fixture did not claim");
        expect(
          await processing.completeAttempt(claim.lease, {
            kind: "acr",
            value: retainedMatch,
          }),
        ).toBe(true);
        return { authority, retainedMatch };
      };
      // This fixture exercises persisted resolver facts, not source establishment:
      // current ACR policy cannot bootstrap an allowed source from a retained match.
      const source = await retainMatch(submission, operation);
      const sampleClaim = await processing.startAttempt({
        authority: source.authority,
        stage: "sample_primary",
        attemptId: `source-sample-${submission}`,
        workerId: "reference-test",
        inputRevision: 1,
        inputHash: audioSha256,
        policyRevision: "sample-policy-v1",
        adapterRevision: "transform-port-v1",
      });
      if (sampleClaim.kind !== "run") throw new Error("source sample fixture did not claim");
      expect(
        await processing.completeAttempt(sampleClaim.lease, {
          kind: "sample",
          value: {
            status: "completed",
            attempt: {
              version: "media-transform-attempt-v1",
              runtimeFence: { submittedAtMs: 1, runtimeDeadlineMs: 2 },
              providerJobId: "source-sample-job",
            },
            context: {
              version: "media-transform-attempt-context-v1",
              operationId: operation,
              audioRevision: 1,
              analysisRevision: 1,
              canonicalAudioSha256: audioSha256,
              requestId: `source-sample-${submission}`,
              adapterRevision: "transform-port-v1",
            },
            artifact: {
              version: "media-transform-sample-artifact-v1",
              objectKey: "sample.mp3",
              contentType: "audio/mpeg",
              byteLength: 1,
              offsetMs: 42_000,
              durationMs: 12_000,
              variant: "primary",
              retainedObjectVerification: "required",
            },
          },
        }),
      ).toBe(true);
      expect(await processing.commitPublication(source.authority)).toBe("committed");
      const sourceRecordings = makeSongSourceRecordingRepository(runtime);
      const eligible = await sourceRecordings.listEligible(10);
      expect(eligible).toHaveLength(1);
      const registrationId = eligible[0];
      if (registrationId === undefined) throw new Error("missing automatic source registration");
      const uploadClaim = await sourceRecordings.claim(registrationId, "source-worker", 60);
      if (uploadClaim === null) throw new Error("missing source upload claim");
      expect(
        await sourceRecordings.acceptProviderFile({
          registrationId: uploadClaim.registrationId,
          workerId: "source-worker",
          claimFence: uploadClaim.claimFence,
          file: {
            providerFileId: "20",
            providerMatchId: "same-recording",
            bucketId: uploadClaim.bucketId,
            opaqueTitle: uploadClaim.opaqueTitle,
            state: "ready",
            registrationId: uploadClaim.registrationId,
            assetId: uploadClaim.assetId,
            canonicalAudioSha256: uploadClaim.canonicalAudioSha256,
          },
          evidenceDigest: "c".repeat(64),
        }),
      ).toBe(true);
      await admin.query(
        "UPDATE song_source_recording_outbox SET next_eligible_at=clock_timestamp()-interval '1 second' WHERE registration_id=$1",
        [registrationId],
      );
      const verificationClaim = await sourceRecordings.claim(registrationId, "source-worker", 60);
      if (verificationClaim === null) throw new Error("missing source verification claim");
      expect(
        await sourceRecordings.markReady({
          registrationId: verificationClaim.registrationId,
          workerId: "source-worker",
          claimFence: verificationClaim.claimFence,
          providerFileId: "20",
          providerMatchId: "same-recording",
          identificationEvidence: source.retainedMatch,
        }),
      ).toBe(true);
      const derivative = {
        submission: "reference_derivative",
        operation: "reference_derivative_operation",
        reservation: "reference_derivative_reservation",
      };
      const derivativeAnalysis: TrustedSongAnalysis = {
        ...analysis,
        operationId: derivative.operation,
        finalizedAudioRef: "media://immutable/derivative",
        acr: { ...analysis.acr, decision: "requires_reference" },
      };
      await createThroughDecision(
        connection,
        decision,
        derivativeAnalysis,
        true,
        undefined,
        false,
        derivative,
      );
      await retainMatch(derivative.submission, derivative.operation);
      await run(connection, (store) =>
        store.requireReference({
          ...command(
            connection,
            "/media-post-submissions/:submissionId/reference",
            "derivative-reference-required",
          ),
          submissionId: derivative.submission,
          expectedCreationRevision: 2,
          expectedAudioRevision: 1,
          expectedAnalysisRevision: 1,
          referenceRequestRef: "derivative-request",
          actionExpiresAt: new Date(Date.now() + 3600000).toISOString(),
        }),
      );
      const state = await run(connection, (store) =>
        store.getForAuthor({
          communityId: community,
          actorUserId: actor,
          personaId: personaFor(connection),
          submissionId: derivative.submission,
        }),
      );
      if (state === null) throw new Error("missing derivative state");
      const resolver = makeMediaReferenceResolver(runtime);
      const input = {
        actorUserId: actor,
        submission: state,
        referenceRequestRef: "derivative-request",
        upstreamAssetId: `media-post-${operation}`,
      };
      expect(await resolver.resolve(input)).toMatchObject({
        assetId: `media-post-${operation}`,
        inheritedLicensePreset: "commercial-remix",
        upstreamCommercialRevShareBps: 1234,
        evidenceAudioSha256: audioSha256,
      });
      await expect(
        resolver.resolve({ ...input, upstreamAssetId: "off-platform" }),
      ).rejects.toMatchObject({ details: { reason_code: "reference_source_unavailable" } });
      await admin.query("UPDATE posts SET visibility='members_only' WHERE post_id=$1", [
        `media-post-${operation}`,
      ]);
      await expect(
        resolver.resolve({
          ...input,
          actorUserId: "reference-outsider",
          submission: { ...state, actorId: "reference-outsider" },
        }),
      ).rejects.toMatchObject({ details: { reason_code: "reference_source_unavailable" } });
      let resolutions = 0;
      const unused = async (): Promise<never> => {
        throw new Error("reference must not upload");
      };
      const services = {
        store: makeMediaUploadStore(runtime),
        personaStore: makeControlPlanePersonaStore(runtime),
        referenceResolver: {
          resolve: async (request: Parameters<typeof resolver.resolve>[0]) => {
            resolutions += 1;
            return resolver.resolve(request);
          },
        },
        presigner: { presign: () => Effect.die("reference must not presign") },
        sealer: { inspect: unused, seal: unused },
        nowIso: () => new Date().toISOString(),
      };
      const request = {
        submissionId: derivative.submission,
        actor: { kind: "user" as const, userId: actor },
        body: {
          persona_id: personaFor(connection),
          idempotency_key: "bind-verified-source",
          expected_creation_revision: 2,
          reference_request_ref: "derivative-request",
          upstream_asset_id: `media-post-${operation}`,
        },
      };
      await expect(
        bindMediaReference(
          { ...request, body: { ...request.body, persona_id: personaFor(connection, moderator) } },
          services,
        ),
      ).rejects.toThrow();
      expect(resolutions).toBe(0);
      await expect(
        bindMediaReference(
          { ...request, body: { ...request.body, expected_creation_revision: 1 } },
          services,
        ),
      ).rejects.toThrow();
      const response = await bindMediaReference(request, services);
      expect(response.status).toBe("processing");
      const beforeReplay = resolutions;
      expect(await bindMediaReference(request, services)).toEqual(response);
      expect(resolutions).toBe(beforeReplay);
      expect(
        (
          await admin.query(
            "SELECT count(*)::integer AS count FROM media_submission_outbox WHERE submission_id=$1 AND event_type='decision_wakeup'",
            [derivative.submission],
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
      const wakeup = (
        await admin.query(
          "SELECT outbox_event_id,workflow_revision FROM media_submission_outbox WHERE submission_id=$1 AND event_type='decision_wakeup'",
          [derivative.submission],
        )
      ).rows[0];
      const retainedOnlyProviders = new Proxy({} as MediaProcessingProviders, {
        get: () => {
          throw new Error("reference resumption must reuse retained provider evidence");
        },
      });
      expect(
        await Effect.runPromise(
          runMediaProcessingWorkflow(
            {
              outboxId: wakeup.outbox_event_id,
              submissionId: derivative.submission,
              operationId: derivative.operation,
              workflowRevision: Number(wakeup.workflow_revision),
            },
            "decision_wakeup",
            {
              store: processing,
              providers: retainedOnlyProviders,
              options: {
                enabled: true,
                workerId: "reference-resumption-test",
                now: Date.now,
                policyRevision: "fixture-v1",
                transformAdapterRevision: "fixture-v1",
                metadataAdapterRevision: "fixture-v1",
                classifierTimeoutMs: 10000,
                transformRuntimeMs: 60000,
                maximumSampleBytes: 1000000,
              },
            },
          ),
        ),
      ).toMatchObject({ outcome: "published_without_alignment" });
      expect(
        (
          await admin.query(
            "SELECT a.terms_snapshot = b.terms_snapshot AS unchanged FROM media_submission_terms a JOIN media_submission_terms b ON a.submission_id=b.submission_id WHERE a.submission_id=$1 AND a.creation_revision=2 AND b.creation_revision=3",
            [derivative.submission],
          )
        ).rows,
      ).toEqual([{ unchanged: true }]);
      expect(
        (await processing.loadAuthority(derivative.submission, derivative.operation))?.status,
      ).toBe("published");
    });
    completedTestCount += 1;
  }, 40_000);
  test("keeps publication successful when source enrollment evidence is unavailable", async () => {
    await withCurrentSchema(async (admin, connection) => {
      await createThroughDecision(
        connection,
        decision,
        analysis,
        false,
        undefined,
        false,
        { submission, operation, reservation },
        {
          ...termsFor(personaFor(connection)),
          licensePreset: "commercial-remix",
          commercialRemixShareBps: 1234,
        },
      );
      const processing = makeMediaProcessingStore(makeDirectPostgresControlPlaneLayer(connection), {
        songSourceCatalogBucketId: "8891",
      });
      const authority = await processing.loadAuthority(submission, operation);
      if (authority === null) throw new Error("missing publication authority");
      expect(await processing.commitPublication(authority)).toBe("committed");
      expect(
        (
          await admin.query(
            "SELECT registration_id FROM song_source_recording_registrations WHERE submission_id=$1",
            [submission],
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await admin.query("SELECT status FROM media_post_submissions WHERE submission_id=$1", [
            submission,
          ])
        ).rows,
      ).toEqual([{ status: "published" }]);
    });
    completedTestCount += 1;
  }, 40_000);
  test("binds reference evidence atomically while reusing immutable analysis", async () => {
    await withCurrentSchema(async (admin, connection) => {
      const requiresReference = {
        ...analysis,
        acr: { ...analysis.acr, decision: "requires_reference" as const },
      };
      await createThroughDecision(connection, decision, requiresReference, true);
      expect(
        await run(connection, (store) =>
          store.requireReference({
            ...command(
              connection,
              "/media-post-submissions/:submissionId/reference",
              "reference-required",
            ),
            expectedCreationRevision: 2,
            expectedAudioRevision: 1,
            expectedAnalysisRevision: 1,
            referenceRequestRef: "reference-request",
            actionExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          }),
        ),
      ).toMatchObject({ kind: "committed" });
      await expectHostileLyricsProjectionLeakRejected(admin, true);
      const binding = {
        ...command(
          connection,
          "/media-post-submissions/:submissionId/reference",
          "reference-bound",
        ),
        expectedCreationRevision: 2,
        reference: {
          assetId: "upstream-asset",
          evidenceAudioRevision: 1,
          evidenceAnalysisRevision: 1,
          evidenceAudioSha256: audioSha256,
          upstreamCommercialRevShareBps: 1000,
          evidenceRef: "upstream-evidence",
        },
        outbox: {
          outboxEventId: "media_pg_reference_outbox",
          effectIdentity: "media_pg_reference_effect",
          payload: {
            kind: "decision_wakeup" as const,
            trigger: "reference" as const,
            submission_id: submission,
            operation_id: operation,
            creation_revision: 3,
            lyrics_revision: null,
            workflow_revision: 1,
            workflow_instance_id: `media-${operation}-r1`,
          },
        },
      };
      const { outbox: _wakeup, ...missingWakeup } = binding;
      await expect(
        run(connection, (store) => store.bindReference(missingWakeup)),
      ).rejects.toThrow();
      await expect(
        run(connection, (store) =>
          store.bindReference({
            ...binding,
            outbox: {
              ...binding.outbox,
              payload: { ...binding.outbox.payload, creation_revision: 999 },
            },
          }),
        ),
      ).rejects.toThrow();
      expect(
        (
          await admin.query(
            "SELECT status,creation_revision::integer FROM media_post_submissions WHERE submission_id=$1",
            [submission],
          )
        ).rows,
      ).toEqual([{ status: "action_required", creation_revision: 2 }]);
      expect(
        (
          await admin.query(
            "SELECT count(*)::integer AS count FROM media_reference_evidence WHERE submission_id=$1",
            [submission],
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
      expect(await run(connection, (store) => store.bindReference(binding))).toMatchObject({
        kind: "committed",
      });
      expect(await run(connection, (store) => store.bindReference(binding))).toMatchObject({
        kind: "replay",
      });
      expect(
        (
          await admin.query(
            "SELECT payload,creation_revision::integer FROM media_submission_outbox WHERE submission_id=$1 AND event_type='decision_wakeup'",
            [submission],
          )
        ).rows,
      ).toEqual([{ payload: binding.outbox.payload, creation_revision: 3 }]);
      expect(
        await run(connection, (store) =>
          store.getForAuthor({
            communityId: community,
            submissionId: submission,
            actorUserId: actor,
            personaId: personaFor(connection),
          }),
        ),
      ).toMatchObject({
        creationRevision: 3,
        analysisRevision: 1,
        status: "processing",
        phase: "decision",
        boundReference: { assetId: "upstream-asset", evidenceRef: "upstream-evidence" },
        analysis: {
          boundReference: { assetId: "upstream-asset", evidenceRef: "upstream-evidence" },
        },
      });
      expect(
        (
          await admin.query(
            "SELECT analysis_snapshot->'boundReference' AS analysis_reference,(SELECT count(*)::text FROM media_reference_evidence WHERE submission_id=$1) AS evidence_count FROM media_analysis_evidence WHERE submission_id=$1 AND analysis_revision=1",
            [submission],
          )
        ).rows[0],
      ).toEqual({ analysis_reference: null, evidence_count: "1" });
    });
    completedTestCount += 1;
  }, 40_000);
  test("persists upload expectation mismatch with its typed event and retention", async () => {
    await withCurrentSchema(async (admin, connection) => {
      expect(
        await run(connection, (store) =>
          store.reserve({
            communityId: community,
            actorUserId: actor,
            personaId: personaFor(connection),
            idempotencyKey: "mismatch-reserve",
            requestHash,
            expectedContentType: "audio/mpeg",
            expectedSizeBytes: audioBytes.byteLength,
            expectedSha256: audioSha256,
            uploadUrl: "https://upload.test/media",
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            responseBytes,
            responseSha256,
            reservationId: reservation,
          }),
        ),
      ).toMatchObject({ kind: "created" });
      expect(
        await run(connection, (store) =>
          store.createSubmission({
            communityId: community,
            actorUserId: actor,
            personaId: personaFor(connection),
            idempotencyKey: "mismatch-create",
            requestHash,
            title: "Fixture song",
            songType: "original",
            reservationId: reservation,
            submissionId: submission,
            operationId: operation,
            responseBytes,
            responseSha256,
          }),
        ),
      ).toMatchObject({ kind: "created" });
      expect(
        await run(connection, (store) =>
          store.uploadExpectationMismatch({
            ...command(
              connection,
              "/media-post-submissions/:submissionId/upload-mismatch",
              "mismatch-key",
            ),
            expectedCreationRevision: 1,
            evidenceRef: "upload-mismatch-evidence",
          }),
        ),
      ).toMatchObject({ kind: "committed" });
      expect(
        (
          await admin.query(
            "SELECT status,abandonment_reason,retention_disposition FROM media_post_submissions WHERE submission_id=$1",
            [submission],
          )
        ).rows[0],
      ).toEqual({
        status: "abandoned",
        abandonment_reason: "upload_expectation_mismatch",
        retention_disposition: "retain_for_reconciliation",
      });
      expect(
        (
          await admin.query(
            "SELECT event_kind FROM media_submission_events WHERE submission_id=$1 ORDER BY event_sequence DESC LIMIT 1",
            [submission],
          )
        ).rows[0],
      ).toEqual({ event_kind: "upload_expectation_mismatch_recorded" });
      expect(
        (
          await admin.query(
            "SELECT state,terminal_reason,terminal_evidence_ref,terminal_evidence_digest,terminal_fence FROM media_upload_reservations WHERE reservation_id=$1",
            [reservation],
          )
        ).rows[0],
      ).toEqual({
        state: "rejected",
        terminal_reason: "expectation_mismatch",
        terminal_evidence_ref: "upload-mismatch-evidence",
        terminal_evidence_digest: sha256(new TextEncoder().encode("upload-mismatch-evidence")),
        terminal_fence: "3",
      });
    });
    completedTestCount += 1;
  }, 40_000);
  test("rejects forged ordinary exhaustion and pointer mutation at SQL transition fences", async () => {
    await withCurrentSchema(async (_schemaAdmin, connection) => {
      const admin = new Client({ connectionString: connection });
      await admin.connect();
      await createThroughDecision(connection, reviewDecision);
      for (const mutation of [
        "creation_revision=creation_revision+1",
        "audio_revision=audio_revision+1",
        "analysis_revision=analysis_revision+1",
        "lyrics_revision=1",
      ]) {
        await admin.query("BEGIN");
        await expect(
          admin.query(
            `UPDATE media_submission_outbox SET ${mutation},state='running',delivery_attempts=delivery_attempts+1,claim_owner='hostile-worker',claim_fence=claim_fence+1,lease_expires_at=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp()+interval '1 second' WHERE outbox_event_id='media_pg_analysis_outbox'`,
          ),
        ).rejects.toThrow("media outbox effect identity is immutable");
        await admin.query("ROLLBACK");
      }
      await admin.query("BEGIN");
      await expect(
        admin.query(
          "UPDATE media_post_submissions SET review_exhaustion_code='acr_exhausted',review_exhaustion_attempt_id='forged',event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE submission_id=$1",
          [submission],
        ),
      ).rejects.toThrow();
      await admin.query("ROLLBACK");
      for (const [suffix, payload] of [
        [
          "null-operation",
          {
            kind: "analysis_launch",
            submission_id: submission,
            operation_id: null,
            audio_revision: 1,
            analysis_revision: 0,
            workflow_revision: 1,
            workflow_instance_id: `media-${operation}-r1`,
          },
        ],
        [
          "fraction-audio",
          {
            kind: "analysis_launch",
            submission_id: submission,
            operation_id: operation,
            audio_revision: 1.5,
            analysis_revision: 0,
            workflow_revision: 1,
            workflow_instance_id: `media-${operation}-r1`,
          },
        ],
        [
          "string-workflow",
          {
            kind: "analysis_launch",
            submission_id: submission,
            operation_id: operation,
            audio_revision: 1,
            analysis_revision: 0,
            workflow_revision: "1",
            workflow_instance_id: `media-${operation}-r1`,
          },
        ],
      ] as const) {
        await admin.query("BEGIN");
        await expect(
          admin.query(
            "INSERT INTO media_submission_outbox (outbox_event_id,submission_id,community_id,actor_user_id,operation_id,creation_revision,audio_revision,analysis_revision,workflow_revision,workflow_instance_id,event_type,effect_identity,payload) VALUES ($1,$2,$3,$4,$5,2,1,0,1,$6,'analysis_launch',$7,$8::jsonb)",
            [
              `hostile-payload-${suffix}`,
              submission,
              community,
              actor,
              operation,
              `media-${operation}-r1`,
              `hostile-effect-${suffix}`,
              JSON.stringify(payload),
            ],
          ),
        ).rejects.toThrow();
        await admin.query("ROLLBACK");
      }
      await admin.query("BEGIN");
      await expect(
        admin.query(
          "INSERT INTO media_submission_outbox (outbox_event_id,submission_id,community_id,actor_user_id,operation_id,creation_revision,audio_revision,analysis_revision,workflow_revision,workflow_instance_id,event_type,effect_identity,payload) VALUES ('hostile-kind',$1,$2,$3,$4,2,1,1,1,$5,'publication','hostile-kind-effect',$6::jsonb)",
          [
            submission,
            community,
            actor,
            operation,
            `media-${operation}-r1`,
            JSON.stringify({
              kind: "analysis_launch",
              operation_id: operation,
              post_id: "media-post",
              submission_id: submission,
              workflow_revision: 1,
              workflow_instance_id: `media-${operation}-r1`,
            }),
          ],
        ),
      ).rejects.toThrow();
      await admin.query("ROLLBACK");
      await admin.query("BEGIN");
      await expect(
        admin.query(
          "INSERT INTO media_submission_outbox (outbox_event_id,submission_id,community_id,actor_user_id,operation_id,creation_revision,audio_revision,analysis_revision,workflow_revision,workflow_instance_id,event_type,effect_identity,payload) VALUES ('hostile-stale-revisions',$1,$2,$3,$4,1,9,7,1,$5,'analysis_launch','hostile-stale-revisions-effect',$6::jsonb)",
          [
            submission,
            community,
            actor,
            operation,
            `media-${operation}-r1`,
            JSON.stringify({
              kind: "analysis_launch",
              submission_id: submission,
              operation_id: operation,
              audio_revision: 9,
              analysis_revision: 7,
              workflow_revision: 1,
              workflow_instance_id: `media-${operation}-r1`,
            }),
          ],
        ),
      ).rejects.toThrow("media outbox lineage does not match submission");
      await admin.query("ROLLBACK");
      await admin.query("BEGIN");
      const decisionWakeupPayload = JSON.stringify({
        kind: "decision_wakeup",
        submission_id: submission,
        operation_id: operation,
        creation_revision: 2,
        lyrics_revision: null,
        trigger: "terms",
        workflow_revision: 1,
        workflow_instance_id: `media-${operation}-r1`,
      });
      await admin.query(
        "INSERT INTO media_submission_outbox (outbox_event_id,submission_id,community_id,actor_user_id,operation_id,creation_revision,audio_revision,analysis_revision,lyrics_revision,workflow_revision,workflow_instance_id,event_type,effect_identity,payload) VALUES ('semantic-effect',$1,$2,$3,$4,2,1,1,NULL,1,$5,'decision_wakeup','semantic-effect-identity',$6::jsonb)",
        [submission, community, actor, operation, `media-${operation}-r1`, decisionWakeupPayload],
      );
      await expect(
        admin.query(
          "INSERT INTO media_submission_outbox (outbox_event_id,submission_id,community_id,actor_user_id,operation_id,creation_revision,audio_revision,analysis_revision,lyrics_revision,workflow_revision,workflow_instance_id,event_type,effect_identity,payload) VALUES ('semantic-effect-duplicate',$1,$2,$3,$4,2,1,1,NULL,1,$5,'decision_wakeup','different-semantic-effect-identity',$6::jsonb)",
          [submission, community, actor, operation, `media-${operation}-r1`, decisionWakeupPayload],
        ),
      ).rejects.toThrow("media_submission_outbox_semantic_identity_unique");
      await admin.query("ROLLBACK");
      await admin.query("BEGIN");
      await expect(
        admin.query(
          "UPDATE media_post_submissions SET current_immutable_ref='forged-pointer',event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE submission_id=$1",
          [submission],
        ),
      ).rejects.toThrow();
      await admin.query("ROLLBACK");
      for (const [suffix, segment] of [
        ["extra-key", { start_ms: 0, end_ms: 1, text: "ok", extra: true }],
        ["fractional-time", { start_ms: 0.5, end_ms: 1, text: "ok" }],
      ] as const) {
        await admin.query("BEGIN");
        await expect(
          admin.query(
            "INSERT INTO media_transcript_artifacts (transcript_artifact_ref,community_id,actor_user_id,submission_id,operation_id,audio_revision,analysis_revision,canonical_audio_sha256,transcript_sha256,transcript_text,segments) VALUES ($1,$2,$3,$4,$5,1,2,$6,$7,'ok',$8::jsonb)",
            [
              `hostile-transcript-${suffix}`,
              community,
              actor,
              submission,
              operation,
              audioSha256,
              sha256(new TextEncoder().encode("ok")),
              JSON.stringify([segment]),
            ],
          ),
        ).rejects.toThrow();
        await admin.query("ROLLBACK");
      }
      await admin.end();
    });
    completedTestCount += 1;
  }, 40_000);
  test("rejects hostile SQL state, snapshot, payload, replay, audio, and transcript lineage", async () => {
    await withCurrentSchema(async (_schemaAdmin, connection) => {
      const admin = new Client({ connectionString: connection });
      await admin.connect();
      await createThroughDecision(connection, decision, analysis, true);
      const normalizedNoLyrics = await admin.query(
        "SELECT analysis_snapshot->'lyricsAnalysis'->>'status' AS lyrics_analysis_status,transcript_artifact_ref,transcript_sha256,primary_language_bcp47 AS primary_language,secondary_language_bcp47 AS secondary_language FROM media_analysis_evidence WHERE submission_id=$1 AND analysis_revision=1",
        [submission],
      );
      expect(normalizedNoLyrics.rows[0]).toEqual({
        lyrics_analysis_status: "not_applicable",
        transcript_artifact_ref: null,
        transcript_sha256: null,
        primary_language: null,
        secondary_language: null,
      });
      const storedSnapshotValue = (
        await admin.query(
          "SELECT analysis_snapshot FROM media_analysis_evidence WHERE submission_id=$1",
          [submission],
        )
      ).rows[0]?.analysis_snapshot;
      const storedSnapshot = (
        typeof storedSnapshotValue === "string"
          ? JSON.parse(storedSnapshotValue)
          : storedSnapshotValue
      ) as Record<string, unknown>;
      const storedLyricsAnalysis = storedSnapshot.lyricsAnalysis as Record<string, unknown>;
      const rejectSnapshot = async (snapshot: Record<string, unknown>): Promise<void> => {
        await admin.query("BEGIN");
        await expect(insertAnalysisSnapshotVariant(admin, 2, snapshot)).rejects.toThrow();
        await admin.query("ROLLBACK");
      };
      await rejectSnapshot({
        ...storedSnapshot,
        analysisRevision: 2,
        lyricsAnalysis: {
          ...storedLyricsAnalysis,
          evidenceRef: "forged-lyrics-evidence",
        },
      });
      await rejectSnapshot({
        ...storedSnapshot,
        analysisRevision: 2,
        lyricsAnalysis: {
          status: "ready",
          lyricsRevision: 1,
          explicitness: "not_explicit",
          primaryLanguageBcp47: "en",
          secondaryLanguageBcp47: null,
          evidenceRef: "forged-lyrics-evidence",
          policyRevision: "forged-lyrics-policy",
          adapterRevision: "forged-lyrics-adapter",
        },
      });
      for (const key of ["evidenceRef", "policyRevision", "adapterRevision"] as const)
        await rejectSnapshot({
          ...storedSnapshot,
          analysisRevision: 2,
          lyricsAnalysis: { ...storedLyricsAnalysis, [key]: 7 },
        });
      await admin.query("BEGIN");
      await admin.query(
        "INSERT INTO media_upload_reservations (reservation_id,community_id,actor_user_id,actor_persona_id,idempotency_key,request_hash,expected_content_type,expected_size_bytes,upload_url,expires_at,state,submission_id,operation_id,claim_fence,response_snapshot_bytes,response_snapshot_sha256) VALUES ('orphan-claimed-reservation',$1,$2,$3,'orphan-claimed-key',$4,'audio/wav',1,'https://upload.example/orphan',clock_timestamp()+interval '1 hour','claimed','orphan-submission','orphan-operation',1,$5,$6)",
        [community, actor, personaFor(connection), requestHash, responseBytes, responseSha256],
      );
      await expect(admin.query("COMMIT")).rejects.toThrow();
      await admin.query("ROLLBACK");
      await admin.query("BEGIN");
      await admin.query(
        "INSERT INTO media_submission_terms (submission_id,community_id,actor_user_id,operation_id,creation_revision,license_preset,commercial_remix_share_bps,royalty_allocations,access_mode,terms_snapshot) VALUES ($1,$2,$3,$4,3,'non-commercial',0,$5::jsonb,'public',$6::jsonb)",
        [
          submission,
          community,
          actor,
          operation,
          JSON.stringify(termsFor(personaFor(connection)).royaltyAllocations),
          JSON.stringify(termsFor(personaFor(connection))),
        ],
      );
      await admin.query(
        "UPDATE media_post_submissions SET creation_revision=3,current_terms_revision=3,decision_revision=0,current_decision_revision=NULL,status='processing',phase='analysis',event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE submission_id=$1",
        [submission],
      );
      await expect(admin.query("COMMIT")).rejects.toThrow();
      await admin.query("ROLLBACK");
      await admin.query("BEGIN");
      await expect(
        admin.query(
          "UPDATE media_post_submissions SET analysis_revision=2,current_analysis_revision=2,event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE submission_id=$1",
          [submission],
        ),
      ).rejects.toThrow();
      await admin.query("ROLLBACK");
      await admin.query("BEGIN");
      await expect(
        admin.query(
          "INSERT INTO media_submission_outbox (outbox_event_id,submission_id,community_id,actor_user_id,operation_id,creation_revision,audio_revision,analysis_revision,workflow_revision,workflow_instance_id,event_type,effect_identity,payload) VALUES ('hostile-workflow',$1,$2,$3,$4,2,1,0,999,$5,'analysis_launch','hostile-workflow-effect',$6::jsonb)",
          [
            submission,
            community,
            actor,
            operation,
            `media-${operation}-r999`,
            JSON.stringify({
              kind: "analysis_launch",
              submission_id: submission,
              operation_id: operation,
              audio_revision: 1,
              analysis_revision: 0,
              workflow_revision: 999,
              workflow_instance_id: `media-${operation}-r999`,
            }),
          ],
        ),
      ).rejects.toThrow();
      await admin.query("ROLLBACK");
      await admin.query("BEGIN");
      await expect(
        admin.query(
          "INSERT INTO media_submission_terms (submission_id,community_id,actor_user_id,operation_id,creation_revision,license_preset,commercial_remix_share_bps,royalty_allocations,access_mode,terms_snapshot) VALUES ($1,$2,$3,$4,3,'non-commercial',0,$5::jsonb,'public',$6::jsonb)",
          [
            submission,
            community,
            actor,
            operation,
            JSON.stringify(termsFor(personaFor(connection)).royaltyAllocations),
            JSON.stringify({
              ...termsFor(personaFor(connection)),
              licensePreset: "commercial-use",
            }),
          ],
        ),
      ).rejects.toThrow();
      await admin.query("ROLLBACK");
      await admin.query("BEGIN");
      await expect(
        admin.query(
          "INSERT INTO media_publication_decisions (submission_id,community_id,actor_user_id,operation_id,decision_revision,creation_revision,audio_revision,analysis_revision,canonical_audio_sha256,outcome,policy_revision,evidence_ref,decision_snapshot) VALUES ($1,$2,$3,$4,2,2,1,1,$5,'allow','publication_policy_2','publication_evidence_2',$6::jsonb)",
          [
            submission,
            community,
            actor,
            operation,
            audioSha256,
            JSON.stringify({ ...decision, decisionRevision: 2, outcome: "block" }),
          ],
        ),
      ).rejects.toThrow();
      await admin.query("ROLLBACK");
      await admin.query("BEGIN");
      await expect(
        admin.query(
          "INSERT INTO media_submission_outbox (outbox_event_id,submission_id,community_id,actor_user_id,operation_id,creation_revision,audio_revision,analysis_revision,workflow_revision,workflow_instance_id,event_type,effect_identity,payload) VALUES ('hostile-payload',$1,$2,$3,$4,2,1,0,1,$5,'analysis_launch','hostile-effect',$6::jsonb)",
          [
            submission,
            community,
            actor,
            operation,
            `media-${operation}-r1`,
            JSON.stringify({
              kind: "analysis_launch",
              submission_id: submission,
              operation_id: "different-operation",
              audio_revision: 1,
              analysis_revision: 0,
              workflow_revision: 1,
              workflow_instance_id: `media-${operation}-r1`,
            }),
          ],
        ),
      ).rejects.toThrow();
      await admin.query("ROLLBACK");
      await admin.query("BEGIN");
      await expect(
        admin.query(
          "INSERT INTO media_submission_command_replays (community_id,actor_user_id,submission_actor_user_id,endpoint_template,idempotency_key,request_hash,submission_id,operation_id,response_snapshot_bytes,response_snapshot_sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [
            community,
            moderator,
            moderator,
            "/media-post-submissions/:submissionId/replay-hostile",
            "cross-actor",
            requestHash,
            submission,
            operation,
            responseBytes,
            responseSha256,
          ],
        ),
      ).rejects.toThrow();
      await admin.query("ROLLBACK");
      await admin.query("BEGIN");
      await expect(
        admin.query(
          "INSERT INTO media_audio_revisions (submission_id,community_id,actor_user_id,operation_id,audio_revision,immutable_ref,canonical_sha256,content_type,size_bytes) VALUES ($1,$2,$3,$4,2,$5,$6,'audio/wav',$7)",
          [
            submission,
            community,
            actor,
            operation,
            analysis.finalizedAudioRef,
            audioSha256,
            audioBytes.byteLength + 1,
          ],
        ),
      ).rejects.toThrow();
      await admin.query("ROLLBACK");
      await admin.query("BEGIN");
      const aggregateSegments = Array.from({ length: 50 }, (_, index) => ({
        start_ms: index,
        end_ms: index + 1,
        text: "x".repeat(4096),
      }));
      await expect(
        admin.query(
          "INSERT INTO media_transcript_artifacts (transcript_artifact_ref,community_id,actor_user_id,submission_id,operation_id,audio_revision,analysis_revision,canonical_audio_sha256,transcript_sha256,transcript_text,segments) VALUES ('hostile-transcript',$1,$2,$3,$4,1,1,$5,$6,'',$7::jsonb)",
          [
            community,
            actor,
            submission,
            operation,
            audioSha256,
            sha256(new TextEncoder().encode("")),
            JSON.stringify(aggregateSegments),
          ],
        ),
      ).rejects.toThrow();
      await admin.query("ROLLBACK");
      await admin.end();
    });
    completedTestCount += 1;
  }, 40_000);
  test("accepts normalized unavailable and ready lyrics-analysis snapshots", async () => {
    await withCurrentSchema(async (admin, connection) => {
      const unavailable: TrustedSongAnalysis = {
        ...analysis,
        lyricsAnalysis: {
          status: "unavailable",
          lyricsRevision: 1,
          explicitness: "uncertain",
          evidenceRef: "lyrics_unavailable_evidence",
          policyRevision: "lyrics_unavailable_policy",
          adapterRevision: "lyrics_unavailable_adapter",
        },
        lyricsSafety: "review_required",
      };
      await createThroughDecision(
        connection,
        { ...reviewDecision, creationRevision: 3, lyricsRevision: 1 },
        unavailable,
        false,
        "Author supplied lyrics while classification was unavailable",
      );
      expect(
        (
          await admin.query(
            "SELECT status,review_reason_code,current_lyrics_revision FROM media_post_submissions WHERE submission_id=$1",
            [submission],
          )
        ).rows[0],
      ).toEqual({
        status: "manual_review",
        review_reason_code: "review_required",
        current_lyrics_revision: "1",
      });
      expect(
        (
          await admin.query(
            "SELECT speech_status AS lyrics_analysis_status,lyrics_safety,analysis_snapshot->'lyricsAnalysis'->'primaryLanguageBcp47' AS primary_language,analysis_snapshot->'lyricsAnalysis'->'secondaryLanguageBcp47' AS secondary_language FROM media_analysis_evidence WHERE submission_id=$1",
            [submission],
          )
        ).rows[0],
      ).toEqual({
        lyrics_analysis_status: "unavailable",
        lyrics_safety: "review_required",
        primary_language: null,
        secondary_language: null,
      });
      const storedSnapshotValue = (
        await admin.query(
          "SELECT analysis_snapshot FROM media_analysis_evidence WHERE submission_id=$1",
          [submission],
        )
      ).rows[0]?.analysis_snapshot;
      const storedSnapshot = (
        typeof storedSnapshotValue === "string"
          ? JSON.parse(storedSnapshotValue)
          : storedSnapshotValue
      ) as Record<string, unknown>;
      const storedLyricsAnalysis = storedSnapshot.lyricsAnalysis as Record<string, unknown>;
      const rejectSnapshot = async (snapshot: Record<string, unknown>): Promise<void> => {
        await admin.query("BEGIN");
        await expect(insertAnalysisSnapshotVariant(admin, 2, snapshot)).rejects.toThrow();
        await admin.query("ROLLBACK");
      };
      await rejectSnapshot({
        ...storedSnapshot,
        analysisRevision: 2,
        lyricsAnalysis: {
          status: "unavailable",
          explicitness: "uncertain",
          evidenceRef: storedLyricsAnalysis.evidenceRef,
          policyRevision: storedLyricsAnalysis.policyRevision,
          adapterRevision: storedLyricsAnalysis.adapterRevision,
        },
      });
      await rejectSnapshot({
        ...storedSnapshot,
        analysisRevision: 2,
        lyricsAnalysis: {
          ...storedLyricsAnalysis,
          primaryLanguageBcp47: "en",
          secondaryLanguageBcp47: "fr",
        },
      });
    });
    await withCurrentSchema(async (admin, connection) => {
      const readyLyrics = "fixture lyrics";
      const ready: TrustedSongAnalysis = {
        ...analysis,
        embeddedMetadata: {
          ...analysis.embeddedMetadata,
          cover: {
            status: "ready",
            artifactRef: "media_pg_cover_artifact",
            artifactSha256: sha256(new TextEncoder().encode("cover")),
            mediaType: "image/png",
            width: 640,
            height: 480,
            normalizationRevision: "cover_normalization_1",
            safetyPolicyRevision: "cover_policy_1",
          },
        },
        lyricsAnalysis: {
          status: "ready",
          lyricsRevision: 1,
          explicitness: "not_explicit",
          primaryLanguageBcp47: "en",
          secondaryLanguageBcp47: null,
          evidenceRef: "lyrics_ready_evidence",
          policyRevision: "lyrics_ready_policy",
          adapterRevision: "lyrics_ready_adapter",
        },
        lyricsSafety: "allow",
      };
      await createThroughDecision(connection, decision, ready, true, readyLyrics);
      const storedSnapshotValue = (
        await admin.query(
          "SELECT analysis_snapshot FROM media_analysis_evidence WHERE submission_id=$1",
          [submission],
        )
      ).rows[0]?.analysis_snapshot;
      const storedSnapshot = (
        typeof storedSnapshotValue === "string"
          ? JSON.parse(storedSnapshotValue)
          : storedSnapshotValue
      ) as Record<string, unknown>;
      const storedEmbedded = storedSnapshot.embeddedMetadata as Record<string, unknown>;
      const storedCover = storedEmbedded.cover as Record<string, unknown>;
      const storedLyricsAnalysis = storedSnapshot.lyricsAnalysis as Record<string, unknown>;
      const rejectSnapshot = async (snapshot: Record<string, unknown>): Promise<void> => {
        await admin.query("BEGIN");
        await expect(insertAnalysisSnapshotVariant(admin, 2, snapshot)).rejects.toThrow();
        await admin.query("ROLLBACK");
      };
      for (const [key, value] of [
        ["artifactRef", 7],
        ["normalizationRevision", 7],
        ["safetyPolicyRevision", 7],
      ] as const)
        await rejectSnapshot({
          ...storedSnapshot,
          analysisRevision: 2,
          embeddedMetadata: { ...storedEmbedded, cover: { ...storedCover, [key]: value } },
        });
      for (const [path, value] of [
        ["evidenceRef", 7],
        ["policyRevision", 7],
        ["adapterRevision", 7],
      ] as const)
        await rejectSnapshot({
          ...storedSnapshot,
          analysisRevision: 2,
          lyricsAnalysis: { ...storedLyricsAnalysis, [path]: value },
        });
      const correctedInput = {
        ...command(connection, "/media-post-submissions/:submissionId/lyrics", "lyrics-corrected"),
        expectedCreationRevision: 3,
        expectedAudioRevision: 1,
        lyrics: "Corrected fixture lyrics",
        outbox: {
          outboxEventId: "media_pg_lyrics_corrected_outbox",
          effectIdentity: "media_pg_lyrics_corrected_effect",
          payload: {
            kind: "decision_wakeup" as const,
            submission_id: submission,
            operation_id: operation,
            creation_revision: 4,
            lyrics_revision: 2,
            trigger: "lyrics" as const,
            workflow_revision: 1,
            workflow_instance_id: `media-${operation}-r1`,
          },
        },
      };
      expect(await run(connection, (store) => store.bindLyrics(correctedInput))).toEqual({
        kind: "committed",
        submissionId: submission,
      });
      expect(await run(connection, (store) => store.bindLyrics(correctedInput))).toMatchObject({
        kind: "replay",
      });
      expect(
        (
          await admin.query(
            "SELECT provenance,lyrics_text FROM media_song_lyrics_revisions WHERE submission_id=$1 ORDER BY lyrics_revision",
            [submission],
          )
        ).rows,
      ).toEqual([
        {
          provenance: "pasted",
          lyrics_text: readyLyrics,
        },
        {
          provenance: "corrected",
          lyrics_text: "Corrected fixture lyrics",
        },
      ]);
      await expect(
        run(connection, (store) =>
          store.bindLyrics({
            ...correctedInput,
            idempotencyKey: "lyrics-stale",
            requestHash: "b".repeat(64),
            outbox: {
              ...correctedInput.outbox,
              outboxEventId: "media_pg_lyrics_stale_outbox",
              effectIdentity: "media_pg_lyrics_stale_effect",
            },
          }),
        ),
      ).rejects.toMatchObject({ reason: "stale-revision" });
      await expect(
        run(connection, (store) =>
          store.bindLyrics({
            ...correctedInput,
            idempotencyKey: "lyrics-stale-revision",
            requestHash: "c".repeat(64),
            expectedCreationRevision: 4,
            outbox: {
              outboxEventId: "media_pg_lyrics_foreign_outbox",
              effectIdentity: "media_pg_lyrics_foreign_effect",
              payload: {
                ...correctedInput.outbox.payload,
                creation_revision: 6,
                lyrics_revision: 4,
              },
            },
          }),
        ),
      ).rejects.toThrow();
      expect(
        (
          await admin.query(
            "SELECT creation_revision,lyrics_revision FROM media_post_submissions WHERE submission_id=$1",
            [submission],
          )
        ).rows[0],
      ).toEqual({ creation_revision: "4", lyrics_revision: "2" });
      expect(
        await run(connection, (store) =>
          store.bindLyrics({
            ...correctedInput,
            idempotencyKey: "lyrics-corrected-later",
            requestHash: "d".repeat(64),
            expectedCreationRevision: 4,
            lyrics: "Pasted lyrics",
            outbox: {
              outboxEventId: "media_pg_lyrics_corrected_later_outbox",
              effectIdentity: "media_pg_lyrics_corrected_later_effect",
              payload: {
                ...correctedInput.outbox.payload,
                creation_revision: 5,
                lyrics_revision: 3,
              },
            },
          }),
        ),
      ).toEqual({ kind: "committed", submissionId: submission });
      expect(
        (
          await admin.query(
            "SELECT provenance FROM media_song_lyrics_revisions WHERE submission_id=$1 AND lyrics_revision=3",
            [submission],
          )
        ).rows[0],
      ).toEqual({ provenance: "corrected" });
    });
    completedTestCount += 1;
  }, 40_000);
  test("allocates an opaque alias while reconciling an already-published adult song", async () => {
    await withCurrentSchema(async (admin, connection) => {
      const contentModeration = analysis.contentModeration;
      if (contentModeration === undefined) throw new Error("missing moderation fixture");
      const adultAnalysis: TrustedSongAnalysis = {
        ...analysis,
        contentModeration: {
          ...contentModeration,
          resultingContentRating: "adult_18",
        },
      };
      const adultDecision: PublicationDecision = {
        ...decision,
        contentRating: "adult_18",
      };
      await createThroughDecision(connection, adultDecision, adultAnalysis);
      const postId = `media-post-${operation}`;
      await admin.query(
        "INSERT INTO posts (community_id,post_id,author_user_id,post_type,status,visibility,title,created_at,updated_at,idempotency_key,idempotency_body_hash,author_persona_id,author_declared_rating,content_rating) VALUES ($1,$2,$3,'song','published','public','Fixture song',clock_timestamp(),clock_timestamp(),'reconciled-post',$4,$5,'general','adult_18')",
        [community, postId, actor, requestHash, personaFor(connection)],
      );

      expect(
        await run(connection, (store) =>
          store.publish({
            ...command(
              connection,
              "/media-post-submissions/:submissionId/publish",
              "publish-reconcile",
            ),
            expectedCreationRevision: 2,
            expectedAudioRevision: 1,
            expectedAnalysisRevision: 1,
            expectedDecisionRevision: 1,
            postId,
          }),
        ),
      ).toMatchObject({ kind: "committed", postId });
      const aliases = await admin.query<{
        readonly slug: string;
        readonly post_id: string;
        readonly slug_policy_version: string;
      }>("SELECT slug,post_id,slug_policy_version FROM post_slug_aliases WHERE post_id=$1", [
        postId,
      ]);
      expect(aliases.rows).toHaveLength(1);
      expect(aliases.rows[0]).toMatchObject({
        post_id: postId,
        slug_policy_version: "post-slug-v1",
      });
      expect(aliases.rows[0]?.slug).toMatch(/^song-[0-9abcdefghjkmnpqrstvwxyz]{10}$/u);
      expect(aliases.rows[0]?.slug).not.toBe("fixture-song");
    });
    completedTestCount += 1;
  }, 40_000);

  test("publishes explicit classified lyrics with their truthful label", async () => {
    await withCurrentSchema(async (admin, connection) => {
      const longDialogue = Array.from({ length: 33 }, (_, index) => `dialogue${index + 1}`).join(
        " ",
      );
      const explicitLyrics = [
        "[Verse 1]",
        "Hold on!",
        "Explicit fixture verse",
        "[Bridge – Beat Drops]",
        longDialogue,
        "[Instrumental]",
        "Hold on!",
      ].join("\n");
      const explicitAnalysis: TrustedSongAnalysis = {
        ...analysis,
        lyricsAnalysis: {
          status: "ready",
          lyricsRevision: 1,
          explicitness: "explicit",
          primaryLanguageBcp47: "en",
          secondaryLanguageBcp47: null,
          evidenceRef: "lyrics_explicit_evidence",
          policyRevision: "lyrics_explicit_policy",
          adapterRevision: "lyrics_explicit_adapter",
        },
        lyricsSafety: "allow",
      };
      const explicitDecision: PublicationDecision = {
        ...decision,
        creationRevision: 3,
        lyricsRevision: 1,
      };
      await createThroughDecision(
        connection,
        explicitDecision,
        explicitAnalysis,
        false,
        explicitLyrics,
      );
      const postId = `media-post-${operation}`;
      await run(connection, (store) =>
        store.publish({
          ...command(
            connection,
            "/media-post-submissions/:submissionId/publish",
            "publish-explicit",
          ),
          expectedCreationRevision: 3,
          expectedAudioRevision: 1,
          expectedAnalysisRevision: 1,
          expectedDecisionRevision: 1,
          postId,
          outbox: {
            outboxEventId: "media_pg_explicit_alignment_outbox",
            effectIdentity: "media_pg_explicit_alignment_effect",
            payload: {
              kind: "alignment",
              submission_id: submission,
              operation_id: operation,
              post_id: postId,
              lyrics_revision: 1,
              workflow_revision: 2,
              workflow_instance_id: `media-${operation}-r2`,
            },
          },
        }),
      );
      expect(
        (
          await admin.query(
            "SELECT lyrics_explicitness,lyrics_revision FROM media_publication_projections WHERE submission_id=$1",
            [submission],
          )
        ).rows[0],
      ).toEqual({ lyrics_explicitness: "explicit", lyrics_revision: "1" });
      expect(
        (
          await admin.query(
            `SELECT
               (SELECT count(*)::text FROM localization_lyrics_revision_lines
                 WHERE community_id=$1 AND post_id=$2 AND lyrics_revision=1) AS occurrences,
               (SELECT count(*)::text FROM localization_study_units
                 WHERE community_id=$1 AND post_id=$2) AS study_units,
               (SELECT count(*)::text FROM study_exercise_versions
                 WHERE community_id=$1 AND post_id=$2
                   AND exercise_type='say_it_back') AS source_exercises,
               (SELECT count(*)::text FROM study_unit_exercise_eligibility
                 WHERE community_id=$1 AND post_id=$2
                   AND exercise_kind='say_it_back' AND eligibility='eligible') AS eligible_units,
               (SELECT count(*)::text FROM study_unit_exercise_eligibility
                 WHERE community_id=$1 AND post_id=$2
                   AND exercise_kind='say_it_back' AND eligibility='ineligible'
                   AND ineligibility_reason='spoken_recall_too_long') AS ineligible_units`,
            [community, postId],
          )
        ).rows[0],
      ).toEqual({
        eligible_units: "2",
        ineligible_units: "1",
        occurrences: "4",
        source_exercises: "2",
        study_units: "3",
      });
      const timedTokens = [
        "Hold",
        "on!",
        "Explicit",
        "fixture",
        "verse",
        ...longDialogue.split(" "),
        "Hold",
        "on!",
      ];
      const timedLyricsArtifact = {
        version: "media-timed-lyrics-artifact-v1",
        mode: "word",
        segments: timedTokens.map((text, index) => ({
          text,
          start_ms: index * 100,
          end_ms: index * 100 + 80,
        })),
      };
      await admin.query(
        `INSERT INTO media_timed_lyrics_artifacts (
           artifact_ref,community_id,actor_user_id,submission_id,operation_id,post_id,
           audio_revision,analysis_revision,artifact_revision,canonical_audio_sha256,
           artifact_sha256,artifact,author_persona_id,lyrics_revision
         ) VALUES (
           'ready-lyrics-artifact',$1,$2,$3,$4,$5,1,1,1,$6,
           encode(sha256(convert_to($7::jsonb::text,'UTF8')),'hex'),$7::jsonb,$8,1
         )`,
        [
          community,
          actor,
          submission,
          operation,
          postId,
          audioSha256,
          JSON.stringify(timedLyricsArtifact),
          personaFor(connection),
        ],
      );
      await admin.query(
        `UPDATE media_alignment_projections
            SET alignment_revision=1,status='ready',current_artifact_ref='ready-lyrics-artifact',
                current_artifact_revision=1,updated_at=clock_timestamp()
          WHERE submission_id=$1`,
        [submission],
      );
      const readiness = await makeControlPlaneKaraokeReadinessStore(
        makeDirectPostgresControlPlaneLayer(connection),
      ).get({ communityId: community, postId });
      expect(readiness.state).toBe("ready");
      if (readiness.state === "ready") {
        expect(readiness.karaoke_lines.map(({ text }) => text)).toEqual([
          "Hold on!",
          "Explicit fixture verse",
          longDialogue,
          "Hold on!",
        ]);
        expect(readiness.karaoke_lines[0]?.id).not.toBe(readiness.karaoke_lines[3]?.id);
        expect(readiness.playback_kind).toBe("full_mix");
      }
      await admin.query("BEGIN");
      await expect(
        admin.query(
          "UPDATE media_publication_projections SET lyrics_status='no_lyrics',lyrics_revision=NULL,lyrics_text=NULL WHERE submission_id=$1",
          [submission],
        ),
      ).rejects.toThrow("published lyrics projection is not exact");
      await admin.query("ROLLBACK");
      await admin.query("BEGIN");
      await expect(
        admin.query(
          "UPDATE media_alignment_projections SET alignment_revision=1,status='unavailable',failure_code='alignment_failed',lyrics_revision=NULL,updated_at=clock_timestamp() WHERE submission_id=$1",
          [submission],
        ),
      ).rejects.toThrow("alignment lyrics revision is not the published revision");
      await admin.query("ROLLBACK");
      await admin.query(
        "ALTER TABLE media_song_lyrics_revisions DISABLE TRIGGER media_song_lyrics_insert_guard",
      );
      await admin.query(
        "INSERT INTO media_song_lyrics_revisions (submission_id,community_id,actor_user_id,author_persona_id,operation_id,lyrics_revision,creation_revision,audio_revision,canonical_audio_sha256,lyrics_text,lyrics_sha256,base_transcript_revision,provenance) VALUES ($1,$2,$3,$4,$5,2,4,1,$6,'unpublished later lyrics',encode(sha256(convert_to('unpublished later lyrics','UTF8')),'hex'),NULL,'pasted')",
        [submission, community, actor, personaFor(connection), operation, audioSha256],
      );
      await admin.query(
        "ALTER TABLE media_song_lyrics_revisions ENABLE TRIGGER media_song_lyrics_insert_guard",
      );
      await admin.query("BEGIN");
      await expect(
        admin.query(
          "INSERT INTO media_timed_lyrics_artifacts (artifact_ref,community_id,actor_user_id,submission_id,operation_id,post_id,audio_revision,analysis_revision,artifact_revision,canonical_audio_sha256,artifact_sha256,artifact,author_persona_id,lyrics_revision) VALUES ('wrong-lyrics-artifact',$1,$2,$3,$4,$5,1,1,1,$6,encode(sha256(convert_to('{\"segments\": []}'::jsonb::text,'UTF8')),'hex'),'{\"segments\": []}'::jsonb,$7,2)",
          [community, actor, submission, operation, postId, audioSha256, personaFor(connection)],
        ),
      ).rejects.toThrow("timed lyrics artifact is not bound to the published lyrics revision");
      await admin.query("ROLLBACK");
      await admin.query(
        "ALTER TABLE media_timed_lyrics_artifacts DISABLE TRIGGER media_timed_lyrics_publication_lineage_guard",
      );
      await admin.query(
        "INSERT INTO media_timed_lyrics_artifacts (artifact_ref,community_id,actor_user_id,submission_id,operation_id,post_id,audio_revision,analysis_revision,artifact_revision,canonical_audio_sha256,artifact_sha256,artifact,author_persona_id,lyrics_revision) VALUES ('wrong-lyrics-artifact',$1,$2,$3,$4,$5,1,1,1,$6,encode(sha256(convert_to('{\"segments\": []}'::jsonb::text,'UTF8')),'hex'),'{\"segments\": []}'::jsonb,$7,2)",
        [community, actor, submission, operation, postId, audioSha256, personaFor(connection)],
      );
      await admin.query(
        "ALTER TABLE media_timed_lyrics_artifacts ENABLE TRIGGER media_timed_lyrics_publication_lineage_guard",
      );
      await admin.query("BEGIN");
      await expect(
        admin.query(
          "UPDATE media_alignment_projections SET alignment_revision=1,status='ready',current_artifact_ref='wrong-lyrics-artifact',current_artifact_revision=1,updated_at=clock_timestamp() WHERE submission_id=$1",
          [submission],
        ),
      ).rejects.toThrow("alignment artifact lyrics revision is not exact");
      await admin.query("ROLLBACK");
    });
    completedTestCount += 1;
  }, 40_000);

  test("requires durable exhaustion evidence for ACR override moderation", async () => {
    await withCurrentSchema(async (admin, connection) => {
      await createThroughDecision(
        connection,
        decision,
        {
          ...analysis,
          acr: { ...analysis.acr, decision: "inconclusive" },
        },
        true,
      );
      expect(
        await run(connection, (store) =>
          store.recordProcessingAttempt({
            attemptId: "media_pg_acr_attempt_3",
            communityId: community,
            submissionId: submission,
            actorUserId: actor,
            personaId: personaFor(connection),
            operationId: operation,
            audioRevision: 1,
            analysisRevision: 1,
            stage: "acr_primary",
            inputKind: "audio",
            inputRevision: 1,
            policyRevision: "acr-policy-1",
            adapterRevision: "acr-adapter-1",
            inputHash: audioSha256,
            attemptNumber: 3,
          }),
        ),
      ).toBeUndefined();
      expect(
        await run(connection, (store) =>
          store.claimProcessingAttempt({
            attemptId: "media_pg_acr_attempt_3",
            workerId: "acr-worker",
            leaseSeconds: 30,
          }),
        ),
      ).toBe(true);
      expect(
        await run(connection, (store) =>
          store.failProcessingAttempt({
            attemptId: "media_pg_acr_attempt_3",
            workerId: "acr-worker",
            claimFence: 1,
            failureCode: "provider_invalid",
            retryable: false,
            evidenceRef: "review-acr-exhausted-evidence",
          }),
        ),
      ).toBe(true);
      expect(
        await run(connection, (store) =>
          store.requireReview({
            ...command(
              connection,
              "/media-post-submissions/:submissionId/review",
              "acr-exhaustion-key",
            ),
            expectedCreationRevision: 2,
            review: {
              reviewRef: "review-acr-exhausted-case",
              heldRevision: 2,
              reasonCode: "review_required",
              exhaustionCode: "acr_exhausted",
              exhaustionAttemptId: "media_pg_acr_attempt_3",
            },
          }),
        ),
      ).toMatchObject({ kind: "committed" });
      await expect(
        admin.query(
          "UPDATE media_post_submissions SET status='processing',phase='publish',moderator_action_id='forged',moderator_actor_id=$2,moderator_evidence_ref='forged',decision_revision=1,current_decision_revision=1,event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE submission_id=$1",
          [submission, moderator],
        ),
      ).rejects.toThrow();
      expect(
        await run(connection, (store) =>
          store.moderate({
            ...command(
              connection,
              "/media-post-submissions/:submissionId/moderate",
              "acr-moderate-key",
            ),
            expectedCreationRevision: 2,
            action: "approve",
            actor: { userId: moderator, kind: "user" },
            approval: {
              actionId: "acr-override-action",
              moderatorActorId: actor,
              evidenceRef: "acr-override-evidence",
              approvalKind: "acr_override",
              reasonCode: "acr_exhausted",
              heldRevision: 2,
            },
            decision: { ...decision, decisionRevision: 1 },
            outbox: publicationWakeup("acr"),
          }),
        ),
      ).toMatchObject({ kind: "committed" });
      const persisted = await admin.query(
        "SELECT action_kind,authority_actor_user_id,reason_code,held_revision FROM media_moderation_actions WHERE action_id=$1",
        ["acr-override-action"],
      );
      expect(persisted.rows[0]).toEqual({
        action_kind: "approve",
        authority_actor_user_id: moderator,
        reason_code: "acr_exhausted",
        held_revision: "2",
      });
    });
    completedTestCount += 1;
  }, 40_000);
  test("reclaims a crashed third outbox delivery without changing workflow identity", async () => {
    await withCurrentSchema(async (_admin, connection) => {
      await createThroughDecision(connection);
      for (const attempt of [1, 2] as const) {
        const claimed = await run(connection, (_store, outbox) =>
          outbox.claim({
            outboxEventId: "media_pg_analysis_outbox",
            workflowRevision: 1,
            workerId: `delivery-worker-${attempt}`,
            leaseSeconds: 30,
          }),
        );
        expect(claimed).toMatchObject({
          state: "running",
          claimFence: attempt,
          deliveryAttempts: attempt,
        });
        expect(
          await run(connection, (_store, outbox) =>
            outbox.markFailed({
              outboxEventId: "media_pg_analysis_outbox",
              workflowRevision: 1,
              workflowInstanceId: `media-${operation}-r1`,
              workerId: `delivery-worker-${attempt}`,
              claimFence: attempt,
              failureCode: "provider_unavailable",
              nextEligibleAt: new Date(Date.now() - 1_000).toISOString(),
            }),
          ),
        ).toBe(true);
      }
      const third = await run(connection, (_store, outbox) =>
        outbox.claim({
          outboxEventId: "media_pg_analysis_outbox",
          workflowRevision: 1,
          workerId: "delivery-worker-3",
          leaseSeconds: 1,
        }),
      );
      expect(third).toMatchObject({ state: "running", claimFence: 3, deliveryAttempts: 3 });
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const reclaimed = await run(connection, (_store, outbox) =>
        outbox.claim({
          outboxEventId: "media_pg_analysis_outbox",
          workflowRevision: 1,
          workerId: "delivery-worker-4",
          leaseSeconds: 30,
        }),
      );
      expect(reclaimed).toMatchObject({
        state: "running",
        claimFence: 4,
        deliveryAttempts: 3,
        workflowInstanceId: `media-${operation}-r1`,
      });
      expect(
        await run(connection, (_store, outbox) =>
          outbox.markDelivered({
            outboxEventId: "media_pg_analysis_outbox",
            workflowRevision: 1,
            workflowInstanceId: `media-${operation}-r1`,
            workerId: "delivery-worker-3",
            claimFence: 3,
          }),
        ),
      ).toBe(false);
      expect(
        await run(connection, (_store, outbox) =>
          outbox.markDelivered({
            outboxEventId: "media_pg_analysis_outbox",
            workflowRevision: 1,
            workflowInstanceId: `media-${operation}-r1`,
            workerId: "delivery-worker-4",
            claimFence: 4,
          }),
        ),
      ).toBe(true);
    });
    completedTestCount += 1;
  }, 40_000);
  test("parks a completed third outbox failure without a fourth claim", async () => {
    await withCurrentSchema(async (_admin, connection) => {
      await createThroughDecision(connection);
      for (const attempt of [1, 2] as const) {
        expect(
          await run(connection, (_store, outbox) =>
            outbox.claim({
              outboxEventId: "media_pg_analysis_outbox",
              workflowRevision: 1,
              workerId: `parking-worker-${attempt}`,
              leaseSeconds: 30,
            }),
          ),
        ).toMatchObject({ deliveryAttempts: attempt });
        expect(
          await run(connection, (_store, outbox) =>
            outbox.markFailed({
              outboxEventId: "media_pg_analysis_outbox",
              workflowRevision: 1,
              workflowInstanceId: `media-${operation}-r1`,
              workerId: `parking-worker-${attempt}`,
              claimFence: attempt,
              failureCode: "provider_unavailable",
              nextEligibleAt: new Date(Date.now() - 1_000).toISOString(),
            }),
          ),
        ).toBe(true);
      }
      expect(
        await run(connection, (_store, outbox) =>
          outbox.claim({
            outboxEventId: "media_pg_analysis_outbox",
            workflowRevision: 1,
            workerId: "parking-worker-3",
            leaseSeconds: 30,
          }),
        ),
      ).toMatchObject({ deliveryAttempts: 3 });
      expect(
        await run(connection, (_store, outbox) =>
          outbox.markFailed({
            outboxEventId: "media_pg_analysis_outbox",
            workflowRevision: 1,
            workflowInstanceId: `media-${operation}-r1`,
            workerId: "parking-worker-3",
            claimFence: 3,
            failureCode: "provider_invalid",
            nextEligibleAt: new Date(Date.now() - 1_000).toISOString(),
          }),
        ),
      ).toBe(true);
      expect(
        await run(connection, (_store, outbox) =>
          outbox.claim({
            outboxEventId: "media_pg_analysis_outbox",
            workflowRevision: 1,
            workerId: "parking-worker-4",
            leaseSeconds: 30,
          }),
        ),
      ).toBeNull();
    });
    completedTestCount += 1;
  }, 40_000);
  test("rejects a third processing attempt from entering retry_wait", async () => {
    await withCurrentSchema(async (admin, connection) => {
      await createThroughDecision(connection);
      await admin.query(
        "INSERT INTO media_processing_attempts (attempt_id,submission_id,community_id,actor_user_id,operation_id,audio_revision,analysis_revision,stage,attempt_number,input_hash,provider_idempotency_key,input_kind,input_revision,policy_revision,adapter_revision,state) VALUES ('media_pg_third_attempt',$1,$2,$3,$4,1,1,'acr_primary',3,$5,'media-pg-third-provider','audio',1,'acr-policy','acr-adapter','pending')",
        [submission, community, actor, operation, audioSha256],
      );
      await admin.query(
        "UPDATE media_processing_attempts SET state='running',claim_owner='third-worker',claim_fence=1,lease_expires_at=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp() WHERE attempt_id='media_pg_third_attempt'",
      );
      await admin.query("BEGIN");
      await expect(
        admin.query(
          "UPDATE media_processing_attempts SET state='retry_wait',claim_owner=NULL,lease_expires_at=NULL,retryable=TRUE,next_eligible_at=clock_timestamp()+interval '1 minute',updated_at=clock_timestamp() WHERE attempt_id='media_pg_third_attempt'",
        ),
      ).rejects.toThrow();
      await admin.query("ROLLBACK");
    });
    completedTestCount += 1;
  }, 40_000);
});
afterAll(async () => {
  if (completedTestCount === testCount) await Bun.write(sentinelPath, sentinelContents);
});
