import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";
import {
  applyPostgresTestBaselineConnection,
  withReusablePostgresTestSchema,
} from "../../../scripts/postgres-test-baseline.ts";
import { claimVideoOutcome } from "../../application/src/use-cases/video-outcomes.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlaneVideoOutcomeStore } from "./video-outcome-repository.ts";
import {
  actor,
  community,
  finalizedFixture,
  persona,
  seedPublishedSongFixture,
  seedSongOwner,
  seedVideoActors,
  songReferenceFinalizedFixture,
  videoSha256,
} from "./video-publication.pg-fixture.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && connectionString === undefined)
  throw new Error("Postgres test URL required");
const suite = connectionString === undefined ? describe.skip : describe;

async function fixture(use: (admin: Client, connection: string) => Promise<void>) {
  if (connectionString === undefined) throw new Error("Postgres test URL required");
  await withReusablePostgresTestSchema({
    baseConnectionString: connectionString,
    schemaName: "video_outcome_repository",
    use: async ({ admin, schema }) => {
      const url = new URL(connectionString);
      url.searchParams.set("options", `-c search_path=${schema}`);
      await applyPostgresTestBaselineConnection({ connectionString: url.toString() });
      await seedVideoActors(admin);
      await use(admin, url.toString());
    },
  });
}

async function terminal(
  admin: Client,
  connection: string,
  label: string,
  status = "processing_failed",
  overrides: { retryable?: boolean; uncertain?: boolean; sealed?: boolean } = {},
) {
  const identity = {
    reservationId: `reservation-${label}`,
    submissionId: `submission-${label}`,
    operationId: `operation-${label}`,
  };
  await finalizedFixture(connection, null, identity);
  if (status === "published") {
    await admin.query("ALTER TABLE posts DISABLE TRIGGER USER");
    try {
      await admin.query(
        `INSERT INTO posts (
        community_id,post_id,author_user_id,author_persona_id,post_type,status,visibility,
        author_declared_rating,content_rating,created_at,updated_at
      ) VALUES ($1,'post-published',$2,$3,'video','published','public','general','general',clock_timestamp(),clock_timestamp())`,
        [community, actor, persona],
      );
    } finally {
      await admin.query("ALTER TABLE posts ENABLE TRIGGER USER");
    }
  }
  // Install selected historical terminal states while keeping CHECK/FK/index
  // enforcement enabled. The outcome claim trigger itself is never disabled.
  await admin.query("ALTER TABLE media_post_submissions DISABLE TRIGGER USER");
  try {
    await admin.query(
      `UPDATE media_post_submissions SET status=$2,phase=NULL,
      failure_code=CASE WHEN $2='processing_failed' THEN 'transform_failed' ELSE NULL END,
      failure_retry_count=CASE WHEN $2='processing_failed' THEN 3 ELSE NULL END,
      retryable=CASE WHEN $2='processing_failed' THEN $3::boolean ELSE NULL END,
      last_safe_phase=CASE WHEN $2='processing_failed' THEN 'analysis' ELSE NULL END,
      post_id=CASE WHEN $2='published' THEN 'post-published' ELSE NULL END,
      video_revision=CASE WHEN $5 THEN video_revision ELSE 0 END,
      current_immutable_ref=CASE WHEN $5 THEN current_immutable_ref ELSE NULL END,
      video_state_snapshot=jsonb_set(jsonb_set(video_state_snapshot,'{status}',to_jsonb($2::text)),
        '{reconciliationRequired}',to_jsonb($4::boolean))
      WHERE submission_id=$1`,
      [
        identity.submissionId,
        status,
        overrides.retryable ?? false,
        overrides.uncertain ?? false,
        overrides.sealed ?? true,
      ],
    );
  } finally {
    await admin.query("ALTER TABLE media_post_submissions ENABLE TRIGGER USER");
  }
  return identity.submissionId;
}

const store = (connection: string) =>
  makeControlPlaneVideoOutcomeStore(makeDirectPostgresControlPlaneLayer(connection));
const claim = (connection: string, account = actor) =>
  Effect.runPromise(claimVideoOutcome(account, store(connection)));

