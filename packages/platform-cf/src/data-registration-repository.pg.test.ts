import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import type { ControlPlaneDb } from "@pirate/application";
import {
  type DataRegistrationArtifact,
  deterministicDataRegistrationArtifactId,
  deterministicDataRegistrationAttemptId,
  deterministicDataRegistrationOperationId,
  deterministicDataRegistrationOutboxId,
  deterministicDataRegistrationReceiptId,
  deterministicDataRegistrationSigningIntentId,
  deterministicDataRegistrationWorkflowId,
} from "@pirate/application/data/registration-persistence";
import { consumeDataRegistrationQueueMessage } from "@pirate/application/data/registration-workflow-queue";
import { Effect } from "effect";
import { Client } from "pg";
import { makeDataRegistrationMaintenance } from "../../../apps/jobs-worker/src/data-registration-runtime.ts";
import { runDataOperatorResume } from "../../../scripts/data-registration-operator-resume.ts";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import type {
  PublicationDecision,
  SongTerms,
  TrustedSongAnalysis,
} from "../../domain/src/media-submission.ts";
import { insertActiveCommunityMembershipFixture } from "./community-follow.pg-fixture.ts";
import {
  type MetadataDocuments,
  makePostgresMetadataSnapshotResolver,
} from "./data/metadata-snapshot.ts";
import { makeDataRegistrationStore } from "./data-registration-repository.ts";
import { makeMediaProcessingStore } from "./media-processing-store.ts";
import { makeControlPlaneMediaSubmissionRepository } from "./media-submission-repository.ts";
import { activatePendingPersonaFixtures } from "./persona-wallet.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { applyPostgresMigrations } from "./postgres-migrations.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
const migrations = await loadPostgresMigrations();
const hash = (byte: string): string => byte.repeat(64);
const bytes32 = (byte: string): string => `0x${hash(byte)}`;
const address = (byte: string): string => `0x${byte.repeat(40)}`;
const schemaIdentifier = (): string =>
  `api_next_data_registration_${crypto.randomUUID().replaceAll("-", "")}`;
const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const connectionForSchema = (raw: string, schema: string): string => {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
};
const PIL_TEMPLATE = "0x2e896b0b2fdb7457499b56aaaa4ae55bcb4cd316";
const sha256Hex = async (value: Uint8Array): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", value)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

async function withSchema<A>(
  use: (admin: Client, scopedConnection: string) => Promise<A>,
  appliedMigrations?: typeof migrations,
): Promise<A> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  const schema = schemaIdentifier();
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
  const scopedConnection = connectionForSchema(connectionString, schema);
  try {
    if (appliedMigrations === undefined) {
      await applyPostgresTestBaselineConnection({ connectionString: scopedConnection });
    } else {
      await Effect.runPromise(
        Effect.scoped(
          applyPostgresMigrations(appliedMigrations).pipe(
            Effect.provide(makeDirectPostgresControlPlaneLayer(scopedConnection)),
          ),
        ),
      );
    }
    return await use(admin, scopedConnection);
  } finally {
    await admin.query("ROLLBACK");
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

async function seedLegacyPublishedSong(admin: Client): Promise<{
  accountId: string;
  communityId: string;
  personaId: string;
  submissionId: string;
  mediaOperationId: string;
  postId: string;
}> {
  const accountId = "account-data-registration";
  const communityId = "community-data-registration";
  const submissionId = "submission-data-registration";
  const mediaOperationId = "media-operation-data-registration";
  const postId = "media-post-data-registration";
  await admin.query("INSERT INTO users (user_id,status,account) VALUES ($1,'active','{}'::jsonb)", [
    accountId,
  ]);
  const walletSchema = await admin.query<{ relation: string | null }>(
    "SELECT to_regclass('persona_pending_profiles')::text AS relation",
  );
  if (walletSchema.rows[0]?.relation !== null) await activatePendingPersonaFixtures(admin);
  const personas = await admin.query<{ persona_id: string }>(
    "SELECT persona_id FROM personas WHERE account_id=$1 AND is_first_persona",
    [accountId],
  );
  const personaId = personas.rows[0]?.persona_id;
  if (personaId === undefined) throw new Error("first persona was not provisioned");
  await admin.query(
    "INSERT INTO communities (community_id,display_name,status,created_by_user_id,created_at,updated_at) VALUES ($1,'DATA registration','active',$2,clock_timestamp(),clock_timestamp())",
    [communityId, accountId],
  );
  await insertActiveCommunityMembershipFixture(admin, {
    communityId,
    membershipId: "membership-data-registration",
    userId: accountId,
  });
  await admin.query(
    "INSERT INTO posts (community_id,post_id,author_user_id,author_persona_id,post_type,status,visibility,title,created_at,updated_at) VALUES ($1,$2,$3,$4,'song','published','public','DATA fixture',clock_timestamp(),clock_timestamp())",
    [communityId, postId, accountId, personaId],
  );
  await admin.query("SET session_replication_role = replica");
  try {
    await admin.query(
      `INSERT INTO media_post_submissions (
         submission_id,community_id,actor_user_id,operation_id,idempotency_key,
         request_hash,title,song_type,start_input,audio_reservation_id,
         creation_revision,audio_revision,analysis_revision,decision_revision,
         workflow_revision,event_sequence,status,phase,post_id,current_immutable_ref,
         response_snapshot_bytes,response_snapshot_sha256,author_persona_id
       ) VALUES (
         $1,$2,$3,$4,'data-registration-media-create',$5,'DATA fixture','original',
         '{}'::jsonb,'reservation-data-registration',2,1,1,1,1,8,'published',NULL,$6,
         'r2://sealed/data-registration',convert_to('{}','UTF8'),
         encode(sha256(convert_to('{}','UTF8')),'hex'),$7
       )`,
      [submissionId, communityId, accountId, mediaOperationId, hash("1"), postId, personaId],
    );
    await admin.query(
      `INSERT INTO media_publication_projections (
         submission_id,community_id,actor_user_id,operation_id,post_id,
         creation_revision,audio_revision,analysis_revision,decision_revision,
         canonical_audio_sha256,title,audio_asset_ref,language_status,
         lyrics_explicitness,alignment,data_registration,locked_delivery,
         author_persona_id,lyrics_status
       ) VALUES (
         $1,$2,$3,$4,$5,2,1,1,1,$6,'DATA fixture','r2://sealed/data-registration',
         'not_applicable','not_applicable','not_applicable','pending','not_required',$7,
         'no_lyrics'
       )`,
      [submissionId, communityId, accountId, mediaOperationId, postId, hash("a"), personaId],
    );
  } finally {
    await admin.query("SET session_replication_role = origin");
  }
  return { accountId, communityId, personaId, submissionId, mediaOperationId, postId };
}

async function seedPublishedSong(
  admin: Client,
  connection: string,
  registerWithData = false,
): Promise<{
  accountId: string;
  communityId: string;
  personaId: string;
  submissionId: string;
  mediaOperationId: string;
  postId: string;
}> {
  const accountId = "account-data-registration";
  const communityId = "community-data-registration";
  const submissionId = "submission-data-registration";
  const mediaOperationId = "data-registration";
  const postId = `media-post-${mediaOperationId}`;
  const reservationId = "reservation-data-registration";
  const responseSnapshotBytes = new TextEncoder().encode("{}");
  const responseSnapshotSha256 = await sha256Hex(responseSnapshotBytes);
  const requestHash = hash("1");
  const canonicalAudioSha256 = hash("a");
  await admin.query("INSERT INTO users (user_id,status,account) VALUES ($1,'active','{}'::jsonb)", [
    accountId,
  ]);
  await activatePendingPersonaFixtures(admin);
  const personas = await admin.query<{ persona_id: string }>(
    "SELECT persona_id FROM personas WHERE account_id=$1 AND is_first_persona",
    [accountId],
  );
  const personaId = personas.rows[0]?.persona_id;
  if (personaId === undefined) throw new Error("first persona was not provisioned");
  await admin.query(
    "INSERT INTO communities (community_id,display_name,status,created_by_user_id,created_at,updated_at) VALUES ($1,'DATA registration','active',$2,clock_timestamp(),clock_timestamp())",
    [communityId, accountId],
  );
  await insertActiveCommunityMembershipFixture(admin, {
    communityId,
    membershipId: "membership-data-registration",
    userId: accountId,
  });
  await admin.query(
    `INSERT INTO persona_community_bindings
       (persona_id,account_id,community_id,binding_source)
     VALUES ($1,$2,$3,'first_membership')`,
    [personaId, accountId, communityId],
  );
  const layer = makeDirectPostgresControlPlaneLayer(connection);
  const submissions = makeControlPlaneMediaSubmissionRepository();
  const runMedia = <A, E>(program: Effect.Effect<A, E, ControlPlaneDb>): Promise<A> =>
    Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(layer))));
  const command = (endpointTemplate: string, idempotencyKey: string) => ({
    communityId,
    submissionId,
    actorUserId: accountId,
    personaId,
    endpointTemplate,
    idempotencyKey,
    requestHash,
    responseBytes: responseSnapshotBytes,
    responseSha256: responseSnapshotSha256,
  });
  const terms: SongTerms = {
    licensePreset: "non-commercial",
    commercialRemixShareBps: 0,
    royaltyAllocations: [{ recipientId: personaId, shareBps: 10_000 }],
    accessMode: "public",
  };
  const analysis: TrustedSongAnalysis = {
    version: "song-trusted-analysis-v1",
    operationId: mediaOperationId,
    analysisRevision: 1,
    audioRevision: 1,
    canonicalAudioSha256,
    finalizedAudioRef: "r2://sealed/data-registration",
    probeEvidenceRef: "data-registration-probe-evidence",
    embeddedMetadata: {
      evidenceRef: "data-registration-metadata-evidence",
      adapterRevision: "metadata-adapter-v1",
      trackTitle: null,
      cover: { status: "absent", reasonCode: "not_embedded" },
    },
    lyricsAnalysis: { status: "not_applicable" },
    acr: {
      decision: "allow",
      evidenceRef: "data-registration-acr-evidence",
      policyRevision: "acr-policy-v1",
      adapterRevision: "acr-adapter-v1",
    },
    mediaSafety: "allow",
    lyricsSafety: "not_applicable",
    contentModeration: {
      decision: "allow",
      resultingContentRating: "general",
      inputSha256: hash("b"),
      matchedCategories: [],
      policyRevision: "moderation-policy-v1",
      platformPolicyRevision: "platform-policy-v1",
      communityPolicyRevision: "community-policy-v1",
      evidenceRef: "data-registration-moderation-evidence",
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
    canonicalAudioSha256,
    policyRevision: "publication-policy-v1",
    evidenceRef: "data-registration-publication-evidence",
  };
  await runMedia(
    submissions.reserve({
      communityId,
      actorUserId: accountId,
      personaId,
      idempotencyKey: "data-registration-media-reserve",
      requestHash,
      expectedContentType: "audio/mpeg",
      expectedSizeBytes: 1,
      expectedSha256: canonicalAudioSha256,
      uploadUrl: "https://upload.invalid/data-registration",
      expiresAt: "2099-09-14T00:00:00.000Z",
      responseBytes: responseSnapshotBytes,
      responseSha256: responseSnapshotSha256,
      reservationId,
    }),
  );
  await runMedia(
    submissions.createSubmission({
      communityId,
      actorUserId: accountId,
      personaId,
      idempotencyKey: "data-registration-media-create",
      requestHash,
      title: "DATA fixture",
      songType: "original",
      reservationId,
      submissionId,
      operationId: mediaOperationId,
      responseBytes: responseSnapshotBytes,
      responseSha256: responseSnapshotSha256,
    }),
  );
  await runMedia(
    submissions.bindTerms({
      ...command("/media-post-submissions/:submissionId/terms", "data-registration-terms"),
      expectedCreationRevision: 1,
      terms,
    }),
  );
  const finalizeFence = {
    communityId,
    submissionId,
    actorUserId: accountId,
    personaId,
    reservationId,
    idempotencyKey: "data-registration-finalize",
    requestHash,
    expectedCreationRevision: 2,
  };
  await runMedia(submissions.beginFinalize(finalizeFence));
  await runMedia(
    submissions.finalizeSealed({
      ...command("/media-post-submissions/:submissionId/finalize", "data-registration-finalize"),
      expectedCreationRevision: 2,
      expectedAudioRevision: 0,
      reservationId,
      immutableObject: {
        immutableRef: analysis.finalizedAudioRef,
        destinationRef: analysis.finalizedAudioRef,
        etag: "data-registration-etag",
        objectVersion: "data-registration-version",
        sizeBytes: 1,
        contentType: "audio/mpeg",
        canonicalSha256: canonicalAudioSha256,
      },
      outbox: {
        outboxEventId: "data-registration-media-analysis-outbox",
        effectIdentity: "data-registration-media-analysis-effect",
        payload: {
          kind: "analysis_launch",
          submission_id: submissionId,
          operation_id: mediaOperationId,
          audio_revision: 1,
          analysis_revision: 0,
          workflow_revision: 1,
          workflow_instance_id: `media-${mediaOperationId}-r1`,
        },
      },
    }),
  );
  await runMedia(
    submissions.acceptAnalysis({
      ...command("/media-post-submissions/:submissionId/analysis", "data-registration-analysis"),
      expectedAudioRevision: 1,
      expectedCanonicalAudioSha256: canonicalAudioSha256,
      analysis,
    }),
  );
  await runMedia(
    submissions.recordDecision({
      ...command("/media-post-submissions/:submissionId/decision", "data-registration-decision"),
      expectedCreationRevision: 2,
      expectedAudioRevision: 1,
      expectedAnalysisRevision: 1,
      decision,
    }),
  );
  const processing = makeMediaProcessingStore(
    layer,
    registerWithData ? { dataRegistrationChainId: 1315n } : {},
  );
  const authority = await processing.loadAuthority(submissionId, mediaOperationId);
  if (authority === null) throw new Error("media publication authority was not created");
  if ((await processing.commitPublication(authority)) !== "committed")
    throw new Error("media publication was not committed");
  return { accountId, communityId, personaId, submissionId, mediaOperationId, postId };
}

