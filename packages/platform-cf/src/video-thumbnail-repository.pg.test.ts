import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { Client } from "pg";
import {
  applyPostgresTestBaselineConnection,
  withReusablePostgresTestSchema,
} from "../../../scripts/postgres-test-baseline.ts";
import { consumeVideoThumbnail } from "../../application/src/video/thumbnail-enrichment.ts";
import {
  attachVideoDecision,
  decideOriginalAudioVideo,
  publishOriginalVideo,
} from "../../domain/src/video-submission.ts";
import { makeVideoPosterAuthority } from "./video-poster-authority.ts";
import {
  finalizedFixture,
  operationId,
  seedVideoActors,
  trustedAnalysis,
} from "./video-publication.pg-fixture.ts";
import { makeVideoThumbnailStore } from "./video-thumbnail-repository.ts";
import { makeVideoThumbnailVerifier } from "./video-thumbnail-verifier.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && connectionString === undefined)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = connectionString === undefined ? describe.skip : describe;
const effectIdentity = `video-enrichment:${operationId}:thumbnail`;

async function published(connection: string) {
  const { layer, store, finalized } = await finalizedFixture(connection);
  const analysis = trustedAnalysis();
  const frames = analysis.frames.extracted.map((frame) => ({
    ...frame,
    artifactRef: `media://derived/video-analysis/${operationId}/v1/c1/a1/${frame.role}.jpg`,
  }));
  const [poster, first, midpoint] = frames;
  if (!poster || !first || !midpoint) throw new Error("fixture frames missing");
  const trusted = {
    ...analysis,
    frames: { ...analysis.frames, extracted: [poster, first, midpoint] as const },
  };
  const decision = decideOriginalAudioVideo({
    state: finalized.state,
    analysis: trusted,
    canonicalCaptionSha256: null,
    decidedAt: "2026-09-06T00:00:00.000Z",
  });
  const ready = await store.commitAnalysisDecision({
    submission: finalized.state,
    analysis: trusted,
    decision,
    nextState: attachVideoDecision(finalized.state, trusted, decision),
  });
  const publication = publishOriginalVideo(ready.state, "post-video-thumbnail");
  await store.publish({
    state: publication.state,
    decision,
    originalSound: publication.originalSound,
    poster: { artifactRef: poster.artifactRef, canonicalSha256: poster.sha256 },
    derivedArtifacts: frames.map((frame) => ({
      artifactRef: frame.artifactRef,
      artifactKind: frame.role,
      canonicalSha256: frame.sha256,
    })),
  });
  return { layer, store: makeVideoThumbnailStore(layer, { leaseMs: 60_000 }) };
}

async function fixture(
  use: (input: Awaited<ReturnType<typeof published>>, admin: Client) => Promise<void>,
) {
  if (!connectionString) throw new Error("Postgres configuration missing");
  await withReusablePostgresTestSchema({
    baseConnectionString: connectionString,
    schemaName: "packages_platform_cf_src_video_thumbnail_repository_pg_test_ts",
    use: async ({ admin, schema }) => {
      const connection = `${connectionString}${connectionString.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
      await admin.query(`SET search_path TO "${schema.replaceAll('"', '""')}"`);
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      await seedVideoActors(admin);
      await use(await published(connection), admin);
    },
  });
}
const expire = (admin: Client) =>
  admin.query(
    "UPDATE media_video_enrichment_outbox SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE effect_identity=$1",
    [effectIdentity],
  );

