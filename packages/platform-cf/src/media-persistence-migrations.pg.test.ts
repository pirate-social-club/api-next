import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ControlPlaneDb } from "@pirate/application";
import { Effect } from "effect";
import { Client } from "pg";
import {
  loadPostgresMigrations,
  runPostgresMigrations,
} from "../../../scripts/postgres-migrations";
import type {
  PublicationDecision,
  SongTerms,
  TrustedSongAnalysis,
} from "../../domain/src/media-submission.ts";
import { makeControlPlaneMediaOutboxRepository } from "./media-outbox-repository";
import { makeControlPlaneMediaSubmissionRepository } from "./media-submission-repository";
import { backfillActivePersonaWalletFixtures } from "./persona-wallet.pg-fixture";
import { makeDirectPostgresControlPlaneLayer } from "./postgres";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
const suite = connectionString === undefined ? describe.skip : describe;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_MEDIA_MIGRATIONS_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-media-migrations-suite-complete";
const sentinelContents = "api-next-control-plane-postgres-media-migrations-suite-complete\n";
const testCount = 5;
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

function schemaName(): string {
  return `api_next_media_migration_${Date.now()}_${crypto.randomUUID().replaceAll("-", "")}`;
}

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

async function withMigrationSchema<A>(
  use: (client: Client, connection: string) => Promise<A>,
  populated = true,
): Promise<A> {
  if (connectionString === undefined) throw new Error("Postgres test configuration is unavailable");
  const schema = schemaName();
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  const connection = scopedConnection(connectionString, schema);
  try {
    const migrations = await loadPostgresMigrations();
    const mediaMigrationIndex = migrations.findIndex(
      ({ version }) => version === "0043_song_media_submission.sql",
    );
    expect(mediaMigrationIndex).toBeGreaterThanOrEqual(0);
    const foundation = migrations.slice(0, mediaMigrationIndex);
    await runPostgresMigrations({ connectionString: connection, migrations: foundation });
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    if (populated) {
      await admin.query("INSERT INTO users (user_id) VALUES ($1)", [actor]);
      await admin.query("INSERT INTO users (user_id) VALUES ($1)", [moderator]);
      await admin.query(
        "INSERT INTO communities (community_id,display_name,status,created_by_user_id,created_at,updated_at) VALUES ($1,'Media fixture','active',$2,now(),now())",
        [community, moderator],
      );
      await admin.query(
        "INSERT INTO community_memberships (community_id,membership_id,user_id,status,joined_at,created_at,updated_at) VALUES ($1,'media_pg_membership',$2,'member',now(),now(),now())",
        [community, actor],
      );
      await admin.query(
        "INSERT INTO community_memberships (community_id,membership_id,user_id,status,joined_at,created_at,updated_at) VALUES ($1,'media_pg_moderator_membership',$2,'member',now(),now(),now())",
        [community, moderator],
      );
      await seedHnsState(admin);
    }
    const before = await admin.query<{ media_table: string | null; hns_operations: string }>({
      text: "SELECT to_regclass('media_post_submissions')::text AS media_table,(SELECT count(*)::text FROM hns_control_observer_operations) AS hns_operations",
    });
    expect(before.rows[0]?.media_table).toBeNull();
    if (populated) expect(before.rows[0]?.hns_operations).toBe("1");
    const walletMigrationIndex = migrations.findIndex(
      ({ version }) => version === "0060_persona_wallet_provisioning.sql",
    );
    expect(walletMigrationIndex).toBeGreaterThan(mediaMigrationIndex);
    await runPostgresMigrations({
      connectionString: connection,
      migrations: migrations.slice(0, walletMigrationIndex),
    });
    if (populated) await backfillActivePersonaWalletFixtures(admin);
    await runPostgresMigrations({ connectionString: connection, migrations });
    if (populated) {
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
             FROM personas WHERE is_first_persona
         ON CONFLICT DO NOTHING`,
        [community],
      );
    }
    return await use(admin, connection);
  } finally {
    personaIdsByConnection.delete(connection);
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
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

async function createThroughDecision(connection: string): Promise<void> {
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
        ...command(connection, "/media-post-submissions/:submissionId/terms", "terms-key"),
        expectedCreationRevision: 1,
        terms: termsFor(personaFor(connection)),
      }),
    ),
  ).toEqual({ kind: "committed", submissionId: submission });
  expect(
    await run(connection, (store) => store.beginFinalize(finalizeFence(connection))),
  ).toMatchObject({ kind: "begun", submissionId: submission, operationId: operation });
  expect(
    await run(connection, (store) => store.beginFinalize(finalizeFence(connection))),
  ).toMatchObject({ kind: "resumed", submissionId: submission, operationId: operation });
  expect(
    await run(connection, (store) =>
      store.finalizeSealed({
        ...command(connection, "/media-post-submissions/:submissionId/finalize", "finalize-key"),
        expectedCreationRevision: 2,
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
      store.acceptAnalysis({
        ...command(connection, "/media-post-submissions/:submissionId/analysis", "analysis-key"),
        expectedAudioRevision: 1,
        expectedCanonicalAudioSha256: audioSha256,
        analysis,
      }),
    ),
  ).toEqual({ kind: "committed", submissionId: submission });
  expect(
    await run(connection, (store) =>
      store.recordDecision({
        ...command(connection, "/media-post-submissions/:submissionId/decision", "decision-key"),
        expectedCreationRevision: decision.creationRevision,
        expectedAudioRevision: decision.audioRevision,
        expectedAnalysisRevision: decision.analysisRevision,
        decision,
      }),
    ),
  ).toEqual({ kind: "committed", submissionId: submission });
}

suite("song media persistence PostgreSQL migration suite", () => {
  test("applies 0043 over populated 0042 and atomically publishes owned lineage", async () => {
    await withMigrationSchema(async (admin, connection) => {
      const appendOnlyTriggers = await admin.query<{ trigger_name: string }>(
        `SELECT trigger.tgname AS trigger_name
         FROM pg_trigger AS trigger
         JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
         JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = current_schema()
           AND NOT trigger.tgisinternal
           AND relation.relname LIKE 'media_%'
           AND trigger.tgname LIKE 'media%_append_only'
         ORDER BY trigger.tgname`,
      );
      expect(appendOnlyTriggers.rows.map(({ trigger_name }) => trigger_name)).toEqual([
        "media_analysis_evidence_append_only",
        "media_audio_revisions_append_only",
        "media_immutable_objects_append_only",
        "media_moderation_actions_append_only",
        "media_publication_decisions_append_only",
        "media_reference_evidence_append_only",
        "media_song_lyrics_append_only",
        "media_submission_command_replays_append_only",
        "media_submission_events_append_only",
        "media_submission_terms_append_only",
        "media_timed_lyrics_artifacts_append_only",
        "media_transcript_artifacts_append_only",
      ]);
      expect(appendOnlyTriggers.rows.map(({ trigger_name }) => trigger_name)).not.toContain(
        "media_moderation_action_append_only",
      );
      await createThroughDecision(connection);
      const decoded = await run(connection, (store) =>
        store.getForAuthor({
          communityId: community,
          submissionId: submission,
          actorUserId: actor,
          personaId: personaFor(connection),
        }),
      );
      expect(decoded).toMatchObject({
        creationRevision: 2,
        audioRevision: 1,
        analysisRevision: 1,
        decisionRevision: 1,
        workflowRevision: 1,
        status: "processing",
        phase: "publish",
      });
      const postId = `media-post-${operation}`;
      await admin.query(
        "INSERT INTO posts (community_id,post_id,author_user_id,post_type,status,visibility,title,created_at,updated_at,idempotency_key,idempotency_body_hash,author_persona_id) VALUES ($1,$2,$3,'song','published','public','Fixture song',clock_timestamp(),clock_timestamp(),'foreign-feed-post',$4,$5)",
        [community, postId, actor, requestHash, personaFor(connection)],
      );
      await admin.query(
        "INSERT INTO home_feed_projection (community_id,feed_item_id,post_id,rank_score,projected_at) VALUES ($1,'foreign-feed-item',$2,0,clock_timestamp())",
        [community, postId],
      );
      await expect(
        run(
          connection,
          (store) =>
            store.publish({
              ...command(
                connection,
                "/media-post-submissions/:submissionId/publish",
                "publish-key",
              ),
              expectedCreationRevision: 2,
              expectedAudioRevision: 1,
              expectedAnalysisRevision: 1,
              expectedDecisionRevision: 1,
              postId,
            }),
          1315n,
        ),
      ).rejects.toMatchObject({ reason: "post-ownership" });
      expect(
        (
          await admin.query(
            "SELECT status,(SELECT count(*)::text FROM media_publication_projections WHERE submission_id=$1) AS publications,(SELECT count(*)::text FROM data_registration_operations WHERE submission_id=$1) AS registrations FROM media_post_submissions WHERE submission_id=$1",
            [submission],
          )
        ).rows[0],
      ).toEqual({ status: "processing", publications: "0", registrations: "0" });
      await admin.query("DELETE FROM home_feed_projection WHERE community_id=$1 AND post_id=$2", [
        community,
        postId,
      ]);
      await admin.query("DELETE FROM posts WHERE community_id=$1 AND post_id=$2", [
        community,
        postId,
      ]);
      expect(
        await run(
          connection,
          (store) =>
            store.publish({
              ...command(
                connection,
                "/media-post-submissions/:submissionId/publish",
                "publish-key",
              ),
              expectedCreationRevision: 2,
              expectedAudioRevision: 1,
              expectedAnalysisRevision: 1,
              expectedDecisionRevision: 1,
              postId,
            }),
          1315n,
        ),
      ).toMatchObject({ kind: "committed", postId });
      const counts = await admin.query<{
        events: string;
        effects: string;
        publications: string;
        alignment: string;
        hns: string;
        registrations: string;
        registration_outbox: string;
        feeds: string;
        feed_item_id: string;
        aliases: string;
        slug: string;
      }>({
        text: "SELECT (SELECT count(*)::text FROM media_submission_events WHERE submission_id=$1) AS events,(SELECT count(*)::text FROM media_submission_outbox WHERE submission_id=$1) AS effects,(SELECT count(*)::text FROM media_publication_projections WHERE submission_id=$1) AS publications,(SELECT alignment FROM media_publication_projections WHERE submission_id=$1) AS alignment,(SELECT count(*)::text FROM hns_control_observer_operations) AS hns,(SELECT count(*)::text FROM data_registration_operations WHERE submission_id=$1) AS registrations,(SELECT count(*)::text FROM data_registration_outbox WHERE registration_operation_id=(SELECT registration_operation_id FROM data_registration_operations WHERE submission_id=$1)) AS registration_outbox,(SELECT count(*)::text FROM home_feed_projection WHERE community_id=$2 AND post_id=$3) AS feeds,(SELECT feed_item_id FROM home_feed_projection WHERE community_id=$2 AND post_id=$3) AS feed_item_id,(SELECT count(*)::text FROM post_slug_aliases WHERE post_id=$3) AS aliases,(SELECT slug FROM post_slug_aliases WHERE post_id=$3) AS slug",
        values: [submission, community, postId],
      });
      expect(counts.rows[0]).toEqual({
        events: "8",
        effects: "1",
        publications: "1",
        alignment: "not_applicable",
        hns: "1",
        registrations: "1",
        registration_outbox: "1",
        feeds: "1",
        feed_item_id: `media-feed-${operation}`,
        aliases: "1",
        slug: "fixture-song",
      });
      expect(
        await run(
          connection,
          (store) =>
            store.publish({
              ...command(
                connection,
                "/media-post-submissions/:submissionId/publish",
                "publish-key",
              ),
              expectedCreationRevision: 2,
              expectedAudioRevision: 1,
              expectedAnalysisRevision: 1,
              expectedDecisionRevision: 1,
              postId,
            }),
          1315n,
        ),
      ).toMatchObject({ kind: "replay", submissionId: submission, operationId: operation });
      expect(
        await run(
          connection,
          (store) =>
            store.publish({
              ...command(
                connection,
                "/media-post-submissions/:submissionId/publish",
                "publish-key",
              ),
              requestHash: "b".repeat(64),
              expectedCreationRevision: 2,
              expectedAudioRevision: 1,
              expectedAnalysisRevision: 1,
              expectedDecisionRevision: 1,
              postId,
            }),
          1315n,
        ),
      ).toEqual({ kind: "conflict", submissionId: submission });
      expect(
        (
          await admin.query<{
            registrations: string;
            registration_outbox: string;
            feeds: string;
          }>(
            "SELECT (SELECT count(*)::text FROM data_registration_operations WHERE submission_id=$1) AS registrations,(SELECT count(*)::text FROM data_registration_outbox WHERE registration_operation_id=(SELECT registration_operation_id FROM data_registration_operations WHERE submission_id=$1)) AS registration_outbox,(SELECT count(*)::text FROM home_feed_projection WHERE community_id=$2 AND post_id=$3) AS feeds",
            [submission, community, postId],
          )
        ).rows[0],
      ).toEqual({ registrations: "1", registration_outbox: "1", feeds: "1" });
      expect(
        (
          await admin.query(
            "SELECT status,post_id FROM media_post_submissions WHERE submission_id=$1",
            [submission],
          )
        ).rows[0],
      ).toEqual({ status: "published", post_id: postId });
    });
    completedTestCount += 1;
  }, 40_000);

  test("applies 0043 over an empty foundation", async () => {
    await withMigrationSchema(async (admin) => {
      expect(
        (await admin.query("SELECT count(*)::text AS count FROM media_post_submissions")).rows[0]
          ?.count,
      ).toBe("0");
    }, false);
    completedTestCount += 1;
  }, 40_000);

  test("applies 0050 over a populated accepted 0049 media foundation", async () => {
    if (connectionString === undefined)
      throw new Error("Postgres test configuration is unavailable");
    const schema = schemaName();
    const admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    const connection = scopedConnection(connectionString, schema);
    try {
      const migrations = await loadPostgresMigrations();
      const mediaIndex = migrations.findIndex(
        ({ version }) => version === "0043_song_media_submission.sql",
      );
      const lyricsIndex = migrations.findIndex(
        ({ version }) => version === "0050_song_lyrics_foundation.sql",
      );
      expect(mediaIndex).toBeGreaterThanOrEqual(0);
      expect(lyricsIndex).toBeGreaterThan(mediaIndex);
      await runPostgresMigrations({
        connectionString: connection,
        migrations: migrations.slice(0, mediaIndex),
      });
      await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      await admin.query("INSERT INTO users (user_id) VALUES ($1)", [actor]);
      await admin.query(
        "INSERT INTO communities (community_id,display_name,status,created_by_user_id,created_at,updated_at) VALUES ($1,'Media 0048 fixture','active',$2,now(),now())",
        [community, actor],
      );
      await admin.query(
        "INSERT INTO community_memberships (community_id,membership_id,user_id,status,joined_at,created_at,updated_at) VALUES ($1,'media_0048_membership',$2,'member',now(),now(),now())",
        [community, actor],
      );
      await runPostgresMigrations({
        connectionString: connection,
        migrations: migrations.slice(0, lyricsIndex),
      });
      const persona = (
        await admin.query<{ persona_id: string }>(
          "SELECT persona_id FROM personas WHERE account_id=$1 AND is_first_persona",
          [actor],
        )
      ).rows[0]?.persona_id;
      if (persona === undefined) throw new Error("missing 0048 migration persona fixture");
      await admin.query("ALTER TABLE media_upload_reservations DISABLE TRIGGER USER");
      await admin.query("ALTER TABLE media_post_submissions DISABLE TRIGGER USER");
      await admin.query(
        "INSERT INTO media_upload_reservations (reservation_id,community_id,actor_user_id,idempotency_key,request_hash,expected_content_type,expected_size_bytes,expected_sha256,upload_url,expires_at,state,submission_id,operation_id,claim_fence,response_snapshot_bytes,response_snapshot_sha256,actor_persona_id) VALUES ($1,$2,$3,'media-0048-reserve',$4,'audio/mpeg',$5,$6,'https://upload.test/media',clock_timestamp()+interval '1 hour','claimed',$7,$8,1,$9,$10,$11)",
        [
          reservation,
          community,
          actor,
          requestHash,
          audioBytes.byteLength,
          audioSha256,
          submission,
          operation,
          responseBytes,
          responseSha256,
          persona,
        ],
      );
      await admin.query(
        "INSERT INTO media_post_submissions (submission_id,community_id,actor_user_id,operation_id,idempotency_key,request_hash,title,song_type,start_input,audio_reservation_id,creation_revision,audio_revision,analysis_revision,decision_revision,workflow_revision,event_sequence,status,phase,response_snapshot_bytes,response_snapshot_sha256,author_persona_id) VALUES ($1,$2,$3,$4,'media-0048-create',$5,'0048 song','original',$6::jsonb,$7,1,0,0,0,0,2,'processing','awaiting_upload',$8,$9,$10)",
        [
          submission,
          community,
          actor,
          operation,
          requestHash,
          JSON.stringify({
            version: "song-start-input-v1",
            title: "0048 song",
            song_type: "original",
            audio_reservation_id: reservation,
            persona_id: persona,
          }),
          reservation,
          responseBytes,
          responseSha256,
          persona,
        ],
      );
      const legacyPostId = "media_0048_legacy_post";
      await admin.query(
        "INSERT INTO posts (community_id,post_id,author_user_id,post_type,status,visibility,title,created_at,updated_at,idempotency_key,idempotency_body_hash,author_persona_id) VALUES ($1,$2,$3,'song','published','public','0048 song',clock_timestamp(),clock_timestamp(),'media-0048-post',$4,$5)",
        [community, legacyPostId, actor, requestHash, persona],
      );
      await admin.query(
        "UPDATE media_post_submissions SET audio_revision=1,analysis_revision=1,workflow_revision=1,current_immutable_ref='media-0048-immutable',status='published',phase=NULL,post_id=$2 WHERE submission_id=$1",
        [submission, legacyPostId],
      );
      await admin.query("ALTER TABLE media_post_submissions ENABLE TRIGGER USER");
      await admin.query("ALTER TABLE media_upload_reservations ENABLE TRIGGER USER");
      const legacyWorkflowInstanceId = `media-${operation}-r1`;
      for (const [eventType, outboxEventId, effectIdentity] of [
        ["publication", "media_0048_publication_outbox", "media_0048_publication_effect"],
        ["alignment", "media_0048_alignment_outbox", "media_0048_alignment_effect"],
      ] as const)
        await admin.query(
          "INSERT INTO media_submission_outbox (outbox_event_id,submission_id,community_id,actor_user_id,operation_id,creation_revision,audio_revision,analysis_revision,workflow_revision,workflow_instance_id,event_type,effect_identity,payload,author_persona_id) VALUES ($1,$2,$3,$4,$5,1,1,1,1,$6,$7,$8,$9::jsonb,$10)",
          [
            outboxEventId,
            submission,
            community,
            actor,
            operation,
            legacyWorkflowInstanceId,
            eventType,
            effectIdentity,
            JSON.stringify({
              kind: eventType,
              submission_id: submission,
              operation_id: operation,
              post_id: legacyPostId,
              workflow_revision: 1,
              workflow_instance_id: legacyWorkflowInstanceId,
            }),
            persona,
          ],
        );
      const walletMigrationIndex = migrations.findIndex(
        ({ version }) => version === "0060_persona_wallet_provisioning.sql",
      );
      expect(walletMigrationIndex).toBeGreaterThan(lyricsIndex);
      await runPostgresMigrations({
        connectionString: connection,
        migrations: migrations.slice(0, walletMigrationIndex),
      });
      await backfillActivePersonaWalletFixtures(admin);
      await runPostgresMigrations({ connectionString: connection, migrations });
      expect(
        (
          await admin.query(
            "SELECT lyrics_revision,current_lyrics_revision,workflow_replacement_sequence FROM media_post_submissions WHERE submission_id=$1",
            [submission],
          )
        ).rows[0],
      ).toEqual({
        lyrics_revision: "0",
        current_lyrics_revision: null,
        workflow_replacement_sequence: "0",
      });
      for (const [eventType, outboxEventId, effectIdentity] of [
        ["publication", "media_0048_publication_outbox", "media_0048_publication_effect"],
        ["alignment", "media_0048_alignment_outbox", "media_0048_alignment_effect"],
      ] as const) {
        const upgraded = await run(connection, (_store, outbox) => outbox.get(outboxEventId));
        expect(upgraded).toMatchObject({
          outboxEventId,
          effectIdentity,
          eventType,
          creationRevision: 1,
          audioRevision: 1,
          analysisRevision: 1,
          lyricsRevision: null,
          workflowRevision: 1,
          payload: {
            kind: eventType,
            submission_id: submission,
            operation_id: operation,
            lyrics_revision: null,
            workflow_revision: 1,
            workflow_instance_id: legacyWorkflowInstanceId,
          },
        });
        const claimed = await run(connection, (_store, outbox) =>
          outbox.claim({
            outboxEventId,
            workflowRevision: 1,
            workerId: `media_0048_${eventType}_worker`,
            leaseSeconds: 30,
          }),
        );
        expect(claimed).toMatchObject({ state: "running", claimFence: 1 });
        if (claimed === null) throw new Error(`failed to claim ${eventType} fixture`);
        expect(
          await run(connection, (_store, outbox) =>
            outbox.markDelivered({
              outboxEventId,
              workflowRevision: 1,
              workflowInstanceId: legacyWorkflowInstanceId,
              workerId: `media_0048_${eventType}_worker`,
              claimFence: claimed.claimFence,
            }),
          ),
        ).toBe(true);
      }
    } finally {
      await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
      await admin.end();
    }
    completedTestCount += 1;
  }, 40_000);

  test("fails 0050 atomically over unreconciled ready and timed 0049 rows", async () => {
    if (connectionString === undefined)
      throw new Error("Postgres test configuration is unavailable");
    const schema = schemaName();
    const admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    const connection = scopedConnection(connectionString, schema);
    try {
      const migrations = await loadPostgresMigrations();
      const lyricsIndex = migrations.findIndex(
        ({ version }) => version === "0050_song_lyrics_foundation.sql",
      );
      expect(lyricsIndex).toBeGreaterThan(0);
      await runPostgresMigrations({
        connectionString: connection,
        migrations: migrations.slice(0, lyricsIndex),
      });
      await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      await admin.query("ALTER TABLE media_analysis_evidence DISABLE TRIGGER ALL");
      await admin.query(
        `INSERT INTO media_analysis_evidence (
          submission_id,community_id,actor_user_id,operation_id,analysis_version,
          audio_revision,analysis_revision,canonical_audio_sha256,finalized_audio_ref,
          probe_evidence_ref,embedded_metadata_evidence_ref,embedded_metadata_adapter_revision,
          embedded_title,embedded_title_provenance,cover_status,cover_facts,speech_status,
          transcript_artifact_ref,transcript_sha256,explicitness,primary_language_bcp47,
          speech_evidence_ref,speech_policy_revision,speech_adapter_revision,acr_decision,
          acr_evidence_ref,acr_policy_revision,acr_adapter_revision,media_safety,lyrics_safety,
          analysis_snapshot,author_persona_id
        ) VALUES (
          'legacy-ready','legacy-community','legacy-actor','legacy-operation','song-trusted-analysis-v1',
          1,1,$1,'legacy-audio','probe','embedded','embedded-v1',NULL,'absent','absent',
          '{"reasonCode":"not_embedded"}'::jsonb,'ready','legacy-transcript',$1,
          'not_explicit','en','speech','speech-policy','speech-adapter','allow','acr',
          'acr-policy','acr-adapter','allow','allow','{}'::jsonb,'legacy-persona'
        )`,
        [audioSha256],
      );
      await admin.query("ALTER TABLE media_analysis_evidence ENABLE TRIGGER ALL");
      await admin.query("ALTER TABLE media_timed_lyrics_artifacts DISABLE TRIGGER ALL");
      await admin.query(
        "INSERT INTO media_timed_lyrics_artifacts (artifact_ref,community_id,actor_user_id,submission_id,operation_id,post_id,audio_revision,analysis_revision,artifact_revision,canonical_audio_sha256,artifact_sha256,artifact,author_persona_id) VALUES ('legacy-timed','legacy-community','legacy-actor','legacy-ready','legacy-operation','legacy-post',1,1,1,$1,$1,'{\"segments\": []}'::jsonb,'legacy-persona')",
        [audioSha256],
      );
      await admin.query("ALTER TABLE media_timed_lyrics_artifacts ENABLE TRIGGER ALL");
      await expect(
        runPostgresMigrations({ connectionString: connection, migrations }),
      ).rejects.toThrow();
      expect(
        (
          await admin.query(
            "SELECT count(*)::text AS count FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='media_post_submissions' AND column_name='lyrics_revision'",
          )
        ).rows[0]?.count,
      ).toBe("0");
      expect(
        (
          await admin.query(
            "SELECT count(*)::text AS count FROM schema_migrations WHERE version='0050_song_lyrics_foundation.sql'",
          )
        ).rows[0]?.count,
      ).toBe("0");
    } finally {
      await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
      await admin.end();
    }
    completedTestCount += 1;
  }, 40_000);

  test("fails 0050 atomically over classifier-incompatible transcript rows", async () => {
    if (connectionString === undefined)
      throw new Error("Postgres test configuration is unavailable");
    const schema = schemaName();
    const admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    const connection = scopedConnection(connectionString, schema);
    try {
      const migrations = await loadPostgresMigrations();
      const lyricsIndex = migrations.findIndex(
        ({ version }) => version === "0050_song_lyrics_foundation.sql",
      );
      expect(lyricsIndex).toBeGreaterThan(0);
      await runPostgresMigrations({
        connectionString: connection,
        migrations: migrations.slice(0, lyricsIndex),
      });
      await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      await admin.query("ALTER TABLE media_transcript_artifacts DISABLE TRIGGER ALL");
      await admin.query(
        "INSERT INTO media_transcript_artifacts (transcript_artifact_ref,community_id,actor_user_id,submission_id,operation_id,audio_revision,analysis_revision,canonical_audio_sha256,transcript_sha256,transcript_text,segments,author_persona_id) VALUES ('legacy-empty-transcript','legacy-community','legacy-actor','legacy-submission','legacy-operation',1,1,$1,$2,'legacy transcript','[]'::jsonb,'legacy-persona')",
        [audioSha256, sha256(new TextEncoder().encode("legacy transcript"))],
      );
      await admin.query("ALTER TABLE media_transcript_artifacts ENABLE TRIGGER ALL");
      await expect(
        runPostgresMigrations({ connectionString: connection, migrations }),
      ).rejects.toThrow();
      expect(
        (
          await admin.query(
            "SELECT count(*)::text AS count FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='media_post_submissions' AND column_name='lyrics_revision'",
          )
        ).rows[0]?.count,
      ).toBe("0");
      expect(
        (
          await admin.query(
            "SELECT count(*)::text AS count FROM schema_migrations WHERE version='0050_song_lyrics_foundation.sql'",
          )
        ).rows[0]?.count,
      ).toBe("0");
    } finally {
      await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
      await admin.end();
    }
    completedTestCount += 1;
  }, 40_000);
});

afterAll(async () => {
  if (completedTestCount === testCount) await Bun.write(sentinelPath, sentinelContents);
});
