// Test-only native-core historical handback; no legacy API is imported or called.
// The real maintained253 migration supplies UNKNOWN identity, not writer closure.
import { expect } from "bun:test";
import { Schema } from "effect";
import type { Client } from "pg";
import {
  loadPostgresMigrations,
  runPostgresMigrations,
} from "../../../scripts/postgres-migrations.ts";
import { makeOwnedOrdinaryAccountBirthFixture } from "./ordinary-study-account-birth.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

export async function beginHistoricalAudioDeletionFixture(connectionString: string) {
  const migrations = await loadPostgresMigrations();
  const index = migrations.findIndex(
    (migration) => migration.version === "0253_learner_audio_deletion_fence.sql",
  );
  if (
    index < 1 ||
    migrations[index - 1]?.version !== "0252_guest_learning_controlled_row_admission.sql"
  )
    throw new Error("Actual maintained252/253 history boundary is required");
  const prefix = migrations.slice(0, index);
  const lastPrefixMigration = prefix.at(-1);
  if (lastPrefixMigration === undefined) throw new Error("Historical migration prefix is empty");
  const applied = await runPostgresMigrations({ connectionString, migrations: prefix });
  if (applied.dryRun) throw new Error("Historical fixture requires an actual owned database");
  expect(applied.result.currentVersion).toBe(lastPrefixMigration.version);
  const birth = makeOwnedOrdinaryAccountBirthFixture(
    makeDirectPostgresControlPlaneLayer(connectionString),
  );
  for (const accountId of ["account-1", "account-2", "account-3", "account-4", "account-5"])
    await birth(accountId);
  return { prefix, remaining: migrations.slice(index) };
}

export async function finishHistoricalAudioDeletionFixture(
  connectionString: string,
  history: Awaited<ReturnType<typeof beginHistoricalAudioDeletionFixture>>,
) {
  const applied = await runPostgresMigrations({
    connectionString,
    // The maintained engine validates every declared prefix row before applying only NEW suffix.
    migrations: [...history.prefix, ...history.remaining],
    expectedLedger: history.prefix.map(({ version, checksum }) => ({ version, checksum })),
  });
  if (applied.dryRun) throw new Error("Historical fixture migration did not execute");
  expect(applied.result.applied).toEqual(history.remaining.map(({ version }) => version));
}

const fixtureDigest = (label: string) => new Bun.CryptoHasher("sha256").update(label).digest("hex");

/**
 * Legacy Karaoke settlement evidence: the attempt host's own reset receipt, as
 * its applyReset returned it, then abort, listing and HEAD observed after it.
 * Fixture values exercise the database's validation, not platform quiescence.
 */
export function legacyKaraokeSettlementEvidence(
  objectRef: string,
  headStatus: "present" | "absent",
  options: Readonly<{
    observedMinutesAgo?: number;
    quiescenceEstablished?: boolean;
    archiveKey?: string;
  }> = {},
) {
  const hostState = {
    alarm: null,
    sockets: 0,
    scoreState: "pending",
    recordingState: "pending",
    archiveKey: options.archiveKey ?? objectRef,
    uploadId: "fixture-multipart-upload",
  };
  return {
    objectRef,
    headStatus,
    openMultipartUploads: 0,
    abortedMultipartUploadIds: ["fixture-multipart-upload"],
    servingVersions: [
      {
        script: "pirate-api-next-staging",
        versionId: "fixture-reset-version",
        sourceCommit: "a".repeat(40),
        artifactSha256: fixtureDigest("artifact"),
      },
    ],
    producerShutdown: {
      namespaceId: "fixture-karaoke-namespace",
      objectId: "f".repeat(64),
      generation: "staging-reset-v1",
      inventoryDigest: fixtureDigest("inventory"),
      state: "active",
      initial: hostState,
      current: hostState,
      cancellationSucceeded: true,
      quiescenceEstablished: options.quiescenceEstablished ?? true,
    },
    shutdownAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    observedAt: new Date(Date.now() - (options.observedMinutesAgo ?? 1) * 60_000).toISOString(),
    receipts: {
      reset: fixtureDigest("reset"),
      abort: fixtureDigest("abort"),
      listing: fixtureDigest("listing"),
      head: fixtureDigest("head"),
    },
  };
}

