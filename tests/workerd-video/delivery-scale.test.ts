import { env } from "cloudflare:test";
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { Client } from "pg";
import { expect, test } from "vitest";
import { makeVideoPosterHandler } from "../../apps/http-worker/src/video-poster-handler.ts";
import { acceptTrustedVideoAnalysis } from "../../packages/application/src/video/publication.ts";
import { makeControlPlaneContentStore } from "../../packages/platform-cf/src/content-repository.ts";
import { makeControlPlaneFeedStore } from "../../packages/platform-cf/src/feed-repository.ts";
import {
  makeDirectPostgresControlPlaneLayer,
  type PostgresClientFactory,
} from "../../packages/platform-cf/src/postgres.ts";
import { makeVideoPublicationAuthorization } from "../../packages/platform-cf/src/video-access-authorization.ts";
import { makeVideoPosterAuthority } from "../../packages/platform-cf/src/video-poster-authority.ts";
import {
  actor,
  community,
  finalizedFixture,
  persona,
  seedVideoActors,
  trustedAnalysis,
  videoSha256,
} from "../../packages/platform-cf/src/video-publication.pg-fixture.ts";

const bindings = env as { VIDEO_TEST_DATABASE: string; VIDEO_TEST_RESET: string };
// Transport-size fixture only: this does not prove JPEG decoding or provider output quality.
const posterBytes = new Uint8Array(65_536);
posterBytes.set([255, 216, 255, 217]);
const posterSha = createHash("sha256").update(posterBytes).digest("hex");

