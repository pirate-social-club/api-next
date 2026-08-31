import { describe, expect, test } from "bun:test";
import {
  deterministicDataRegistrationArtifactId,
  deterministicDataRegistrationAttemptId,
  deterministicDataRegistrationOperationId,
  deterministicDataRegistrationOutboxId,
  deterministicDataRegistrationReceiptId,
  deterministicDataRegistrationSigningIntentId,
  deterministicDataRegistrationWorkflowId,
} from "@pirate/application/data/registration-persistence";
import { Effect } from "effect";
import { Client } from "pg";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { makeDataRegistrationStore } from "./data-registration-repository.ts";
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

async function seedPublishedSong(admin: Client): Promise<{
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
  await admin.query(
    "INSERT INTO community_memberships (community_id,membership_id,user_id,status,joined_at,created_at,updated_at) VALUES ($1,$2,$3,'member',clock_timestamp(),clock_timestamp(),clock_timestamp())",
    [communityId, "membership-data-registration", accountId],
  );
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

suite("DATA registration persistence", () => {
  test("upgrades a populated pre-DATA foundation without changing the published song", async () => {
    const dataPersistenceIndex = migrations.findIndex(
      (migration) => migration.version === "0057_data_registration_persistence.sql",
    );
    if (dataPersistenceIndex < 1) throw new Error("0057 must follow the pre-DATA foundation");
    const beforeDataPersistence = migrations.slice(0, dataPersistenceIndex);
    await withSchema(async (admin, scopedConnection) => {
      const media = await seedPublishedSong(admin);
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
  });

  test("fences pins, attempts, nonces, receipts, replays, reorgs, and Workflow replacement", async () => {
    await withSchema(async (admin, scopedConnection) => {
      const media = await seedPublishedSong(admin);
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
          ["independent_gateway", "ipfs.io"],
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
      expect((await store.confirmRegistration(confirmedReceipt)).state).toBe("registered");
      expect((await store.confirmRegistration(confirmedReceipt)).state).toBe("registered");
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

      const recoveredReceipt = {
        ...confirmedReceipt,
        receiptObservationId: deterministicDataRegistrationReceiptId(secondAttemptId, 4n),
        observationSequence: 4n,
        evidenceRef: "evidence://receipt/recovered",
        observedAt: "2026-08-26T12:04:00.000Z",
      };
      expect((await store.confirmRegistration(recoveredReceipt)).state).toBe("registered");

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
  });
});