type ReconcilableSongFixture = Readonly<{
  registrationOperationId: string;
  submissionAttemptId: string;
  transactionHash: string;
  workflowRevision: bigint;
}>;

async function seedReconcilableSong(
  store: ReturnType<typeof makeDataRegistrationStore>,
  media: Awaited<ReturnType<typeof seedPublishedSong>>,
  registrationRevision: bigint,
): Promise<ReconcilableSongFixture> {
  const chainId = 1315n;
  const registrationOperationId = deterministicDataRegistrationOperationId(
    chainId,
    media.postId,
    registrationRevision,
  );
  const workflowRevision = 1n;
  const responseSnapshotBytes = new TextEncoder().encode("{}");
  await store.createOperation({
    registrationOperationId,
    communityId: media.communityId,
    actorUserId: media.accountId,
    submissionId: media.submissionId,
    mediaOperationId: media.mediaOperationId,
    postId: media.postId,
    assetId: media.postId,
    chainId,
    registrationRevision,
    publicationCreationRevision: 2n,
    publicationAudioRevision: 1n,
    publicationAnalysisRevision: 1n,
    publicationDecisionRevision: 1n,
    canonicalAudioSha256: hash("a"),
    workflowRevision,
    workflowInstanceId: deterministicDataRegistrationWorkflowId(
      registrationOperationId,
      workflowRevision,
    ),
    outboxId: deterministicDataRegistrationOutboxId(registrationOperationId, workflowRevision),
    outboxEffectIdentity: `${registrationOperationId}:launch:r1`,
    endpointTemplate: "/internal/data-registration/operations",
    idempotencyKey: `${registrationOperationId}:create`,
    requestHash: hash("4"),
    responseSnapshotBytes,
    responseSnapshotSha256: await sha256Hex(responseSnapshotBytes),
  });
  const artifacts = [
    ["canonical_audio", "a", "audio/mpeg", null],
    ["ip_metadata", "b", "application/json", "rfc8785-jcs-v1"],
    ["nft_metadata", "c", "application/json", "rfc8785-jcs-v1"],
  ] as const;
  for (const [kind, byte, mediaType, canonicalizationRevision] of artifacts) {
    const artifactId = deterministicDataRegistrationArtifactId(registrationOperationId, kind);
    await store.recordArtifact({
      artifactId,
      registrationOperationId,
      artifactKind: kind,
      sourceRef: `fixture://${kind}`,
      mediaType,
      byteLength: 8n,
      canonicalSha256: hash(byte),
      canonicalizationRevision,
    });
    for (const [role, providerId] of [
      ["primary", "filebase"],
      ["filebase_gateway", "filebase-gateway"],
    ] as const) {
      await store.recordPinVerification({
        pinVerificationId: `${artifactId}:pin:${role}:1`,
        registrationOperationId,
        artifactId,
        artifactKind: kind,
        role,
        providerId,
        attemptNumber: 1,
        outcome: "verified",
        cid: `bafy${kind}`,
        canonicalSha256: hash(byte),
        byteLength: 8n,
        evidenceRef: `evidence://pin/${kind}/${role}`,
        verifiedAt: "2026-09-11T00:00:00.000Z",
      });
    }
  }
  const submissionAttemptId = deterministicDataRegistrationAttemptId(registrationOperationId, 1);
  await store.reserveSigningAttempt({
    registrationOperationId,
    submissionAttemptId,
    chainId,
    attemptNumber: 1,
    signerNamespace: "data_registration",
    signerAddress: address("1"),
    signingIntentId: deterministicDataRegistrationSigningIntentId(submissionAttemptId),
    targetAddress: "0x9e2d496f72c547c2c535b167e06ed8729b374a4f",
    methodSelector: "0x12345678",
    calldataHash: hash("3"),
    signingDeadline: "2030-09-11T00:00:00.000Z",
    valueWei: 0n,
    gasLimit: 1_500_000n,
    maxFeePerGas: 5_000_000_000n,
    maxPriorityFeePerGas: 2_000_000_000n,
    supersedesSubmissionAttemptId: null,
    evidenceRef: "evidence://attempt/1",
  });
  await store.reserveNonce(submissionAttemptId, 7n, "evidence://nonce/1");
  const transactionHash = bytes32("d");
  await store.persistPreparedTransaction(
    submissionAttemptId,
    new Uint8Array([1, 2, 3]),
    transactionHash,
    "evidence://prepared/1",
  );
  await store.markBroadcast(submissionAttemptId, transactionHash, "evidence://broadcast/1");
  return { registrationOperationId, submissionAttemptId, transactionHash, workflowRevision };
}

async function seedLegacyEscalatedSong(
  store: ReturnType<typeof makeDataRegistrationStore>,
  media: Awaited<ReturnType<typeof seedPublishedSong>>,
  registrationRevision: bigint,
): Promise<ReconcilableSongFixture> {
  const fixture = await seedReconcilableSong(store, media, registrationRevision);
  await store.recordReceipt({
    receiptObservationId: deterministicDataRegistrationReceiptId(fixture.submissionAttemptId, 1n),
    registrationOperationId: fixture.registrationOperationId,
    submissionAttemptId: fixture.submissionAttemptId,
    observationSequence: 1n,
    transactionHash: fixture.transactionHash,
    outcome: "confirmed",
    blockNumber: 100n,
    blockHash: bytes32("5"),
    logIndex: 3,
    confirmations: 12,
    registeredIpId: "0xdata-song-ip-id",
    ipMetadataUri: "ipfs://bafyip_metadata",
    ipMetadataHash: bytes32("b"),
    nftMetadataUri: "ipfs://bafynft_metadata",
    nftMetadataHash: bytes32("c"),
    attachedLicense: null,
    evidenceRef: "evidence://receipt/confirmed-legacy",
    observedAt: "2026-08-26T12:02:00.000Z",
  });
  expect(
    await store.reconcileTerminalWorkflow(
      fixture.registrationOperationId,
      fixture.workflowRevision,
    ),
  ).toBe("escalated");
  return fixture;
}