suite("video thumbnail durable PostgreSQL", () => {
  test("one live claim, same-worker reacquisition fences stale and forged completion", async () => {
    await fixture(async ({ store }, admin) => {
      const claims = await Promise.all([store.claim(effectIdentity), store.claim(effectIdentity)]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      const first = claims.find((claim) => claim !== null);
      if (!first) throw new Error("claim missing");
      await expire(admin);
      expect(await store.complete(first, "ready")).toBe(false);
      const next = await store.claim(effectIdentity);
      if (!next) throw new Error("reclaim missing");
      expect(next.leaseToken).not.toBe(first.leaseToken);
      expect(await store.complete(first, "ready")).toBe(false);
      expect(await store.complete({ ...next, sha256: "f".repeat(64) }, "ready")).toBe(false);
      expect(await store.complete({ ...next, communityId: "foreign" }, "ready")).toBe(false);
      expect(await store.complete(next, "ready")).toBe(true);
      expect(await store.complete(next, "failed")).toBe(false);
      expect(await store.claim(effectIdentity)).toBeNull();
    });
  });
  test("exact sealed poster observation and lost completion replay leave one ready outbox", async () => {
    await fixture(async ({ layer, store }, admin) => {
      await admin.query(
        "UPDATE media_video_enrichment_outbox SET payload=$2::jsonb WHERE effect_identity=$1",
        [effectIdentity, JSON.stringify({ poster_ref: "https://attacker.invalid/poster.jpg" })],
      );
      let reads = 0;
      const resolveArtifact = makeVideoPosterAuthority(layer);
      const verify = makeVideoThumbnailVerifier({
        resolveArtifact,
        bucket: {
          head: async (key) => {
            reads++;
            expect(key).toBe(`video-analysis/${operationId}/v1/c1/a1/poster.jpg`);
            return {
              key,
              size: 100,
              httpMetadata: { contentType: "image/jpeg" },
              customMetadata: {
                sha256: "1".repeat(64),
                sourceSha256: "a".repeat(64),
                policyRevision: "1",
              },
            };
          },
        },
      });
      await expect(
        consumeVideoThumbnail(effectIdentity, {
          verify,
          store: {
            ...store,
            complete: async (...args) => {
              await store.complete(...args);
              throw new Error("completion response lost");
            },
          },
        }),
      ).rejects.toThrow("completion response lost");
      expect(await consumeVideoThumbnail(effectIdentity, { store, verify })).toBe("unclaimed");
      expect(reads).toBe(1);
      expect(
        (
          await admin.query(
            "SELECT state,lease_owner,lease_expires_at FROM media_video_enrichment_outbox WHERE effect_identity=$1",
            [effectIdentity],
          )
        ).rows[0],
      ).toEqual({ state: "ready", lease_owner: null, lease_expires_at: null });
      expect(
        (
          await admin.query(
            "SELECT state,claim_fence::text FROM media_video_stream_ingests WHERE operation_id=$1",
            [operationId],
          )
        ).rows[0],
      ).toEqual({ state: "not_started", claim_fence: "0" });
    });
  });
  test("storage outage retains recovery lease; missing poster stops without undoing publication", async () => {
    await fixture(async ({ layer, store }, admin) => {
      const resolveArtifact = makeVideoPosterAuthority(layer);
      const unavailable = makeVideoThumbnailVerifier({
        resolveArtifact,
        bucket: {
          head: async () => {
            throw new Error("storage unavailable");
          },
        },
      });
      expect(await consumeVideoThumbnail(effectIdentity, { store, verify: unavailable })).toBe(
        "retry",
      );
      expect(await store.claim(effectIdentity)).toBeNull();
      await expire(admin);
      const missing = makeVideoThumbnailVerifier({
        resolveArtifact,
        bucket: { head: async () => null },
      });
      expect(await consumeVideoThumbnail(effectIdentity, { store, verify: missing })).toBe(
        "failed",
      );
      expect(await store.claim(effectIdentity)).toBeNull();
      expect(
        (await admin.query("SELECT status FROM posts WHERE post_id='post-video-thumbnail'")).rows[0]
          .status,
      ).toBe("published");
      // Serving still resolves the original authoritative identity; failure never
      // replaces it with an error URL or creates another artifact/publication.
      const row = (
        await admin.query(
          "SELECT post_id,community_id,poster_artifact_ref FROM media_publication_projections WHERE operation_id=$1",
          [operationId],
        )
      ).rows[0];
      expect(
        await Effect.runPromise(
          resolveArtifact({
            postId: row.post_id,
            communityId: row.community_id,
            artifactRef: row.poster_artifact_ref,
          }),
        ),
      ).not.toBeNull();
    });
  });
});