suite("permanent author video outcome claims on PostgreSQL", () => {
  test("twelve simultaneous devices get exactly one winner and all repeats lose", async () => {
    await fixture(async (admin, connection) => {
      const id = await terminal(admin, connection, "race");
      const responses = await Promise.all(Array.from({ length: 12 }, () => claim(connection)));
      expect(responses.filter((r) => r.display_permission)).toEqual([
        {
          object: "video_outcome_claim",
          display_permission: true,
          outcome: { submission_id: id, kind: "processing_failure", song: null },
        },
      ]);
      expect(responses.filter((r) => !r.display_permission)).toHaveLength(11);
      expect((await claim(connection)).display_permission).toBe(false);
      expect(
        (await admin.query("SELECT count(*)::int AS count FROM media_video_outcome_claims")).rows[0]
          ?.count,
      ).toBe(1);
    });
  }, 30_000);

  test("another author cannot claim or inject a claim; policy copy reveals no signals", async () => {
    await fixture(async (admin, connection) => {
      const id = await terminal(admin, connection, "block", "blocked");
      await admin.query("INSERT INTO users(user_id) VALUES('other-account')");
      expect((await claim(connection, "other-account")).display_permission).toBe(false);
      await expect(
        admin.query(
          "INSERT INTO media_video_outcome_claims(submission_id,actor_user_id,kind) VALUES($1,'other-account','policy_block')",
          [id],
        ),
      ).rejects.toThrow("exact sealed terminal author authority");
      expect(await claim(connection)).toEqual({
        object: "video_outcome_claim",
        display_permission: true,
        outcome: { submission_id: id, kind: "policy_block", song: null },
      });
      await expect(
        admin.query("UPDATE media_video_outcome_claims SET claimed_at=clock_timestamp()"),
      ).rejects.toThrow("permanent");
      await expect(admin.query("DELETE FROM media_video_outcome_claims")).rejects.toThrow(
        "permanent",
      );
    });
  }, 30_000);

  test("discarded successful response and crash before display cannot be recovered by another client", async () => {
    await fixture(async (admin, connection) => {
      await terminal(admin, connection, "lost-response");
      await claim(connection); // Deliberately discard the only winner response.
      expect(await claim(connection)).toEqual({
        object: "video_outcome_claim",
        display_permission: false,
        outcome: null,
      });
      expect(await claim(connection)).toEqual({
        object: "video_outcome_claim",
        display_permission: false,
        outcome: null,
      });
    });
  }, 30_000);

  test("a lost COMMIT acknowledgment returns no permission and never redelivers the durable claim", async () => {
    await fixture(async (admin, connection) => {
      await terminal(admin, connection, "commit-ack");
      const layer = makeDirectPostgresControlPlaneLayer(connection, {
        clientFactory: async (_url, config) => {
          const client = new Client(config);
          return {
            connect: () => client.connect(),
            end: () => client.end(),
            query: async ({ text, values }) => {
              const result = await client.query({ text, values: [...(values ?? [])] });
              if (text === "COMMIT") throw new Error("lost commit acknowledgment");
              return result;
            },
          };
        },
      });
      await expect(
        Effect.runPromise(claimVideoOutcome(actor, makeControlPlaneVideoOutcomeStore(layer))),
      ).rejects.toThrow("Video outcome claim unavailable");
      expect((await claim(connection)).display_permission).toBe(false);
      expect(
        (await admin.query("SELECT count(*)::int AS count FROM media_video_outcome_claims")).rows[0]
          ?.count,
      ).toBe(1);
    });
  }, 30_000);

  test("published, unsealed, retryable and uncertain failures never grant a notice", async () => {
    await fixture(async (admin, connection) => {
      await terminal(admin, connection, "published", "published");
      await terminal(admin, connection, "unsealed", "processing_failed", { sealed: false });
      await terminal(admin, connection, "retryable", "processing_failed", { retryable: true });
      await terminal(admin, connection, "uncertain", "processing_failed", { uncertain: true });
      expect((await claim(connection)).display_permission).toBe(false);
      expect(
        (await admin.query("SELECT count(*)::int AS count FROM media_video_outcome_claims")).rows[0]
          ?.count,
      ).toBe(0);
    });
  }, 30_000);

  test("song-reference failure carries only the frozen song identity and claims one per request", async () => {
    await fixture(async (admin, connection) => {
      await seedSongOwner(admin);
      const song = {
        songPostId: "song-outcome",
        communityId: community,
        audioAssetRef: "media://song/outcome",
        canonicalAudioSha256: "b".repeat(64),
        durationSamples: 720_000,
        title: "Outcome song",
        contentRating: "general" as const,
        derivativeVideo: "allowed" as const,
        licensePreset: "commercial-remix" as const,
        commercialRemixShareBps: 1_000,
      };
      await seedPublishedSongFixture(admin, song);
      const { store: submissions, finalized } = await songReferenceFinalizedFixture(connection, {
        identity: {
          reservationId: "reservation-song-outcome",
          submissionId: "submission-song-outcome",
          operationId: "operation-song-outcome",
        },
        planId: "plan-song-outcome",
        song,
        clipStartSamples: 0,
        clipDurationSamples: 720_000,
        source: { sha256: videoSha256, sizeBytes: 1_024 },
      });
      await submissions.recordProcessingFailure({
        submission: finalized.state,
        observedEventSequence: finalized.eventSequence,
        failureCode: "safety_gate_unresolved",
        evidenceRef: "safety:unresolved",
      });
      await terminal(admin, connection, "second");
      const first = await claim(connection);
      const second = await claim(connection);
      expect(first.display_permission && first.outcome).toEqual({
        submission_id: "submission-song-outcome",
        kind: "processing_failure",
        song: { community_id: community, post_id: song.songPostId },
      });
      expect(second.display_permission).toBe(true);
      expect((await claim(connection)).display_permission).toBe(false);
    });
  }, 30_000);
});