suite("DATA registration persistence", () => {
  test("upgrades a populated pre-DATA foundation without changing the published song", async () => {
    const dataPersistenceIndex = migrations.findIndex(
      (migration) => migration.version === "0057_data_registration_persistence.sql",
    );
    if (dataPersistenceIndex < 1) throw new Error("0057 must follow the pre-DATA foundation");
    const beforeDataPersistence = migrations.slice(0, dataPersistenceIndex);
    await withSchema(async (admin, scopedConnection) => {
      const media = await seedLegacyPublishedSong(admin);
      await Effect.runPromise(
        Effect.scoped(
          applyPostgresMigrations(migrations.slice(0, dataPersistenceIndex + 1)).pipe(
            Effect.provide(makeDirectPostgresControlPlaneLayer(scopedConnection)),
          ),
        ),
      );
      const publication = await admin.query<{
        title: string;
        data_registration: string;
      }>("SELECT title,data_registration FROM media_publication_projections WHERE post_id=$1", [
        media.postId,
      ]);
      expect(publication.rows[0]).toEqual({
        title: "DATA fixture",
        data_registration: "pending",
      });
      const tables = await admin.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema=current_schema() AND table_name LIKE 'data_registration_%'",
      );
      expect(tables.rows[0]?.count).toBe("8");
    }, beforeDataPersistence);
  }, 40_000);

  test("creates the DATA operation and launch outbox from media publication", async () => {
    await withSchema(async (admin, scopedConnection) => {
      const media = await seedPublishedSong(admin, scopedConnection, true);
      const runtime = makeDirectPostgresControlPlaneLayer(scopedConnection);
      const store = makeDataRegistrationStore(runtime);
      const registrationOperationId = deterministicDataRegistrationOperationId(
        1315n,
        media.postId,
        1n,
      );
      const operation = await store.getOperation(registrationOperationId);
      expect(operation).toMatchObject({
        registrationOperationId,
        submissionId: media.submissionId,
        mediaOperationId: media.mediaOperationId,
        postId: media.postId,
        state: "pending",
        workflowRevision: 1n,
        workflowInstanceId: deterministicDataRegistrationWorkflowId(registrationOperationId, 1n),
      });
      const outboxId = deterministicDataRegistrationOutboxId(registrationOperationId, 1n);
      expect(await store.getOutbox(outboxId)).toMatchObject({
        outboxId,
        registrationOperationId,
        workflowRevision: 1n,
        workflowInstanceId: deterministicDataRegistrationWorkflowId(registrationOperationId, 1n),
        eventType: "registration_launch",
        state: "pending",
      });
      const projection = await admin.query<{ data_registration: string }>(
        "SELECT data_registration FROM media_publication_projections WHERE post_id=$1",
        [media.postId],
      );
      expect(projection.rows[0]?.data_registration).toBe("pending");
      const queued: { outbox_id: string }[] = [];
      const maintenance = makeDataRegistrationMaintenance(
        {
          DATA_REGISTRATION_ENABLED: "true",
          DATA_REGISTRATION_QUEUE: { send: async (message) => void queued.push(message) },
          DATA_REGISTRATION_WORKFLOW: {
            get: async () => {
              throw new Error("a pending launch is not a sweep candidate");
            },
            createBatch: async () => {
              throw new Error("the dispatcher must enqueue before Workflow creation");
            },
          },
        },
        runtime,
      );
      if (maintenance === null) throw new Error("DATA maintenance was not composed");
      expect(await maintenance()).toMatchObject({ dispatched: 1, dispatchFailed: 0 });
      expect(queued).toEqual([{ outbox_id: outboxId }]);
      const launches: unknown[] = [];
      expect(
        await consumeDataRegistrationQueueMessage(queued[0], {
          store,
          workflow: {
            get: async () => "missing",
            create: async (instanceId, payload) => {
              launches.push({ instanceId, payload });
              return "created";
            },
          },
          workerId: "data-publication-composition",
          leaseSeconds: 60,
        }),
      ).toEqual({ disposition: "ack" });
      expect(launches).toEqual([
        {
          instanceId: deterministicDataRegistrationWorkflowId(registrationOperationId, 1n),
          payload: { outboxId, registrationOperationId, workflowRevision: 1n },
        },
      ]);
      expect(await store.getOutbox(outboxId)).toMatchObject({ state: "delivered" });
    });
  }, 40_000);

  test("fences pins, attempts, nonces, receipts, replays, reorgs, and Workflow replacement", async () => {
    await withSchema(async (admin, scopedConnection) => {
      const media = await seedPublishedSong(admin, scopedConnection);
      const runtime = makeDirectPostgresControlPlaneLayer(scopedConnection);
      const store = makeDataRegistrationStore(runtime);
      const chainId = 1315n;
      const registrationRevision = 1n;
      const registrationOperationId = deterministicDataRegistrationOperationId(
        chainId,
        media.postId,
        registrationRevision,
      );
      const workflowRevision = 1n;
      const responseSnapshotBytes = new TextEncoder().encode(
        JSON.stringify({ data_registration: "pending" }),
      );
      const createInput = {
        registrationOperationId,
        communityId: media.communityId,
        actorUserId: media.accountId,
        submissionId: media.submissionId,
        mediaOperationId: media.mediaOperationId,
        postId: media.postId,
        assetId: media.postId,
        chainId,
        registrationRevision,
        publicationCreationRevision: 2n,
        publicationAudioRevision: 1n,
        publicationAnalysisRevision: 1n,
        publicationDecisionRevision: 1n,
        canonicalAudioSha256: hash("a"),
        workflowRevision,
        workflowInstanceId: deterministicDataRegistrationWorkflowId(
          registrationOperationId,
          workflowRevision,
        ),
        outboxId: deterministicDataRegistrationOutboxId(registrationOperationId, workflowRevision),
        outboxEffectIdentity: `${registrationOperationId}:launch:r1`,
        endpointTemplate: "/internal/data-registration/operations",
        idempotencyKey: `${registrationOperationId}:create`,
        requestHash: hash("2"),
        responseSnapshotBytes,
        responseSnapshotSha256: await sha256Hex(responseSnapshotBytes),
      } as const;

      const created = await store.createOperation(createInput);
      expect(created.kind).toBe("created");
      expect(created.operation.state).toBe("pending");
      expect((await store.createOperation(createInput)).kind).toBe("replay");
      const replacement = await store.replaceMissingWorkflow(registrationOperationId, 1n);
      expect(replacement.operation.workflowRevision).toBe(2n);
      expect(replacement.outbox.eventType).toBe("workflow_replacement");
      const replacementReplay = await store.replaceMissingWorkflow(registrationOperationId, 1n);
      expect(replacementReplay.operation.workflowRevision).toBe(2n);
      expect(replacementReplay.outbox.outboxId).toBe(replacement.outbox.outboxId);

      const firstAttemptId = deterministicDataRegistrationAttemptId(registrationOperationId, 1);
      const firstAttemptInput = {
        registrationOperationId,
        submissionAttemptId: firstAttemptId,
        chainId,
        attemptNumber: 1,
        signerNamespace: "data-registration-staging",
        signerAddress: address("1"),
        signingIntentId: deterministicDataRegistrationSigningIntentId(firstAttemptId),
        targetAddress: address("2"),
        methodSelector: "0x12345678",
        calldataHash: hash("3"),
        signingDeadline: "2030-08-26T12:00:00.000Z",
        valueWei: 0n,
        gasLimit: 1_500_000n,
        maxFeePerGas: 5_000_000_000n,
        maxPriorityFeePerGas: 2_000_000_000n,
        supersedesSubmissionAttemptId: null,
        evidenceRef: "evidence://attempt/1",
      } as const;
      await expect(store.reserveSigningAttempt(firstAttemptInput)).rejects.toMatchObject({
        _tag: "DataRegistrationRepositoryError",
        reason: "pins-not-ready",
      });
      expect(
        (
          await admin.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM data_registration_signing_attempts WHERE signed_transaction IS NOT NULL",
          )
        ).rows[0]?.count,
      ).toBe("0");

      const artifacts = [
        {
          kind: "canonical_audio" as const,
          sha256: hash("a"),
          length: 16n,
          mediaType: "audio/mpeg",
          sourceRef: "r2://sealed/data-registration",
          canonicalizationRevision: null,
          cid: "bafyaudio",
        },
        {
          kind: "ip_metadata" as const,
          sha256: hash("b"),
          length: 32n,
          mediaType: "application/json",
          sourceRef: "r2://metadata/ip",
          canonicalizationRevision: "rfc8785-jcs-v1" as const,
          cid: "bafyipmetadata",
        },
        {
          kind: "nft_metadata" as const,
          sha256: hash("c"),
          length: 48n,
          mediaType: "application/json",
          sourceRef: "r2://metadata/nft",
          canonicalizationRevision: "rfc8785-jcs-v1" as const,
          cid: "bafynftmetadata",
        },
      ];
      for (const artifact of artifacts) {
        const artifactId = deterministicDataRegistrationArtifactId(
          registrationOperationId,
          artifact.kind,
        );
        expect(
          await store.recordArtifact({
            artifactId,
            registrationOperationId,
            artifactKind: artifact.kind,
            sourceRef: artifact.sourceRef,
            mediaType: artifact.mediaType,
            byteLength: artifact.length,
            canonicalSha256: artifact.sha256,
            canonicalizationRevision: artifact.canonicalizationRevision,
          }),
        ).toBe("created");
        for (const [role, providerId] of [
          ["primary", "filebase"],
          ["filebase_gateway", "filebase-gateway"],
        ] as const) {
          expect(
            await store.recordPinVerification({
              pinVerificationId: `${artifactId}:pin:${role}:1`,
              registrationOperationId,
              artifactId,
              artifactKind: artifact.kind,
              role,
              providerId,
              attemptNumber: 1,
              outcome: "verified",
              cid: artifact.cid,
              canonicalSha256: artifact.sha256,
              byteLength: artifact.length,
              evidenceRef: `evidence://pin/${artifact.kind}/${role}`,
              verifiedAt: "2026-08-26T12:00:00.000Z",
            }),
          ).toBe("created");
        }
      }
      expect(await store.pinsReady(registrationOperationId)).toBe(true);

      expect((await store.reserveSigningAttempt(firstAttemptInput)).kind).toBe("created");
      expect((await store.reserveSigningAttempt(firstAttemptInput)).kind).toBe("replay");
      await store.reserveNonce(firstAttemptId, 7n, "evidence://nonce/1");
      await expect(
        store.reserveNonce(firstAttemptId, 8n, "evidence://nonce/conflict"),
      ).rejects.toMatchObject({
        _tag: "DataRegistrationRepositoryError",
        reason: "identity-conflict",
      });
      const firstSignedBytes = new Uint8Array([1, 2, 3]);
      await store.persistPreparedTransaction(
        firstAttemptId,
        firstSignedBytes,
        bytes32("d"),
        "evidence://prepared/1",
      );
      await store.markBroadcast(firstAttemptId, bytes32("d"), "evidence://broadcast/1");

      const secondAttemptId = deterministicDataRegistrationAttemptId(registrationOperationId, 2);
      const secondAttemptInput = {
        ...firstAttemptInput,
        submissionAttemptId: secondAttemptId,
        attemptNumber: 2,
        signingIntentId: deterministicDataRegistrationSigningIntentId(secondAttemptId),
        calldataHash: hash("4"),
        supersedesSubmissionAttemptId: firstAttemptId,
        evidenceRef: "evidence://attempt/2",
      } as const;
      await store.reserveSigningAttempt(secondAttemptInput);
      await expect(
        store.reserveNonce(secondAttemptId, 7n, "evidence://nonce/duplicate"),
      ).rejects.toBeDefined();
      await store.reserveNonce(secondAttemptId, 8n, "evidence://nonce/2");
      await store.persistPreparedTransaction(
        secondAttemptId,
        new Uint8Array([4, 5, 6]),
        bytes32("f"),
        "evidence://prepared/2",
      );
      await store.markBroadcast(secondAttemptId, bytes32("f"), "evidence://broadcast/2");
      expect(
        (await store.markReplaced(firstAttemptId, secondAttemptId, "evidence://replaced/1")).state,
      ).toBe("replaced");

      const minedReceipt = {
        receiptObservationId: deterministicDataRegistrationReceiptId(secondAttemptId, 1n),
        registrationOperationId,
        submissionAttemptId: secondAttemptId,
        observationSequence: 1n,
        transactionHash: bytes32("f"),
        outcome: "mined" as const,
        blockNumber: 100n,
        blockHash: bytes32("5"),
        logIndex: null,
        confirmations: 1,
        registeredIpId: null,
        ipMetadataUri: null,
        ipMetadataHash: null,
        nftMetadataUri: null,
        nftMetadataHash: null,
        attachedLicense: null,
        evidenceRef: "evidence://receipt/mined",
        observedAt: "2026-08-26T12:01:00.000Z",
      };
      expect(await store.recordReceipt(minedReceipt)).toBe("created");
      await store.markMined(secondAttemptId, "evidence://mined/2");

      const confirmedReceipt = {
        receiptObservationId: deterministicDataRegistrationReceiptId(secondAttemptId, 2n),
        registrationOperationId,
        submissionAttemptId: secondAttemptId,
        observationSequence: 2n,
        transactionHash: bytes32("f"),
        outcome: "confirmed" as const,
        blockNumber: 100n,
        blockHash: bytes32("5"),
        logIndex: 3,
        confirmations: 12,
        registeredIpId: "0xdata-ip-id-1",
        ipMetadataUri: "ipfs://bafyipmetadata",
        ipMetadataHash: bytes32("b"),
        nftMetadataUri: "ipfs://bafynftmetadata",
        nftMetadataHash: bytes32("c"),
        evidenceRef: "evidence://receipt/confirmed",
        observedAt: "2026-08-26T12:02:00.000Z",
        attachedLicense: {
          licenseTemplate: PIL_TEMPLATE,
          licenseTermsId: "1894",
          preset: "commercial-remix" as const,
          commercialRevShareBps: 500,
          attachment: {
            transactionHash: bytes32("f"),
            blockNumber: 100n,
            blockHash: bytes32("5"),
            logIndex: 4,
          },
        },
      };
      const preparedAttempt = await admin.query<{
        state: string;
        nonce: string | null;
        signed_length: number | null;
        signed_transaction_hash: string | null;
        transaction_hash: string | null;
        prepared: boolean;
        broadcast: boolean;
        terminal: boolean;
        failure_code: string | null;
        failure_evidence_ref: string | null;
      }>(
        `SELECT state,nonce::text,octet_length(signed_transaction) AS signed_length,
                signed_transaction_hash,transaction_hash,prepared_at IS NOT NULL AS prepared,
                broadcast_at IS NOT NULL AS broadcast,terminal_at IS NOT NULL AS terminal,
                failure_code,failure_evidence_ref
           FROM data_registration_signing_attempts WHERE submission_attempt_id=$1`,
        [secondAttemptId],
      );
      expect(preparedAttempt.rows[0]).toEqual({
        state: "mined",
        nonce: "8",
        signed_length: 3,
        signed_transaction_hash: bytes32("f"),
        transaction_hash: bytes32("f"),
        prepared: true,
        broadcast: true,
        terminal: false,
        failure_code: null,
        failure_evidence_ref: null,
      });
      // A song confirms only with the terms it attached.
      await expect(
        store.confirmRegistration({ ...confirmedReceipt, attachedLicense: null }),
      ).rejects.toMatchObject({ _tag: "DataRegistrationRepositoryError", reason: "invalid-input" });
      const registered = await store.confirmRegistration(confirmedReceipt);
      expect(registered.state).toBe("registered");
      expect(registered.attachedLicense).toEqual(confirmedReceipt.attachedLicense);
      expect((await store.confirmRegistration(confirmedReceipt)).state).toBe("registered");
      // A terminal Workflow that observes the already-registered row is a
      // reconciled replay, while a moved revision stays fenced out.
      expect(await store.reconcileTerminalWorkflow(registrationOperationId, 2n)).toBe("reconciled");
      expect(await store.reconcileTerminalWorkflow(registrationOperationId, 3n)).toBe("stale");
      await expect(
        store.confirmRegistration({
          ...confirmedReceipt,
          attachedLicense: { ...confirmedReceipt.attachedLicense, licenseTermsId: "1314" },
        }),
      ).rejects.toMatchObject({ reason: "identity-conflict" });
      await expect(
        admin.query(
          "UPDATE data_registration_operations SET attached_license_terms_id='1314',updated_at=clock_timestamp() WHERE registration_operation_id=$1",
          [registrationOperationId],
        ),
      ).rejects.toMatchObject({ code: "P0001" });
      expect(
        (
          await admin.query<{ data_registration: string }>(
            "SELECT data_registration FROM media_publication_projections WHERE post_id=$1",
            [media.postId],
          )
        ).rows[0]?.data_registration,
      ).toBe("registered");

      const orphanedReceipt = {
        ...minedReceipt,
        receiptObservationId: deterministicDataRegistrationReceiptId(secondAttemptId, 3n),
        observationSequence: 3n,
        outcome: "orphaned" as const,
        evidenceRef: "evidence://receipt/orphaned",
        observedAt: "2026-08-26T12:03:00.000Z",
      };
      await store.recordReceipt(orphanedReceipt);
      expect(
        (
          await store.failRegistration({
            registrationOperationId,
            submissionAttemptId: secondAttemptId,
            operationState: "failed",
            operationFailureCode: "chain_reorganization",
            attemptFailureCode: "chain_reorganization",
            evidenceRef: "evidence://reorg/1",
          })
        ).state,
      ).toBe("failed");
      expect(
        (
          await store.failRegistration({
            registrationOperationId,
            submissionAttemptId: secondAttemptId,
            operationState: "failed",
            operationFailureCode: "chain_reorganization",
            attemptFailureCode: "chain_reorganization",
            evidenceRef: "evidence://reorg/1",
          })
        ).state,
      ).toBe("failed");
      await expect(
        store.failRegistration({
          registrationOperationId,
          submissionAttemptId: secondAttemptId,
          operationState: "failed",
          operationFailureCode: "chain_reorganization",
          attemptFailureCode: "chain_reorganization",
          evidenceRef: "evidence://reorg/conflict",
        }),
      ).rejects.toMatchObject({
        _tag: "DataRegistrationRepositoryError",
        reason: "identity-conflict",
      });
      expect(
        (
          await admin.query<{ data_registration: string }>(
            "SELECT data_registration FROM media_publication_projections WHERE post_id=$1",
            [media.postId],
          )
        ).rows[0]?.data_registration,
      ).toBe("failed");
      // Withdrawing the registration withdraws its terms evidence with it.
      expect((await store.getOperation(registrationOperationId))?.attachedLicense).toBeNull();
      await expect(
        admin.query(
          `UPDATE data_registration_operations
              SET state='registered',registered_ip_id='0xdata-ip-id-1',
                  confirmed_transaction_hash=$2,confirmed_block_number=100,
                  confirmed_block_hash=$3,confirmed_log_index=3,confirmed_at=clock_timestamp(),
                  failure_code=NULL,failure_evidence_ref=NULL,updated_at=clock_timestamp()
            WHERE registration_operation_id=$1`,
          [registrationOperationId, bytes32("f"), bytes32("5")],
        ),
      ).rejects.toMatchObject({ code: "P0001" });

      const recoveredReceipt = {
        ...confirmedReceipt,
        receiptObservationId: deterministicDataRegistrationReceiptId(secondAttemptId, 4n),
        observationSequence: 4n,
        evidenceRef: "evidence://receipt/recovered",
        observedAt: "2026-08-26T12:04:00.000Z",
      };
      expect((await store.confirmRegistration(recoveredReceipt)).attachedLicense).toEqual(
        confirmedReceipt.attachedLicense,
      );

      await expect(
        admin.query(
          "UPDATE data_registration_artifacts SET source_ref='r2://mutated' WHERE registration_operation_id=$1",
          [registrationOperationId],
        ),
      ).rejects.toMatchObject({ code: "P0001" });
      await expect(
        admin.query(
          "UPDATE data_registration_attempt_transitions SET evidence_ref='evidence://mutated' WHERE registration_operation_id=$1",
          [registrationOperationId],
        ),
      ).rejects.toMatchObject({ code: "P0001" });
      const counts = await admin.query<{
        operations: string;
        attempts: string;
        replays: string;
        receipts: string;
        outbox: string;
        transitions: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM data_registration_operations) AS operations,
           (SELECT count(*)::text FROM data_registration_signing_attempts) AS attempts,
           (SELECT count(*)::text FROM data_registration_command_replays) AS replays,
           (SELECT count(*)::text FROM data_registration_receipt_observations) AS receipts,
           (SELECT count(*)::text FROM data_registration_outbox) AS outbox,
           (SELECT count(*)::text FROM data_registration_attempt_transitions) AS transitions`,
      );
      expect(counts.rows[0]).toEqual({
        operations: "1",
        attempts: "2",
        replays: "1",
        receipts: "4",
        outbox: "2",
        transitions: "13",
      });
    });
  }, 40_000);

  test("reconciles a finished Workflow from submitted transaction and receipt evidence", async () => {
    await withSchema(async (admin, scopedConnection) => {
      const media = await seedPublishedSong(admin, scopedConnection);
      const store = makeDataRegistrationStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const chainId = 1315n;
      const registrationRevision = 1n;
      const registrationOperationId = deterministicDataRegistrationOperationId(
        chainId,
        media.postId,
        registrationRevision,
      );
      const workflowRevision = 1n;
      const responseSnapshotBytes = new TextEncoder().encode("{}");
      await store.createOperation({
        registrationOperationId,
        communityId: media.communityId,
        actorUserId: media.accountId,
        submissionId: media.submissionId,
        mediaOperationId: media.mediaOperationId,
        postId: media.postId,
        assetId: media.postId,
        chainId,
        registrationRevision,
        publicationCreationRevision: 2n,
        publicationAudioRevision: 1n,
        publicationAnalysisRevision: 1n,
        publicationDecisionRevision: 1n,
        canonicalAudioSha256: hash("a"),
        workflowRevision,
        workflowInstanceId: deterministicDataRegistrationWorkflowId(
          registrationOperationId,
          workflowRevision,
        ),
        outboxId: deterministicDataRegistrationOutboxId(registrationOperationId, workflowRevision),
        outboxEffectIdentity: `${registrationOperationId}:launch:r1`,
        endpointTemplate: "/internal/data-registration/operations",
        idempotencyKey: `${registrationOperationId}:create`,
        requestHash: hash("2"),
        responseSnapshotBytes,
        responseSnapshotSha256: await sha256Hex(responseSnapshotBytes),
      });
      const artifacts = [
        ["canonical_audio", "a", "audio/mpeg", null],
        ["ip_metadata", "b", "application/json", "rfc8785-jcs-v1"],
        ["nft_metadata", "c", "application/json", "rfc8785-jcs-v1"],
      ] as const;
      for (const [kind, byte, mediaType, canonicalizationRevision] of artifacts) {
        const artifactId = deterministicDataRegistrationArtifactId(registrationOperationId, kind);
        await store.recordArtifact({
          artifactId,
          registrationOperationId,
          artifactKind: kind,
          sourceRef: `fixture://${kind}`,
          mediaType,
          byteLength: 8n,
          canonicalSha256: hash(byte),
          canonicalizationRevision,
        });
        for (const [role, providerId] of [
          ["primary", "filebase"],
          ["filebase_gateway", "filebase-gateway"],
        ] as const) {
          await store.recordPinVerification({
            pinVerificationId: `${artifactId}:pin:${role}:1`,
            registrationOperationId,
            artifactId,
            artifactKind: kind,
            role,
            providerId,
            attemptNumber: 1,
            outcome: "verified",
            cid: `bafy${kind}`,
            canonicalSha256: hash(byte),
            byteLength: 8n,
            evidenceRef: `evidence://pin/${kind}/${role}`,
            verifiedAt: "2026-09-11T00:00:00.000Z",
          });
        }
      }
      const submissionAttemptId = deterministicDataRegistrationAttemptId(
        registrationOperationId,
        1,
      );
      await store.reserveSigningAttempt({
        registrationOperationId,
        submissionAttemptId,
        chainId,
        attemptNumber: 1,
        signerNamespace: "data_registration",
        signerAddress: address("1"),
        signingIntentId: deterministicDataRegistrationSigningIntentId(submissionAttemptId),
        targetAddress: "0x9e2d496f72c547c2c535b167e06ed8729b374a4f",
        methodSelector: "0x12345678",
        calldataHash: hash("3"),
        signingDeadline: "2030-09-11T00:00:00.000Z",
        valueWei: 0n,
        gasLimit: 1_500_000n,
        maxFeePerGas: 5_000_000_000n,
        maxPriorityFeePerGas: 2_000_000_000n,
        supersedesSubmissionAttemptId: null,
        evidenceRef: "evidence://attempt/1",
      });
      await store.reserveNonce(submissionAttemptId, 7n, "evidence://nonce/1");
      const transactionHash = bytes32("d");
      await store.persistPreparedTransaction(
        submissionAttemptId,
        new Uint8Array([1, 2, 3]),
        transactionHash,
        "evidence://prepared/1",
      );
      await store.markBroadcast(submissionAttemptId, transactionHash, "evidence://broadcast/1");

      // A submitted transaction with no observation is unavailable evidence:
      // it never authorizes a replacement and leaves the durable row untouched.
      expect(await store.reconcileTerminalWorkflow(registrationOperationId, workflowRevision)).toBe(
        "unavailable",
      );
      // A moved workflow authority fences the evidence out.
      expect(
        await store.reconcileTerminalWorkflow(registrationOperationId, workflowRevision + 1n),
      ).toBe("stale");
      expect(await store.getOperation(registrationOperationId)).toMatchObject({
        state: "broadcast",
        workflowRevision,
        failureCode: null,
      });

      const pendingReceipt = {
        receiptObservationId: deterministicDataRegistrationReceiptId(submissionAttemptId, 1n),
        registrationOperationId,
        submissionAttemptId,
        observationSequence: 1n,
        transactionHash,
        outcome: "pending" as const,
        blockNumber: null,
        blockHash: null,
        logIndex: null,
        confirmations: 0,
        registeredIpId: null,
        ipMetadataUri: null,
        ipMetadataHash: null,
        nftMetadataUri: null,
        nftMetadataHash: null,
        attachedLicense: null,
        evidenceRef: "evidence://receipt/pending",
        observedAt: "2026-08-26T12:00:30.000Z",
      };
      expect(await store.recordReceipt(pendingReceipt)).toBe("created");
      expect(await store.reconcileTerminalWorkflow(registrationOperationId, workflowRevision)).toBe(
        "pending",
      );
      expect(await store.getOperation(registrationOperationId)).toMatchObject({
        state: "broadcast",
        failureCode: null,
      });
      // In-flight evidence authorizes no replacement launch, even repeatedly.
      expect(
        (
          await admin.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM data_registration_outbox WHERE registration_operation_id=$1",
            [registrationOperationId],
          )
        ).rows[0]?.count,
      ).toBe("1");

      const revertedReceipt = {
        ...pendingReceipt,
        receiptObservationId: deterministicDataRegistrationReceiptId(submissionAttemptId, 2n),
        observationSequence: 2n,
        outcome: "reverted" as const,
        blockNumber: 100n,
        blockHash: bytes32("5"),
        logIndex: 0,
        confirmations: 1,
        evidenceRef: "evidence://receipt/reverted",
        observedAt: "2026-08-26T12:01:00.000Z",
      };
      expect(await store.recordReceipt(revertedReceipt)).toBe("created");
      expect(
        await Promise.all([
          store.reconcileTerminalWorkflow(registrationOperationId, workflowRevision),
          store.reconcileTerminalWorkflow(registrationOperationId, workflowRevision),
        ]),
      ).toEqual(["reverted", "reverted"]);
      expect(await store.reconcileTerminalWorkflow(registrationOperationId, workflowRevision)).toBe(
        "reverted",
      );
      expect(await store.getOperation(registrationOperationId)).toMatchObject({
        state: "failed",
        failureCode: "receipt_reverted",
      });
      // A reverted receipt is a durable failure, not grounds for resubmission.
      expect(
        (
          await admin.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM data_registration_outbox WHERE registration_operation_id=$1",
            [registrationOperationId],
          )
        ).rows[0]?.count,
      ).toBe("1");
      expect(
        (
          await admin.query<{ workflow_revision: string }>(
            "SELECT workflow_revision::text AS workflow_revision FROM data_registration_operations WHERE registration_operation_id=$1",
            [registrationOperationId],
          )
        ).rows[0]?.workflow_revision,
      ).toBe("1");
    });
  });

  test("escalates a confirmed receipt whose terms were never persisted", async () => {
    await withSchema(async (admin, scopedConnection) => {
      const media = await seedPublishedSong(admin, scopedConnection);
      const store = makeDataRegistrationStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const fixture = await seedReconcilableSong(store, media, 2n);
      const confirmedReceipt = {
        receiptObservationId: deterministicDataRegistrationReceiptId(
          fixture.submissionAttemptId,
          1n,
        ),
        registrationOperationId: fixture.registrationOperationId,
        submissionAttemptId: fixture.submissionAttemptId,
        observationSequence: 1n,
        transactionHash: fixture.transactionHash,
        outcome: "confirmed" as const,
        blockNumber: 100n,
        blockHash: bytes32("5"),
        logIndex: 3,
        confirmations: 12,
        registeredIpId: "0xdata-song-ip-id",
        ipMetadataUri: "ipfs://bafyip_metadata",
        ipMetadataHash: bytes32("b"),
        nftMetadataUri: "ipfs://bafynft_metadata",
        nftMetadataHash: bytes32("c"),
        attachedLicense: null,
        evidenceRef: "evidence://receipt/confirmed-legacy",
        observedAt: "2026-08-26T12:02:00.000Z",
      };
      expect(await store.recordReceipt(confirmedReceipt)).toBe("created");
      // A legacy confirmed observation is recognized and escalated: the
      // completion fence cannot admit a song without its attached terms, and
      // the row is never resubmitted.
      expect(
        await Promise.all([
          store.reconcileTerminalWorkflow(
            fixture.registrationOperationId,
            fixture.workflowRevision,
          ),
          store.reconcileTerminalWorkflow(
            fixture.registrationOperationId,
            fixture.workflowRevision,
          ),
        ]),
      ).toEqual(["escalated", "escalated"]);
      expect(
        await store.reconcileTerminalWorkflow(
          fixture.registrationOperationId,
          fixture.workflowRevision,
        ),
      ).toBe("escalated");
      expect(await store.getOperation(fixture.registrationOperationId)).toMatchObject({
        state: "reconciliation_required",
        failureCode: null,
      });
      expect(
        (
          await admin.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM data_registration_outbox WHERE registration_operation_id=$1",
            [fixture.registrationOperationId],
          )
        ).rows[0]?.count,
      ).toBe("1");
    });
  }, 40_000);

  test("completes a confirmed song registration from persisted terms without another submission", async () => {
    await withSchema(async (admin, scopedConnection) => {
      const media = await seedPublishedSong(admin, scopedConnection);
      const store = makeDataRegistrationStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const fixture = await seedReconcilableSong(store, media, 2n);
      const attachedLicense = {
        licenseTemplate: PIL_TEMPLATE,
        licenseTermsId: "1894",
        preset: "commercial-remix" as const,
        commercialRevShareBps: 500,
        attachment: {
          transactionHash: fixture.transactionHash,
          blockNumber: 100n,
          blockHash: bytes32("5"),
          logIndex: 4,
        },
      };
      const confirmedReceipt = {
        receiptObservationId: deterministicDataRegistrationReceiptId(
          fixture.submissionAttemptId,
          1n,
        ),
        registrationOperationId: fixture.registrationOperationId,
        submissionAttemptId: fixture.submissionAttemptId,
        observationSequence: 1n,
        transactionHash: fixture.transactionHash,
        outcome: "confirmed" as const,
        blockNumber: 100n,
        blockHash: bytes32("5"),
        logIndex: 3,
        confirmations: 12,
        registeredIpId: "0xdata-song-ip-id",
        ipMetadataUri: "ipfs://bafyip_metadata",
        ipMetadataHash: bytes32("b"),
        nftMetadataUri: "ipfs://bafynft_metadata",
        nftMetadataHash: bytes32("c"),
        attachedLicense,
        evidenceRef: "evidence://receipt/confirmed-terms",
        observedAt: "2026-08-26T12:02:00.000Z",
      };
      expect(await store.recordReceipt(confirmedReceipt)).toBe("created");
      expect(
        await Promise.all([
          store.reconcileTerminalWorkflow(
            fixture.registrationOperationId,
            fixture.workflowRevision,
          ),
          store.reconcileTerminalWorkflow(
            fixture.registrationOperationId,
            fixture.workflowRevision,
          ),
        ]),
      ).toEqual(["reconciled", "reconciled"]);
      expect(
        await store.reconcileTerminalWorkflow(
          fixture.registrationOperationId,
          fixture.workflowRevision,
        ),
      ).toBe("reconciled");
      expect(await store.getOperation(fixture.registrationOperationId)).toMatchObject({
        state: "registered",
        registeredIpId: "0xdata-song-ip-id",
        confirmedTransactionHash: fixture.transactionHash,
        attachedLicense,
      });
      expect(
        (
          await admin.query<{ data_registration: string }>(
            "SELECT data_registration FROM media_publication_projections WHERE post_id=$1",
            [media.postId],
          )
        ).rows[0]?.data_registration,
      ).toBe("registered");
      // The original launch is the only launch and the existing attempt is the
      // only attempt: completing from the receipt never resubmits.
      expect(
        (
          await admin.query<{
            outbox: string;
            attempts: string;
            receipts: string;
            transitions: string;
          }>(
            `SELECT
               (SELECT count(*)::text FROM data_registration_outbox WHERE registration_operation_id=$1) AS outbox,
               (SELECT count(*)::text FROM data_registration_signing_attempts WHERE registration_operation_id=$1) AS attempts,
               (SELECT count(*)::text FROM data_registration_receipt_observations WHERE registration_operation_id=$1) AS receipts,
               (SELECT count(*)::text FROM data_registration_attempt_transitions WHERE registration_operation_id=$1) AS transitions`,
            [fixture.registrationOperationId],
          )
        ).rows[0],
      ).toEqual({ outbox: "1", attempts: "1", receipts: "1", transitions: "6" });
    });
  }, 40_000);

  test("completes a confirmed video registration through the media-kind projection fence", async () => {
    await withSchema(async (admin, scopedConnection) => {
      const media = await seedPublishedSong(admin, scopedConnection);
      const store = makeDataRegistrationStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const videoPostId = "video-post-reconcile";
      const videoSubmissionId = "submission-video-reconcile";
      const videoOperationId = deterministicDataRegistrationOperationId(1315n, videoPostId, 1n);
      const videoMediaOperationId = "operation-video-reconcile";
      const videoHash = hash("e");
      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query(
          "INSERT INTO posts (community_id,post_id,author_user_id,author_persona_id,post_type,status,visibility,title,created_at,updated_at) VALUES ($1,$2,$3,$4,'video','published','public','reconcile video',clock_timestamp(),clock_timestamp())",
          [media.communityId, videoPostId, media.accountId, media.personaId],
        );
        await admin.query(
          `INSERT INTO media_post_submissions (
             submission_id,community_id,actor_user_id,operation_id,idempotency_key,
             request_hash,title,song_type,start_input,audio_reservation_id,
             creation_revision,audio_revision,analysis_revision,decision_revision,
             workflow_revision,event_sequence,status,phase,post_id,current_immutable_ref,
             response_snapshot_bytes,response_snapshot_sha256,author_persona_id)
           SELECT $1,community_id,actor_user_id,$2,$3,request_hash,title,song_type,
             start_input,audio_reservation_id,creation_revision,audio_revision,
             analysis_revision,decision_revision,workflow_revision,event_sequence,
             'published',NULL,$4,current_immutable_ref,response_snapshot_bytes,
             response_snapshot_sha256,author_persona_id
           FROM media_post_submissions WHERE submission_id=$5`,
          [
            videoSubmissionId,
            videoMediaOperationId,
            "submission-video-reconcile-create",
            videoPostId,
            media.submissionId,
          ],
        );
        await admin.query(
          `INSERT INTO data_registration_operations
             (registration_operation_id,community_id,actor_user_id,submission_id,
              media_operation_id,post_id,asset_id,chain_id,registration_revision,
              publication_creation_revision,publication_audio_revision,
              publication_analysis_revision,publication_decision_revision,
              canonical_audio_sha256,workflow_revision,workflow_instance_id,
              media_kind,rights_basis)
           VALUES ($1,$2,$3,$4,$5,$6,$6,1315,1,2,1,1,1,$7,1,$8,'video','original')`,
          [
            videoOperationId,
            media.communityId,
            media.accountId,
            videoSubmissionId,
            videoMediaOperationId,
            videoPostId,
            videoHash,
            deterministicDataRegistrationWorkflowId(videoOperationId, 1n),
          ],
        );
        await admin.query(
          `INSERT INTO media_publication_projections (
             submission_id,community_id,actor_user_id,operation_id,post_id,
             creation_revision,audio_revision,analysis_revision,decision_revision,
             canonical_audio_sha256,title,audio_asset_ref,language_status,
             lyrics_explicitness,alignment,data_registration,locked_delivery,
             author_persona_id,lyrics_status,media_kind,video_revision,
             video_asset_ref,poster_artifact_ref,canonical_video_sha256,original_sound_id)
           VALUES ($1,$2,$3,$4,$5,2,0,1,1,NULL,NULL,NULL,'not_applicable',
             'not_applicable','not_applicable','pending','not_required',$6,'no_lyrics',
             'video',1,'r2://sealed/reconcile-video','r2://poster/reconcile-video',$7,
             'original-sound-reconcile')`,
          [
            videoSubmissionId,
            media.communityId,
            media.accountId,
            videoMediaOperationId,
            videoPostId,
            media.personaId,
            videoHash,
          ],
        );
      } finally {
        await admin.query("SET session_replication_role = origin");
      }
      const artifacts = [
        ["canonical_video", "e", "video/mp4", null],
        ["poster", "c", "image/jpeg", null],
        ["ip_metadata", "b", "application/json", "rfc8785-jcs-v1"],
        ["nft_metadata", "9", "application/json", "rfc8785-jcs-v1"],
      ] as const;
      for (const [kind, byte, mediaType, canonicalizationRevision] of artifacts) {
        const artifactId = deterministicDataRegistrationArtifactId(videoOperationId, kind);
        await store.recordArtifact({
          artifactId,
          registrationOperationId: videoOperationId,
          artifactKind: kind,
          sourceRef: `fixture://${kind}`,
          mediaType,
          byteLength: 8n,
          canonicalSha256: hash(byte),
          canonicalizationRevision,
        });
        for (const [role, providerId] of [
          ["primary", "filebase"],
          ["filebase_gateway", "filebase-gateway"],
        ] as const) {
          await store.recordPinVerification({
            pinVerificationId: `${artifactId}:pin:${role}:1`,
            registrationOperationId: videoOperationId,
            artifactId,
            artifactKind: kind,
            role,
            providerId,
            attemptNumber: 1,
            outcome: "verified",
            cid: `bafy${kind}`,
            canonicalSha256: hash(byte),
            byteLength: 8n,
            evidenceRef: `evidence://pin/${kind}/${role}`,
            verifiedAt: "2026-09-11T00:00:00.000Z",
          });
        }
      }
      const submissionAttemptId = deterministicDataRegistrationAttemptId(videoOperationId, 1);
      await store.reserveSigningAttempt({
        registrationOperationId: videoOperationId,
        submissionAttemptId,
        chainId: 1315n,
        attemptNumber: 1,
        signerNamespace: "data_registration",
        signerAddress: address("1"),
        signingIntentId: deterministicDataRegistrationSigningIntentId(submissionAttemptId),
        targetAddress: "0x9e2d496f72c547c2c535b167e06ed8729b374a4f",
        methodSelector: "0x12345678",
        calldataHash: hash("3"),
        signingDeadline: "2030-09-11T00:00:00.000Z",
        valueWei: 0n,
        gasLimit: 1_500_000n,
        maxFeePerGas: 5_000_000_000n,
        maxPriorityFeePerGas: 2_000_000_000n,
        supersedesSubmissionAttemptId: null,
        evidenceRef: "evidence://attempt/1",
      });
      await store.reserveNonce(submissionAttemptId, 7n, "evidence://nonce/1");
      const transactionHash = bytes32("f");
      await store.persistPreparedTransaction(
        submissionAttemptId,
        new Uint8Array([1, 2, 3]),
        transactionHash,
        "evidence://prepared/1",
      );
      await store.markBroadcast(submissionAttemptId, transactionHash, "evidence://broadcast/1");
      const confirmedReceipt = {
        receiptObservationId: deterministicDataRegistrationReceiptId(submissionAttemptId, 1n),
        registrationOperationId: videoOperationId,
        submissionAttemptId,
        observationSequence: 1n,
        transactionHash,
        outcome: "confirmed" as const,
        blockNumber: 100n,
        blockHash: bytes32("5"),
        logIndex: 3,
        confirmations: 12,
        registeredIpId: "0xdata-video-ip-id",
        ipMetadataUri: "ipfs://bafyip_metadata",
        ipMetadataHash: bytes32("b"),
        nftMetadataUri: "ipfs://bafynft_metadata",
        nftMetadataHash: bytes32("9"),
        attachedLicense: null,
        evidenceRef: "evidence://receipt/confirmed-video",
        observedAt: "2026-08-26T12:02:00.000Z",
      };
      expect(await store.recordReceipt(confirmedReceipt)).toBe("created");
      expect(
        await Promise.all([
          store.reconcileTerminalWorkflow(videoOperationId, 1n),
          store.reconcileTerminalWorkflow(videoOperationId, 1n),
        ]),
      ).toEqual(["reconciled", "reconciled"]);
      expect(await store.reconcileTerminalWorkflow(videoOperationId, 1n)).toBe("reconciled");
      expect(await store.getOperation(videoOperationId)).toMatchObject({
        state: "registered",
        registeredIpId: "0xdata-video-ip-id",
        confirmedTransactionHash: transactionHash,
        attachedLicense: null,
      });
      expect(
        (
          await admin.query<{ data_registration: string }>(
            "SELECT data_registration FROM media_publication_projections WHERE post_id=$1",
            [videoPostId],
          )
        ).rows[0]?.data_registration,
      ).toBe("registered");
      // The fixture inserts the video operation without a launch, so no launch
      // exists before or after completion; the existing attempt is the only
      // attempt and completing from the receipt never resubmits.
      expect(
        (
          await admin.query<{ outbox: string; attempts: string }>(
            `SELECT
               (SELECT count(*)::text FROM data_registration_outbox WHERE registration_operation_id=$1) AS outbox,
               (SELECT count(*)::text FROM data_registration_signing_attempts WHERE registration_operation_id=$1) AS attempts`,
            [videoOperationId],
          )
        ).rows[0],
      ).toEqual({ outbox: "0", attempts: "1" });
    });
  }, 40_000);

  test("operator resume re-arms observation and rejects unauthorized or orphan audits", async () => {
    await withSchema(async (admin, scopedConnection) => {
      const media = await seedPublishedSong(admin, scopedConnection);
      const store = makeDataRegistrationStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const fixture = await seedLegacyEscalatedSong(store, media, 2n);

      // Leaving reconciliation_required without its audit is refused.
      await expect(
        admin.query(
          "UPDATE data_registration_operations SET state='broadcast',updated_at=clock_timestamp() WHERE registration_operation_id=$1",
          [fixture.registrationOperationId],
        ),
      ).rejects.toThrow("operator resume requires its exact audit");
      // An audit without its transition, attempt and launch is refused.
      await admin.query("BEGIN");
      await admin.query(
        `INSERT INTO data_operator_resume_actions
          (registration_operation_id,community_id,actor_user_id,submission_id,
           operator_principal_id,idempotency_key,request_hash,reason_code,evidence_ref,
           expected_workflow_revision,resulting_workflow_revision,resumed_attempt_id,outbox_id)
         VALUES ($1,$2,$3,$4,'fixture-operator','orphan-audit',$5,
           'receipt_inconclusive','evidence://orphan',1,2,$6,$7)`,
        [
          fixture.registrationOperationId,
          media.communityId,
          media.accountId,
          media.submissionId,
          hash("9"),
          fixture.submissionAttemptId,
          deterministicDataRegistrationOutboxId(fixture.registrationOperationId, 2n),
        ],
      );
      await expect(admin.query("COMMIT")).rejects.toThrow(
        "operator resume lacks its exact transition, attempt or launch",
      );
      await admin.query("ROLLBACK");

      const request = {
        registrationOperationId: fixture.registrationOperationId,
        operatorPrincipalId: "fixture-operator",
        idempotencyKey: "resume-1",
        evidenceRef: "evidence://operator/resume/1",
        reasonCode: "terms_evidence_unavailable" as const,
        expectedWorkflowRevision: fixture.workflowRevision,
      };
      const results = await Promise.all([
        store.resumeReconciliation(request),
        store.resumeReconciliation(request),
      ]);
      expect(results.map((result) => result.kind).sort()).toEqual(["replay", "resumed"]);
      expect(await store.resumeReconciliation(request)).toMatchObject({ kind: "replay" });
      await expect(
        store.resumeReconciliation({ ...request, evidenceRef: "evidence://different" }),
      ).rejects.toMatchObject({ reason: "identity-conflict" });
      await expect(
        store.resumeReconciliation({
          ...request,
          idempotencyKey: "resume-stale",
          expectedWorkflowRevision: 1n,
        }),
      ).rejects.toMatchObject({ reason: "stale-state" });
      const resumed = await store.getOperation(fixture.registrationOperationId);
      expect(resumed).toMatchObject({
        state: "broadcast",
        workflowRevision: 2n,
        currentAttemptId: fixture.submissionAttemptId,
      });
      const attempt = await store.getOutbox(
        deterministicDataRegistrationOutboxId(fixture.registrationOperationId, 2n),
      );
      expect(attempt).toMatchObject({
        eventType: "workflow_replacement",
        state: "pending",
        workflowRevision: 2n,
      });
      expect(
        (
          await admin.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM data_operator_resume_actions WHERE registration_operation_id=$1",
            [fixture.registrationOperationId],
          )
        ).rows[0],
      ).toEqual({ count: 1 });
      expect(
        (
          await admin.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM data_registration_signing_attempts WHERE registration_operation_id=$1",
            [fixture.registrationOperationId],
          )
        ).rows[0],
      ).toEqual({ count: 1 });
      await expect(
        admin.query("UPDATE data_operator_resume_actions SET evidence_ref='tampered'"),
      ).rejects.toThrow("append-only");
    });
  }, 40_000);

  test("operator resume command previews without writing and rejects non-admin database credentials", async () => {
    await withSchema(async (admin, scopedConnection) => {
      const media = await seedPublishedSong(admin, scopedConnection);
      const store = makeDataRegistrationStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const fixture = await seedLegacyEscalatedSong(store, media, 2n);
      const requestPath = `/tmp/data-operator-request-${randomUUID()}.json`;
      const role = `data_operator_denied_${randomUUID().replaceAll("-", "")}`;
      const request = {
        registrationOperationId: fixture.registrationOperationId,
        idempotencyKey: "resume-cli",
        evidenceRef: "evidence://operator/resume/cli",
        reasonCode: "terms_evidence_unavailable",
        expectedWorkflowRevision: Number(fixture.workflowRevision),
      };
      await writeFile(requestPath, JSON.stringify(request), { mode: 0o600 });
      await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'local_operator_test'`);
      try {
        const preview = await runDataOperatorResume(["--request", requestPath], scopedConnection);
        expect(preview).toMatchObject({
          execute: false,
          current: {
            state: "reconciliation_required",
            workflow_revision: "1",
          },
        });
        expect(
          (
            await admin.query<{ count: number }>(
              "SELECT count(*)::int AS count FROM data_operator_resume_actions",
            )
          ).rows[0],
        ).toEqual({ count: 0 });
        const denied = new URL(scopedConnection);
        denied.username = role;
        denied.password = "local_operator_test";
        await expect(
          runDataOperatorResume(["--request", requestPath, "--execute"], denied.toString()),
        ).rejects.toThrow("database_operator_required");
        expect(
          (
            await admin.query<{ count: number }>(
              "SELECT count(*)::int AS count FROM data_operator_resume_actions",
            )
          ).rows[0],
        ).toEqual({ count: 0 });
        expect(
          await runDataOperatorResume(["--request", requestPath, "--execute"], scopedConnection),
        ).toMatchObject({ execute: true, result: { kind: "resumed" } });
        expect(
          await runDataOperatorResume(["--request", requestPath, "--execute"], scopedConnection),
        ).toMatchObject({ execute: true, result: { kind: "replay" } });
        expect(
          (
            await admin.query<{ exact: boolean }>(
              "SELECT operator_principal_id = 'postgres:' || session_user AS exact FROM data_operator_resume_actions",
            )
          ).rows[0],
        ).toEqual({ exact: true });
      } finally {
        await rm(requestPath, { force: true });
        await admin.query(`DROP ROLE ${role}`);
      }
    });
  }, 40_000);

  test("resolves a song-reference video's parent only from the parent's confirmed row", async () => {
    await withSchema(async (admin, scopedConnection) => {
      const media = await seedPublishedSong(admin, scopedConnection);
      const store = makeDataRegistrationStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const parentId = deterministicDataRegistrationOperationId(1315n, media.postId, 1n);
      const childId = (post: string) => deterministicDataRegistrationOperationId(1315n, post, 1n);
      const resolvedChild = childId("video-post-resolved");
      const mismatchedChild = childId("video-post-mismatched");
      // The parent song registered with its attached terms; the children are
      // song-reference videos whose publications are outside this suite, so
      // their rows are placed with foreign keys suspended, as the other
      // fixtures here are, and everything after runs under full enforcement.
      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query(
          `INSERT INTO data_registration_operations
             (registration_operation_id,community_id,actor_user_id,submission_id,
              media_operation_id,post_id,asset_id,chain_id,registration_revision,
              publication_creation_revision,publication_audio_revision,
              publication_analysis_revision,publication_decision_revision,
              canonical_audio_sha256,workflow_revision,workflow_instance_id,state,
              current_attempt_id,registered_ip_id,confirmed_transaction_hash,
              confirmed_block_number,confirmed_block_hash,confirmed_log_index,confirmed_at,
              attached_license_template,attached_license_terms_id,attached_license_preset,
              attached_commercial_rev_share_bps,terms_attachment_transaction_hash,
              terms_attachment_block_number,terms_attachment_block_hash,
              terms_attachment_log_index)
           VALUES ($1,$2,$3,$4,$5,$6,$6,1315,1,2,1,1,1,$7,1,$8,'registered',$9,$10,$11,100,$12,4,
                   clock_timestamp(),$13,'1894','commercial-remix',500,$11,100,$12,7)`,
          [
            parentId,
            media.communityId,
            media.accountId,
            media.submissionId,
            media.mediaOperationId,
            media.postId,
            hash("a"),
            deterministicDataRegistrationWorkflowId(parentId, 1n),
            deterministicDataRegistrationAttemptId(parentId, 1),
            address("a"),
            bytes32("d"),
            bytes32("e"),
            PIL_TEMPLATE,
          ],
        );
        for (const [child, share] of [
          [resolvedChild, 500],
          [mismatchedChild, 1_000],
        ] as const) {
          const post = child.split(":")[2] ?? "";
          await admin.query(
            `INSERT INTO data_registration_operations
               (registration_operation_id,community_id,actor_user_id,submission_id,
                media_operation_id,post_id,asset_id,chain_id,registration_revision,
                publication_creation_revision,publication_audio_revision,
                publication_analysis_revision,publication_decision_revision,
                canonical_audio_sha256,workflow_revision,workflow_instance_id,
                media_kind,rights_basis)
             VALUES ($1,$2,$3,$4,$5,$6,$6,1315,1,1,1,1,1,$7,1,$8,'video','derivative')`,
            [
              child,
              media.communityId,
              media.accountId,
              `submission-${post}`,
              `operation-${post}`,
              post,
              hash("e"),
              deterministicDataRegistrationWorkflowId(child, 1n),
            ],
          );
          await admin.query(
            `INSERT INTO data_registration_parent_references
               (registration_operation_id,relationship,parent_asset_id,
                parent_registration_operation_id,expected_parent_license_preset,
                expected_parent_commercial_rev_share_bps,owner_policy_revision,
                owner_policy_hash,owner_derivative_video)
             VALUES ($1,'references_song',$2,$3,'commercial-remix',$4,1,$5,'allowed')`,
            [child, media.postId, parentId, share, hash("f")],
          );
        }
      } finally {
        await admin.query("SET session_replication_role = origin");
      }

      const parent = await store.getOperation(parentId);
      expect(parent?.attachedLicense).toEqual({
        licenseTemplate: PIL_TEMPLATE,
        licenseTermsId: "1894",
        preset: "commercial-remix",
        commercialRevShareBps: 500,
        attachment: {
          transactionHash: bytes32("d"),
          blockNumber: 100n,
          blockHash: bytes32("e"),
          logIndex: 7,
        },
      });
      expect(await store.getParentReference(resolvedChild)).toEqual({
        registrationOperationId: resolvedChild,
        relationship: "references_song",
        parentAssetId: media.postId,
        parentRegistrationOperationId: parentId,
        expectedLicense: { preset: "commercial-remix", commercialRevShareBps: 500 },
        ownerPolicy: { revision: 1n, hash: hash("f"), derivativeVideo: "allowed" },
      });
      expect(await store.getParentReference(parentId)).toBeNull();
      expect(await store.getParentResolution(resolvedChild)).toBeNull();

      // A derivative waits in its own state; nothing else can.
      expect((await store.awaitParent(resolvedChild)).state).toBe("waiting_parent");
      expect((await store.awaitParent(resolvedChild)).state).toBe("waiting_parent");
      await expect(store.awaitParent(parentId)).rejects.toMatchObject({ reason: "stale-state" });
      await expect(
        admin.query(
          "UPDATE data_registration_operations SET state='pending',updated_at=clock_timestamp() WHERE registration_operation_id=$1",
          [parentId],
        ),
      ).rejects.toMatchObject({ code: "P0001" });

      const resolution = {
        registrationOperationId: resolvedChild,
        parentRegistrationOperationId: parentId,
        parentRegistrationRevision: 1n,
        parentIpId: address("a"),
        consumedLicense: {
          licenseTemplate: PIL_TEMPLATE,
          licenseTermsId: "1894",
          preset: "commercial-remix" as const,
          commercialRevShareBps: 500,
        },
        parentRegistration: {
          transactionHash: bytes32("d"),
          blockNumber: 100n,
          blockHash: bytes32("e"),
          logIndex: 4,
        },
        termsAttachment: {
          transactionHash: bytes32("d"),
          blockNumber: 100n,
          blockHash: bytes32("e"),
          logIndex: 7,
        },
      };
      const refusedResolution = {
        _tag: "ControlPlaneStatementFailed",
        label: "data-registration.parent-resolution.insert",
        sqlState: "P0001",
      };
      // Anything that does not restate the parent's confirmed row is refused.
      for (const altered of [
        { ...resolution, parentIpId: address("b") },
        {
          ...resolution,
          consumedLicense: { ...resolution.consumedLicense, licenseTermsId: "1314" },
        },
        { ...resolution, termsAttachment: { ...resolution.termsAttachment, logIndex: 8 } },
        { ...resolution, parentRegistration: { ...resolution.parentRegistration, logIndex: 5 } },
      ]) {
        await expect(store.resolveParent(altered)).rejects.toMatchObject(refusedResolution);
      }
      // A child whose frozen expectation differs cannot consume the parent's terms.
      await expect(
        store.resolveParent({ ...resolution, registrationOperationId: mismatchedChild }),
      ).rejects.toMatchObject(refusedResolution);
      // The same two refusals, where the database's own messages are visible.
      const insertResolution = (child: string, termsId: string) =>
        admin.query(
          `INSERT INTO data_registration_parent_resolutions
             (registration_operation_id,parent_registration_operation_id,
              parent_registration_revision,parent_ip_id,license_template,license_terms_id,
              license_preset,commercial_rev_share_bps,parent_registration_transaction_hash,
              parent_registration_block_number,parent_registration_block_hash,
              parent_registration_log_index,terms_attachment_transaction_hash,
              terms_attachment_block_number,terms_attachment_block_hash,
              terms_attachment_log_index)
           VALUES ($1,$2,1,$3,$4,$5,'commercial-remix',500,$6,100,$7,4,$6,100,$7,7)`,
          [child, parentId, address("a"), PIL_TEMPLATE, termsId, bytes32("d"), bytes32("e")],
        );
      await expect(insertResolution(resolvedChild, "1314")).rejects.toThrow(
        "must restate the parent's confirmed row",
      );
      await expect(insertResolution(mismatchedChild, "1894")).rejects.toThrow(
        "must consume the expected parent license",
      );
      expect(await store.getParentResolution(mismatchedChild)).toBeNull();

      const created = await store.resolveParent(resolution);
      expect(created.kind).toBe("created");
      expect(created.resolution).toMatchObject(resolution);
      expect((await store.getOperation(resolvedChild))?.state).toBe("pending");
      expect((await store.resolveParent(resolution)).kind).toBe("replay");
      await expect(
        store.resolveParent({ ...resolution, parentIpId: address("b") }),
      ).rejects.toMatchObject({ reason: "identity-conflict" });
      await expect(
        admin.query(
          "UPDATE data_registration_parent_resolutions SET license_terms_id='1314' WHERE registration_operation_id=$1",
          [resolvedChild],
        ),
      ).rejects.toMatchObject({ code: "P0001" });
      await expect(
        admin.query(
          "DELETE FROM data_registration_parent_resolutions WHERE registration_operation_id=$1",
          [resolvedChild],
        ),
      ).rejects.toMatchObject({ code: "P0001" });

      // With every pin ready, only the resolved child may reserve a signing attempt.
      for (const child of [resolvedChild, mismatchedChild]) {
        for (const [kind, byte, mediaType] of [
          ["canonical_video", "e", "video/mp4"],
          ["poster", "c", "image/jpeg"],
          ["ip_metadata", "b", "application/json"],
          ["nft_metadata", "9", "application/json"],
        ] as const) {
          const artifactId = deterministicDataRegistrationArtifactId(child, kind);
          await store.recordArtifact({
            artifactId,
            registrationOperationId: child,
            artifactKind: kind,
            sourceRef: `fixture://${kind}`,
            mediaType,
            byteLength: 8n,
            canonicalSha256: hash(byte),
            canonicalizationRevision: mediaType === "application/json" ? "rfc8785-jcs-v1" : null,
          });
          for (const [role, providerId] of [
            ["primary", "filebase"],
            ["filebase_gateway", "filebase-gateway"],
          ] as const) {
            await store.recordPinVerification({
              pinVerificationId: `${artifactId}:pin:${role}:1`,
              registrationOperationId: child,
              artifactId,
              artifactKind: kind,
              role,
              providerId,
              attemptNumber: 1,
              outcome: "verified",
              cid: `bafy${kind}`,
              canonicalSha256: hash(byte),
              byteLength: 8n,
              evidenceRef: `evidence://pin/${kind}/${role}`,
              verifiedAt: "2026-09-11T00:00:00.000Z",
            });
          }
        }
        expect(await store.pinsReady(child)).toBe(true);
      }
      const attemptFor = (child: string) => {
        const submissionAttemptId = deterministicDataRegistrationAttemptId(child, 1);
        return {
          registrationOperationId: child,
          submissionAttemptId,
          chainId: 1315n,
          attemptNumber: 1,
          signerNamespace: "data_registration",
          signerAddress: address("1"),
          signingIntentId: deterministicDataRegistrationSigningIntentId(submissionAttemptId),
          targetAddress: "0x9e2d496f72c547c2c535b167e06ed8729b374a4f",
          methodSelector: "0x12345678",
          calldataHash: hash("3"),
          signingDeadline: "2030-09-11T00:00:00.000Z",
          valueWei: 0n,
          gasLimit: 1_500_000n,
          maxFeePerGas: 5_000_000_000n,
          maxPriorityFeePerGas: 2_000_000_000n,
          supersedesSubmissionAttemptId: null,
          evidenceRef: "evidence://attempt/1",
        };
      };
      await expect(store.reserveSigningAttempt(attemptFor(mismatchedChild))).rejects.toMatchObject({
        _tag: "ControlPlaneStatementFailed",
        label: "data-registration.attempt.insert",
        sqlState: "P0001",
      });
      await expect(
        admin.query(
          `INSERT INTO data_registration_signing_attempts
             (submission_attempt_id,registration_operation_id,chain_id,attempt_number,
              signer_namespace,signer_address,signing_intent_id,target_address,method_selector,
              calldata_hash,signing_deadline,value_wei,gas_limit,max_fee_per_gas,
              max_priority_fee_per_gas,state)
           VALUES ($1,$2,1315,1,'data_registration',$3,$4,$5,'0x12345678',$6,
                   '2030-09-11T00:00:00Z',0,1500000,5000000000,2000000000,'signing_intent')`,
          [
            attemptFor(mismatchedChild).submissionAttemptId,
            mismatchedChild,
            address("1"),
            attemptFor(mismatchedChild).signingIntentId,
            attemptFor(mismatchedChild).targetAddress,
            hash("3"),
          ],
        ),
      ).rejects.toThrow("signs only after its parent resolves");
      expect(
        (
          await admin.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM data_registration_signing_attempts WHERE registration_operation_id=$1",
            [mismatchedChild],
          )
        ).rows[0]?.count,
      ).toBe("0");
      expect((await store.reserveSigningAttempt(attemptFor(resolvedChild))).kind).toBe("created");

      // The parent's failure ends a waiting child with its own code.
      await admin.query(
        "UPDATE data_registration_operations SET state='waiting_parent',updated_at=clock_timestamp() WHERE registration_operation_id=$1",
        [mismatchedChild],
      );
      await admin.query(
        `UPDATE data_registration_operations
            SET state='failed',failure_code='parent_license_mismatch',
                failure_evidence_ref='data-registration://parent/license-mismatch',
                updated_at=clock_timestamp()
          WHERE registration_operation_id=$1`,
        [mismatchedChild],
      );
      expect(await store.getOperation(mismatchedChild)).toMatchObject({
        state: "failed",
        failureCode: "parent_license_mismatch",
        attachedLicense: null,
      });
    });
  });

  test("backfills a legacy song's attached terms from its confirming transaction in place", async () => {
    await withSchema(async (admin, scopedConnection) => {
      const media = await seedPublishedSong(admin, scopedConnection);
      const store = makeDataRegistrationStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const parentId = deterministicDataRegistrationOperationId(1315n, media.postId, 1n);
      const child = deterministicDataRegistrationOperationId(1315n, "video-post-backfill", 1n);
      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query(
          `INSERT INTO data_registration_operations
             (registration_operation_id,community_id,actor_user_id,submission_id,
              media_operation_id,post_id,asset_id,chain_id,registration_revision,
              publication_creation_revision,publication_audio_revision,
              publication_analysis_revision,publication_decision_revision,
              canonical_audio_sha256,workflow_revision,workflow_instance_id,state,
              current_attempt_id,registered_ip_id,confirmed_transaction_hash,
              confirmed_block_number,confirmed_block_hash,confirmed_log_index,confirmed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$6,1315,1,1,1,1,1,$7,1,$8,'registered',
                   $9,$10,$11,100,$12,4,clock_timestamp())`,
          [
            parentId,
            media.communityId,
            media.accountId,
            media.submissionId,
            media.mediaOperationId,
            media.postId,
            hash("a"),
            deterministicDataRegistrationWorkflowId(parentId, 1n),
            deterministicDataRegistrationAttemptId(parentId, 1),
            address("a"),
            bytes32("d"),
            bytes32("e"),
          ],
        );
        await admin.query(
          `INSERT INTO data_registration_operations
             (registration_operation_id,community_id,actor_user_id,submission_id,
              media_operation_id,post_id,asset_id,chain_id,registration_revision,
              publication_creation_revision,publication_audio_revision,
              publication_analysis_revision,publication_decision_revision,
              canonical_audio_sha256,workflow_revision,workflow_instance_id,
              media_kind,rights_basis)
           VALUES ($1,$2,$3,$4,$5,'video-post-backfill','video-post-backfill',1315,1,1,1,1,1,$6,1,$7,
                   'video','derivative')`,
          [
            child,
            media.communityId,
            media.accountId,
            "submission-video-post-backfill",
            "operation-video-post-backfill",
            hash("e"),
            deterministicDataRegistrationWorkflowId(child, 1n),
          ],
        );
        await admin.query(
          `INSERT INTO data_registration_parent_references
             (registration_operation_id,relationship,parent_asset_id,
              parent_registration_operation_id,expected_parent_license_preset,
              expected_parent_commercial_rev_share_bps,owner_policy_revision,
              owner_policy_hash,owner_derivative_video)
           VALUES ($1,'references_song',$2,$3,'commercial-remix',500,1,$4,'allowed')`,
          [child, media.postId, parentId, hash("f")],
        );
      } finally {
        await admin.query("SET session_replication_role = origin");
      }

      // The database refuses a terms fill whose attachment is not the
      // registering transaction, even while the row still has no terms.
      await expect(
        admin.query(
          `UPDATE data_registration_operations
              SET attached_license_template=$2,attached_license_terms_id='1894',
                  attached_license_preset='commercial-remix',attached_commercial_rev_share_bps=500,
                  terms_attachment_transaction_hash=$3,terms_attachment_block_number=100,
                  terms_attachment_block_hash=$4,terms_attachment_log_index=7,
                  updated_at=clock_timestamp()
            WHERE registration_operation_id=$1`,
          [parentId, PIL_TEMPLATE, bytes32("9"), bytes32("e")],
        ),
      ).rejects.toMatchObject({ code: "P0001" });

      const license = {
        licenseTemplate: PIL_TEMPLATE,
        licenseTermsId: "1894",
        preset: "commercial-remix" as const,
        commercialRevShareBps: 500,
        attachment: {
          transactionHash: bytes32("d"),
          blockNumber: 100n,
          blockHash: bytes32("e"),
          logIndex: 7,
        },
      };
      const backfilled = await store.recordAttachedLicenseBackfill(parentId, license);
      expect(backfilled).toMatchObject({
        state: "registered",
        attachedLicense: license,
        confirmedTransactionHash: bytes32("d"),
        confirmedBlockNumber: 100n,
        registeredIpId: address("a"),
      });
      // A replay restates the same evidence; a different answer is a conflict.
      expect(
        (await store.recordAttachedLicenseBackfill(parentId, license)).attachedLicense,
      ).toEqual(license);
      await expect(
        store.recordAttachedLicenseBackfill(parentId, { ...license, licenseTermsId: "1314" }),
      ).rejects.toMatchObject({ reason: "identity-conflict" });
      await expect(
        store.recordAttachedLicenseBackfill(parentId, {
          ...license,
          attachment: { ...license.attachment, transactionHash: bytes32("9") },
        }),
      ).rejects.toMatchObject({ reason: "identity-conflict" });

      // Recorded evidence is never rewritten: not changed, not cleared.
      await expect(
        admin.query(
          "UPDATE data_registration_operations SET attached_license_terms_id='1314',updated_at=clock_timestamp() WHERE registration_operation_id=$1",
          [parentId],
        ),
      ).rejects.toMatchObject({ code: "P0001" });
      await expect(
        admin.query(
          `UPDATE data_registration_operations
              SET attached_license_template=NULL,attached_license_terms_id=NULL,
                  attached_license_preset=NULL,attached_commercial_rev_share_bps=NULL,
                  terms_attachment_transaction_hash=NULL,terms_attachment_block_number=NULL,
                  terms_attachment_block_hash=NULL,terms_attachment_log_index=NULL,
                  updated_at=clock_timestamp()
            WHERE registration_operation_id=$1`,
          [parentId],
        ),
      ).rejects.toMatchObject({ code: "P0001" });

      // With the terms now recorded, the frozen child resolves against them.
      const created = await store.resolveParent({
        registrationOperationId: child,
        parentRegistrationOperationId: parentId,
        parentRegistrationRevision: 1n,
        parentIpId: address("a"),
        consumedLicense: {
          licenseTemplate: PIL_TEMPLATE,
          licenseTermsId: "1894",
          preset: "commercial-remix",
          commercialRevShareBps: 500,
        },
        parentRegistration: {
          transactionHash: bytes32("d"),
          blockNumber: 100n,
          blockHash: bytes32("e"),
          logIndex: 4,
        },
        termsAttachment: {
          transactionHash: bytes32("d"),
          blockNumber: 100n,
          blockHash: bytes32("e"),
          logIndex: 7,
        },
      });
      expect(created.kind).toBe("created");
    });
  }, 40_000);
});

