import { describe, expect, test } from "bun:test";
import type { Client } from "pg";
import {
  applyPostgresTestBaselineConnection,
  withReusablePostgresTestSchema,
} from "../../../scripts/postgres-test-baseline.ts";
import {
  attachVideoDecision,
  decideOriginalAudioVideo,
  publishOriginalVideo,
} from "../../domain/src/video-submission.ts";
import { makeControlPlaneTelegramStore } from "./telegram-store.ts";
import {
  community,
  finalizedFixture,
  operationId,
  seedVideoActors,
  trustedAnalysis,
  videoSha256,
} from "./video-publication.pg-fixture.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && connectionString === undefined)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = connectionString === undefined ? describe.skip : describe;

async function published(connection: string) {
  const { layer, store, finalized } = await finalizedFixture(connection);
  const analysis = trustedAnalysis();
  const decision = decideOriginalAudioVideo({
    state: finalized.state,
    analysis,
    canonicalCaptionSha256: null,
    decidedAt: "2026-09-06T00:00:00.000Z",
  });
  const ready = await store.commitAnalysisDecision({
    submission: finalized.state,
    analysis,
    decision,
    nextState: attachVideoDecision(finalized.state, analysis, decision),
  });
  const publication = publishOriginalVideo(ready.state, "post-video-ingest");
  await store.publish({
    observedEventSequence: ready.eventSequence,
    state: publication.state,
    decision,
    originalSound: publication.originalSound,
    poster: {
      artifactRef: analysis.frames.extracted[0].artifactRef,
      canonicalSha256: analysis.frames.extracted[0].sha256,
    },
    derivedArtifacts: analysis.frames.extracted.map((frame) => ({
      artifactRef: frame.artifactRef,
      artifactKind: frame.role,
      canonicalSha256: frame.sha256,
    })),
  });
  return { layer };
}

async function fixture(
  use: (store: ReturnType<typeof makeControlPlaneTelegramStore>, admin: Client) => Promise<void>,
) {
  if (!connectionString) throw new Error("Postgres configuration missing");
  await withReusablePostgresTestSchema({
    baseConnectionString: connectionString,
    schemaName: "packages_platform_cf_src_video_post_source_authority_pg_test_ts",
    use: async ({ admin, schema }) => {
      const connection = `${connectionString}${connectionString.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
      await admin.query(`SET search_path TO "${schema.replaceAll('"', '""')}"`);
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      await seedVideoActors(admin);
      const { layer } = await published(connection);
      const store = makeControlPlaneTelegramStore(layer, "https://pirate.example.invalid");
      await use(store, admin);
    },
  });
}

suite("Telegram video source authority", () => {
  test("resolves the accepted original sealed revision", () =>
    fixture(async (store) => {
      expect(
        await store.publicationVideo({ id: "post-video-ingest", communityId: community }),
      ).toEqual({
        physicalKey: `immutable/${operationId}/video/1`,
        canonicalSha256: videoSha256,
        rights: "original",
      });
    }));

  test("denies a members-only post so no source is exported", () =>
    fixture(async (store, admin) => {
      await admin.query(
        "UPDATE posts SET visibility='members_only' WHERE post_id='post-video-ingest'",
      );
      expect(
        await store.publicationVideo({ id: "post-video-ingest", communityId: community }),
      ).toBeNull();
    }));

  test("rejects a stale projection whose revision hash no longer matches", () =>
    fixture(async (store, admin) => {
      await admin.query(
        `UPDATE media_publication_projections SET canonical_video_sha256='${"f".repeat(64)}' WHERE post_id='post-video-ingest'`,
      );
      expect(
        await store.publicationVideo({ id: "post-video-ingest", communityId: community }),
      ).toBeNull();
    }));
});