for (const { videoItems, member } of [1, 10, 20].flatMap((videoItems) =>
  [false, true].map((member) => ({ videoItems, member })),
)) {
  test(`delivery scale fixture: ${videoItems} video posters and one text item (${member ? "member" : "public"})`, async () => {
    const admin = new Client({ connectionString: bindings.VIDEO_TEST_DATABASE });
    await admin.connect();
    await admin.query("SET search_path TO api_next,pg_catalog");
    try {
      await admin.query(bindings.VIDEO_TEST_RESET);
      await seedVideoActors(admin);
      const url = new URL(bindings.VIDEO_TEST_DATABASE);
      url.searchParams.set("options", "-c search_path=api_next,pg_catalog");
      const connection = url.toString();
      const posts: string[] = [];
      const objects = new Set<string>();
      for (let i = 0; i < videoItems; i++) {
        const operationId = `media-operation-scale-${i}`;
        const submissionId = `media-submission-scale-${i}`;
        const postId = `post-scale-${i}`;
        const f = await finalizedFixture(connection, null, {
          operationId,
          submissionId,
          reservationId: `media-reservation-scale-${i}`,
        });
        const base = trustedAnalysis();
        const sealedFrame = (frame: (typeof base.frames.extracted)[number]) => ({
          ...frame,
          sha256: posterSha,
          artifactRef: `media://derived/video-analysis/${operationId}/v1/c1/a1/${frame.role}.jpg`,
        });
        const analysis = {
          ...base,
          operationId,
          safetyRequest: { ...base.safetyRequest, frameSha256s: [posterSha, posterSha, posterSha] },
          finalizedVideoRef: f.finalized.state.video?.immutableRef ?? "",
          audio: {
            ...base.audio,
            soundtrack: {
              ...base.audio.soundtrack,
              extractedAudioRef: `media://derived/video-analysis/${operationId}/audio`,
            },
          },
          frames: {
            ...base.frames,
            extracted: [
              sealedFrame(base.frames.extracted[0]),
              sealedFrame(base.frames.extracted[1]),
              sealedFrame(base.frames.extracted[2]),
            ] as const,
          },
        };
        await acceptTrustedVideoAnalysis(
          { submissionId, analysis },
          {
            store: f.store,
            nowIso: () => new Date().toISOString(),
            randomUuid: () => `scale-${i}`,
          },
        );
        // Fixture setup, excluded from measurements. Consumer correctness is covered
        // by the separate composed drill; never infer live readiness from this setup.
        await admin.query(
          "UPDATE media_video_enrichment_outbox SET state='ready' WHERE operation_id=$1",
          [operationId],
        );
        await admin.query(
          "UPDATE media_video_stream_ingests SET state='ready',creator_marker=$2,source_sha256=$3,provider_video_id=$4,acceptance_deadline_ms=1000,encoding_deadline_ms=2000 WHERE operation_id=$1",
          [operationId, "a".repeat(64), videoSha256, (i + 1).toString(16).padStart(32, "0")],
        );
        await admin.query(
          // Distinct ranks isolate join cost from the existing second-precision
          // cursor's same-rank subsecond pagination loss (not a delivery change).
          "INSERT INTO home_feed_projection (community_id,feed_item_id,post_id,rank_score,projected_at) VALUES ($1,$2,$3,$4,clock_timestamp())",
          [community, `feed-scale-${i}`, postId, i + 10],
        );
        posts.push(postId);
        objects.add(`video-analysis/${operationId}/v1/c1/a1/poster.jpg`);
      }
      await admin.query(
        "INSERT INTO posts (community_id,post_id,author_user_id,author_persona_id,post_type,status,visibility,body,created_at,updated_at,author_declared_rating,content_rating) VALUES ($1,'post-scale-text',$2,$3,'text','published','public','Mixed fixture',clock_timestamp(),clock_timestamp(),'general','general')",
        [community, actor, persona],
      );
      await admin.query(
        "INSERT INTO home_feed_projection (community_id,feed_item_id,post_id,rank_score,projected_at) VALUES ($1,'feed-scale-text','post-scale-text',2,clock_timestamp())",
        [community],
      );
      if (member)
        await admin.query("UPDATE posts SET visibility='members_only' WHERE community_id=$1", [
          community,
        ]);
      let connections = 0;
      let statements = 0;
      let databaseMs = 0;
      let authorizations = 0;
      let r2Reads = 0;
      let storageBytes = 0;
      const clientFactory: PostgresClientFactory = (_connection, config) => {
        const client = new Client(config);
        connections++;
        return {
          connect: () => client.connect(),
          query: async ({ text, values }) => {
            statements++;
            const started = performance.now();
            try {
              return await client.query({ text, values: values === undefined ? [] : [...values] });
            } finally {
              databaseMs += performance.now() - started;
            }
          },
          end: () => client.end(),
        };
      };
      const layer = makeDirectPostgresControlPlaneLayer(connection, { clientFactory });
      const contentStore = makeControlPlaneContentStore(layer);
      const authorize = makeVideoPublicationAuthorization(layer);
      const handler = makeVideoPosterHandler({
        contentStore,
        authorizePublication: (input) => {
          authorizations++;
          return authorize(input);
        },
        resolveArtifact: makeVideoPosterAuthority(layer),
        bucket: {
          get: async (key) => {
            r2Reads++;
            if (!objects.has(key)) return null;
            let offset = 0;
            return {
              key,
              size: posterBytes.byteLength,
              httpEtag: `"${posterSha}"`,
              httpMetadata: { contentType: "image/jpeg" },
              customMetadata: { sha256: posterSha, sourceSha256: videoSha256, policyRevision: "1" },
              body: new ReadableStream<Uint8Array>(
                {
                  pull(controller) {
                    if (offset === posterBytes.byteLength) {
                      controller.close();
                      return;
                    }
                    const chunk = posterBytes.subarray(offset, offset + 16_384);
                    offset += chunk.byteLength;
                    storageBytes += chunk.byteLength;
                    controller.enqueue(chunk);
                  },
                },
                { highWaterMark: 0 },
              ),
            };
          },
        },
      });
      const feed = makeControlPlaneFeedStore(layer);
      let cursor: string | undefined;
      let feedItems = 0;
      const feedStart = performance.now();
      do {
        const page = await Effect.runPromise(
          feed.listHome({
            query: cursor === undefined ? {} : { cursor },
            ...(member ? { viewerUserId: actor } : {}),
          }),
        );
        feedItems += page.items.length;
        cursor = page.next_cursor ?? undefined;
      } while (cursor !== undefined);
      expect(feedItems).toBe(videoItems + 1);
      const feedMeasurement = {
        items: feedItems,
        connections,
        statements,
        databaseMs,
        elapsedMs: performance.now() - feedStart,
      };
      const results = [];
      for (const conditional of [false, true]) {
        connections = 0;
        statements = 0;
        databaseMs = 0;
        authorizations = 0;
        r2Reads = 0;
        storageBytes = 0;
        const elapsed: number[] = [];
        let responseBytes = 0;
        const start = performance.now();
        for (const postId of posts) {
          const requestStart = performance.now();
          const result = await handler({
            body: undefined,
            query: {},
            params: { postId },
            principal: member ? { kind: "user", subject: actor } : null,
            headers: conditional ? { "if-none-match": `"${posterSha}"` } : {},
          });
          expect(result.status).toBe(conditional ? 304 : 200);
          expect(new Headers(result.responseHeaders).get("cache-control")).toBe(
            "private, no-cache",
          );
          if (conditional) expect(result.body).toBeNull();
          else {
            expect(result.body).toBeInstanceOf(ReadableStream);
            responseBytes += (await new Response(result.body as ReadableStream).arrayBuffer())
              .byteLength;
          }
          elapsed.push(performance.now() - requestStart);
        }
        expect(authorizations).toBe(videoItems);
        expect(r2Reads).toBe(videoItems);
        expect(responseBytes).toBe(conditional ? 0 : videoItems * posterBytes.byteLength);
        expect(storageBytes).toBe(responseBytes);
        elapsed.sort((a, b) => a - b);
        results.push({
          status: conditional ? 304 : 200,
          authorizations,
          connections,
          statements,
          r2Reads,
          storageBytes,
          responseBytes,
          databaseMs,
          elapsedMs: performance.now() - start,
          p50Ms: elapsed[Math.ceil(elapsed.length * 0.5) - 1],
          p95Ms: elapsed[Math.ceil(elapsed.length * 0.95) - 1],
        });
      }
      console.info(
        "delivery-scale",
        JSON.stringify({
          videoItems,
          viewer: member ? "member" : "anonymous-public",
          fixtureBytes: posterBytes.byteLength,
          environment:
            "local Workerd + PostgreSQL 17; synthetic R2; serial requests; no network latency simulation",
          feed: feedMeasurement,
          posters: results,
        }),
      );
    } finally {
      await admin.end();
    }
  });
}