async function metadataOperation(admin: Client, connection: string) {
  const media = await seedPublishedSong(admin, connection);
  const runtime = makeDirectPostgresControlPlaneLayer(connection);
  const store = makeDataRegistrationStore(runtime);
  const id = deterministicDataRegistrationOperationId(1315n, media.postId, 1n);
  const responseSnapshotBytes = new TextEncoder().encode("{}");
  await store.createOperation({
    registrationOperationId: id,
    communityId: media.communityId,
    actorUserId: media.accountId,
    submissionId: media.submissionId,
    mediaOperationId: media.mediaOperationId,
    postId: media.postId,
    assetId: media.postId,
    chainId: 1315n,
    registrationRevision: 1n,
    publicationCreationRevision: 2n,
    publicationAudioRevision: 1n,
    publicationAnalysisRevision: 1n,
    publicationDecisionRevision: 1n,
    canonicalAudioSha256: hash("a"),
    workflowRevision: 1n,
    workflowInstanceId: deterministicDataRegistrationWorkflowId(id, 1n),
    outboxId: deterministicDataRegistrationOutboxId(id, 1n),
    outboxEffectIdentity: `${id}:launch:r1`,
    endpointTemplate: "/internal/data-registration/operations",
    idempotencyKey: `${id}:create`,
    requestHash: hash("2"),
    responseSnapshotBytes,
    responseSnapshotSha256: await sha256Hex(responseSnapshotBytes),
  });
  return { id, store, resolve: makePostgresMetadataSnapshotResolver(runtime) };
}
const metadataDocuments = (rating: "general" | "adult_18", legacy = false): MetadataDocuments => ({
  schemaRevision: legacy ? "pirate-data-metadata-v1" : "pirate-data-metadata-v2",
  ipMetadata: JSON.stringify({
    schema_version: legacy ? "pirate-data-metadata-v1" : "pirate-data-metadata-v2",
    ...(legacy ? {} : { content_rating: rating }),
  }),
  nftMetadata: JSON.stringify({
    schema_version: legacy ? "pirate-data-metadata-v1" : "pirate-data-metadata-v2",
    attributes: legacy ? [] : [{ trait_type: "Content rating", value: rating }],
  }),
});