export function beginOwnedHistoricalApiNextWriter(retainedObjectRefs: Set<string>) {
  const identity = Object.freeze({
    accountId: "account-1",
    sessionId: "karaoke-session",
    attemptId: "karaoke-attempt",
    artifactId: "karaoke-artifact",
    objectRef: "karaoke/account-1/karaoke-attempt.pcm",
    capturedRevision: 0,
  });
  const release = Promise.withResolvers<void>();
  // This sole finite historical api-next task is owned BEFORE253. Native253
  // later retains its original(session,attempt,artifact)/revision0 as UNKNOWN.
  const writer = release.promise.then(() => {
    retainedObjectRefs.add(identity.objectRef);
    return { state: "stored", objectRef: identity.objectRef } as const;
  });
  // Attach the full-cohort drain immediately, including failure outcomes.
  const completed = Promise.allSettled([writer]);
  return {
    identity,
    hasOriginalObject: () => retainedObjectRefs.has(identity.objectRef),
    async releaseAndDrain() {
      release.resolve();
      const [result] = await completed;
      if (result.status === "rejected") throw result.reason;
      return result.value;
    },
  };
}

export async function closeOwnedHistoricalApiNextWriter(
  admin: Client,
  cohort: ReturnType<typeof beginOwnedHistoricalApiNextWriter>,
) {
  const original = await admin.query(
    `SELECT upload.upload_attempt_id,upload.object_ref
       FROM learner_audio_upload_attempts upload
       JOIN participation_owners owner ON owner.owner_id=upload.owner_id
       JOIN karaoke_recordings recording ON recording.account_id=owner.account_id
         AND recording.attempt_id=upload.attempt_ref AND recording.artifact_id=upload.artifact_id
       WHERE owner.kind='account' AND owner.account_id='account-1'
         AND recording.session_id='karaoke-session' AND recording.attempt_id='karaoke-attempt'
         AND recording.artifact_id='karaoke-artifact' AND upload.source_kind='karaoke'
         AND upload.command_ref=recording.session_id AND upload.reservation_ref=recording.session_id
         AND upload.captured_revision=0 AND upload.io_state='unknown'`,
  );
  if (original.rows.length !== 1)
    throw new Error("Exactly one genuine253 historical unknown is required");
  const row = Schema.decodeUnknownSync(
    Schema.Struct({
      upload_attempt_id: Schema.NonEmptyString,
      object_ref: Schema.Literal("karaoke/account-1/karaoke-attempt.pcm"),
    }),
    { onExcessProperty: "error" },
  )(original.rows[0]);
  // Only the SAME task cohort started before253 can establish closure.
  // A new write or key absence would not dispose of the retained unknown.
  expect(row.object_ref).toBe(cohort.identity.objectRef);
  const closed = await cohort.releaseAndDrain();
  expect(closed).toEqual({ state: "stored", objectRef: row.object_ref });
  // Assert existence only at the original handback, before exact deletion.
  expect(cohort.hasOriginalObject()).toBe(true);
  // The bare shared closure cannot close an imported legacy producer.
  await expect(
    admin.query("SELECT settle_learner_audio_upload_private_v1($1,'stored',TRUE,NULL)", [
      row.upload_attempt_id,
    ]),
  ).rejects.toThrow("imported legacy producer requires recorded settlement evidence");
  // Installation-owner settlement with the drained host's evidence, no runtime
  // grant. A post-fence writer closes honestly while original publication
  // remains permanently suppressed.
  const fact = await admin.query(
    "SELECT settle_legacy_learner_audio_upload_private_v1($1,'stored',$2::jsonb) AS publish",
    [
      row.upload_attempt_id,
      JSON.stringify(legacyKaraokeSettlementEvidence(row.object_ref, "present")),
    ],
  );
  expect(fact.rows).toEqual([{ publish: false }]);
  expect(
    (
      await admin.query(
        "SELECT io_state,storage_disposition,cleanup_required FROM learner_audio_upload_attempts WHERE upload_attempt_id=$1",
        [row.upload_attempt_id],
      )
    ).rows,
  ).toEqual([{ io_state: "closed", storage_disposition: "stored", cleanup_required: true }]);
}