suite("DATA metadata preparation snapshots", () => {
  test("pins a whole pair under concurrent preparation and prevents artifact or snapshot drift", async () => {
    await withSchema(async (admin, connection) => {
      const { id, store, resolve } = await metadataOperation(admin, connection);
      const general = metadataDocuments("general");
      const adult = metadataDocuments("adult_18");
      const legacy = metadataDocuments("general", true);
      const [first, second] = await Promise.all([
        resolve({ operationId: id, current: general, legacy }),
        resolve({ operationId: id, current: adult, legacy }),
      ]);
      expect(first).toEqual(second);
      expect(await resolve({ operationId: id, current: adult, legacy })).toEqual(first);
      expect(
        (await admin.query("SELECT count(*)::int AS n FROM data_registration_metadata_snapshots"))
          .rows[0].n,
      ).toBe(1);
      await expect(
        admin.query(
          "UPDATE data_registration_metadata_snapshots SET ip_metadata_bytes=convert_to($1,'UTF8') WHERE registration_operation_id=$2",
          [adult.ipMetadata, id],
        ),
      ).rejects.toThrow("immutable");
      await expect(
        admin.query(
          "DELETE FROM data_registration_metadata_snapshots WHERE registration_operation_id=$1",
          [id],
        ),
      ).rejects.toThrow("immutable");
      const bytes = new TextEncoder().encode(first.ipMetadata);
      const artifact: DataRegistrationArtifact = {
        artifactId: deterministicDataRegistrationArtifactId(id, "ip_metadata"),
        registrationOperationId: id,
        artifactKind: "ip_metadata" as const,
        sourceRef: `data-registration://canonical/${id}/ip_metadata`,
        mediaType: "application/json",
        byteLength: BigInt(bytes.length),
        canonicalSha256: await sha256Hex(bytes),
        canonicalizationRevision: "rfc8785-jcs-v1",
      };
      await expect(
        store.recordArtifact({ ...artifact, canonicalSha256: hash("f") }),
      ).rejects.toThrow();
      expect(await store.recordArtifact(artifact)).toBe("created");
      expect(await store.recordArtifact(artifact)).toBe("replay");
    });
  });

  test("retains v1 bytes when only one legacy document has already been recorded", async () => {
    await withSchema(async (admin, connection) => {
      const { id, store, resolve } = await metadataOperation(admin, connection);
      const legacy = metadataDocuments("general", true);
      const bytes = new TextEncoder().encode(legacy.ipMetadata);
      await store.recordArtifact({
        artifactId: deterministicDataRegistrationArtifactId(id, "ip_metadata"),
        registrationOperationId: id,
        artifactKind: "ip_metadata",
        sourceRef: `data-registration://canonical/${id}/ip_metadata`,
        mediaType: "application/json",
        byteLength: BigInt(bytes.length),
        canonicalSha256: await sha256Hex(bytes),
        canonicalizationRevision: "rfc8785-jcs-v1",
      });
      expect(
        await resolve({ operationId: id, current: metadataDocuments("adult_18"), legacy }),
      ).toEqual(legacy);
      expect(
        await resolve({
          operationId: id,
          current: metadataDocuments("general"),
          legacy: metadataDocuments("adult_18"),
        }),
      ).toEqual(legacy);
    });
  });

  test("refuses to replace a retained artifact that neither encoder can reproduce", async () => {
    await withSchema(async (admin, connection) => {
      const { id, store, resolve } = await metadataOperation(admin, connection);
      await store.recordArtifact({
        artifactId: deterministicDataRegistrationArtifactId(id, "ip_metadata"),
        registrationOperationId: id,
        artifactKind: "ip_metadata",
        sourceRef: `data-registration://canonical/${id}/ip_metadata`,
        mediaType: "application/json",
        byteLength: 1n,
        canonicalSha256: hash("e"),
        canonicalizationRevision: "rfc8785-jcs-v1",
      });
      await expect(
        resolve({
          operationId: id,
          current: metadataDocuments("adult_18"),
          legacy: metadataDocuments("general", true),
        }),
      ).rejects.toThrow("cannot be reconstructed");
      expect(
        (await admin.query("SELECT count(*)::int AS n FROM data_registration_metadata_snapshots"))
          .rows[0].n,
      ).toBe(0);
      expect(
        (
          await admin.query(
            "SELECT canonical_sha256 FROM data_registration_artifacts WHERE registration_operation_id=$1",
            [id],
          )
        ).rows[0].canonical_sha256,
      ).toBe(hash("e"));
    });
  });
});

suite("DATA registration pin readiness SQL", () => {
  const ready = async (admin: Client, registrationOperationId: string): Promise<boolean> =>
    (
      await admin.query("SELECT data_registration_pins_are_ready($1) AS ready", [
        registrationOperationId,
      ])
    ).rows[0].ready;

  test("requires the Filebase pin and gateway evidence and accepts historical gateway rows", async () => {
    await withSchema(async (admin, scopedConnection) => {
      const media = await seedPublishedSong(admin, scopedConnection);
      const store = makeDataRegistrationStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const fixture = await seedReconcilableSong(store, media, 2n);
      expect(await ready(admin, fixture.registrationOperationId)).toBe(true);
      const roles = await admin.query<{ role: string; provider_id: string }>(
        `SELECT DISTINCT role, provider_id FROM data_registration_pin_verifications
          WHERE registration_operation_id=$1 AND role IN ('filebase_gateway','independent_gateway')
          ORDER BY role`,
        [fixture.registrationOperationId],
      );
      expect(roles.rows).toEqual([{ role: "filebase_gateway", provider_id: "filebase-gateway" }]);

      const artifactId = deterministicDataRegistrationArtifactId(
        fixture.registrationOperationId,
        "canonical_audio",
      );
      await store.recordPinVerification({
        pinVerificationId: `${artifactId}:pin:independent_gateway:1`,
        registrationOperationId: fixture.registrationOperationId,
        artifactId,
        artifactKind: "canonical_audio",
        role: "independent_gateway",
        providerId: "ipfs.io",
        attemptNumber: 1,
        outcome: "verified",
        cid: "bafycanonical_audio",
        canonicalSha256: hash("a"),
        byteLength: 8n,
        evidenceRef: "evidence://pin/canonical_audio/independent_gateway",
        verifiedAt: "2026-09-11T00:00:00.000Z",
      });
      expect(await ready(admin, fixture.registrationOperationId)).toBe(true);
    });
  });

  test("refuses inconsistent pin evidence and rejects a wrong provider or CID", async () => {
    await withSchema(async (admin, scopedConnection) => {
      const media = await seedPublishedSong(admin, scopedConnection);
      const store = makeDataRegistrationStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const fixture = await seedReconcilableSong(store, media, 3n);
      const artifactId = deterministicDataRegistrationArtifactId(
        fixture.registrationOperationId,
        "canonical_audio",
      );
      // The schema refuses a pin whose hash or length disagrees with the artifact.
      await expect(
        store.recordPinVerification({
          pinVerificationId: `${artifactId}:pin:independent_gateway:2`,
          registrationOperationId: fixture.registrationOperationId,
          artifactId,
          artifactKind: "canonical_audio",
          role: "independent_gateway",
          providerId: "ipfs.io",
          attemptNumber: 2,
          outcome: "verified",
          cid: "bafycanonical_audio",
          canonicalSha256: hash("f"),
          byteLength: 8n,
          evidenceRef: "evidence://pin/canonical_audio/mismatch",
          verifiedAt: "2026-09-11T00:00:00.000Z",
        }),
      ).rejects.toThrow();

      const seedOperationWithGateway = async (
        registrationRevision: bigint,
        gatewayProviderId: string,
        gatewayCidFor: (kind: string) => string,
      ): Promise<string> => {
        const registrationOperationId = deterministicDataRegistrationOperationId(
          1315n,
          media.postId,
          registrationRevision,
        );
        await store.createOperation({
          registrationOperationId,
          communityId: media.communityId,
          actorUserId: media.accountId,
          submissionId: media.submissionId,
          mediaOperationId: media.mediaOperationId,
          postId: media.postId,
          assetId: media.postId,
          chainId: 1315n,
          registrationRevision,
          publicationCreationRevision: 2n,
          publicationAudioRevision: 1n,
          publicationAnalysisRevision: 1n,
          publicationDecisionRevision: 1n,
          canonicalAudioSha256: hash("a"),
          workflowRevision: 1n,
          workflowInstanceId: deterministicDataRegistrationWorkflowId(registrationOperationId, 1n),
          outboxId: deterministicDataRegistrationOutboxId(registrationOperationId, 1n),
          outboxEffectIdentity: `${registrationOperationId}:launch:r1`,
          endpointTemplate: "/internal/data-registration/operations",
          idempotencyKey: `${registrationOperationId}:create`,
          requestHash: hash("4"),
          responseSnapshotBytes: new TextEncoder().encode("{}"),
          responseSnapshotSha256: await sha256Hex(new TextEncoder().encode("{}")),
        });
        for (const [kind, byte, mediaType, canonicalizationRevision] of [
          ["canonical_audio", "a", "audio/mpeg", null],
          ["ip_metadata", "b", "application/json", "rfc8785-jcs-v1"],
          ["nft_metadata", "c", "application/json", "rfc8785-jcs-v1"],
        ] as const) {
          const wrongArtifactId = deterministicDataRegistrationArtifactId(
            registrationOperationId,
            kind,
          );
          await store.recordArtifact({
            artifactId: wrongArtifactId,
            registrationOperationId,
            artifactKind: kind,
            sourceRef: `fixture://${kind}`,
            mediaType,
            byteLength: 8n,
            canonicalSha256: hash(byte),
            canonicalizationRevision,
          });
          await store.recordPinVerification({
            pinVerificationId: `${wrongArtifactId}:pin:primary:1`,
            registrationOperationId,
            artifactId: wrongArtifactId,
            artifactKind: kind,
            role: "primary",
            providerId: "filebase",
            attemptNumber: 1,
            outcome: "verified",
            cid: `bafy${kind}`,
            canonicalSha256: hash(byte),
            byteLength: 8n,
            evidenceRef: `evidence://pin/${kind}/primary`,
            verifiedAt: "2026-09-11T00:00:00.000Z",
          });
          await store.recordPinVerification({
            pinVerificationId: `${wrongArtifactId}:pin:filebase_gateway:1`,
            registrationOperationId,
            artifactId: wrongArtifactId,
            artifactKind: kind,
            role: "filebase_gateway",
            providerId: gatewayProviderId,
            attemptNumber: 1,
            outcome: "verified",
            cid: gatewayCidFor(kind),
            canonicalSha256: hash(byte),
            byteLength: 8n,
            evidenceRef: `evidence://pin/${kind}/gateway`,
            verifiedAt: "2026-09-11T00:00:00.000Z",
          });
        }
        return registrationOperationId;
      };

      const wrongProviderOperation = await seedOperationWithGateway(
        4n,
        "unknown-gateway",
        (kind) => `bafy${kind}`,
      );
      expect(await ready(admin, wrongProviderOperation)).toBe(false);

      const mismatchedCidOperation = await seedOperationWithGateway(
        5n,
        "filebase-gateway",
        (kind) => `bafy-other-${kind}`,
      );
      expect(await ready(admin, mismatchedCidOperation)).toBe(false);
    });
  });
});
