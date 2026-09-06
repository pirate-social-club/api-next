import { Effect } from "effect";
import type { Client } from "pg";
import { expect, vi } from "vitest";
import {
  type MediaProcessorRuntimeEnv,
  makeMediaProcessorComposition,
} from "../../apps/media-processor-worker/src/composition.ts";
import { VideoAnalysisWorkflow } from "../../apps/media-processor-worker/src/entrypoint.ts";
import { makeMediaProcessorQueueWorker } from "../../apps/media-processor-worker/src/index.ts";
import type { VideoAnalysisWorkflowStep } from "../../apps/media-processor-worker/src/video-workflow.ts";
import { dispatchVideoEnrichment } from "../../packages/application/src/video/enrichment-dispatch.ts";
import { makeControlPlaneContentStore } from "../../packages/platform-cf/src/content-repository.ts";
import { makeVideoEnrichmentDispatchSource } from "../../packages/platform-cf/src/video-enrichment-dispatch-source.ts";
import {
  community,
  type finalizedFixture,
  operationId,
} from "../../packages/platform-cf/src/video-publication.pg-fixture.ts";

/** Real production composition, queue handler, exported class, repositories and transport.
 * Provider HTTP and the Workflow scheduler are deterministic substitutes, not live acceptance.
 */
export async function exerciseComposedEnrichment(input: {
  admin: Client;
  layer: Awaited<ReturnType<typeof finalizedFixture>>["layer"];
  runtimeEnv: MediaProcessorRuntimeEnv;
  instances: Map<string, { effectIdentity: string; status: string }>;
}) {
  const { admin, layer, instances } = input;
  const runtimeEnv: MediaProcessorRuntimeEnv = {
    ...input.runtimeEnv,
    MEDIA_PROCESSING_ENABLED: "true",
    VIDEO_DELIVERY_ENABLED: "true",
    VIDEO_STREAM_API_TOKEN: "fixture-stream",
    IMAGE_TRANSFORMATIONS: {} as ImagesBinding,
    ACRCLOUD_IDENTIFY_HOST: "identify-eu-west-1.acrcloud.com",
    ACRCLOUD_ACCESS_KEY: "fixture-acr",
    ACRCLOUD_ACCESS_SECRET: "fixture-acr-secret",
    ELEVENLABS_API_KEY: "fixture-eleven",
    OPENROUTER_API_KEY: "fixture-openrouter",
  };
  const queue = makeMediaProcessorQueueWorker(makeMediaProcessorComposition);
  const source = makeVideoEnrichmentDispatchSource(layer);
  const dispatch = () =>
    dispatchVideoEnrichment(source, {
      send: async (body) => {
        let ack = false;
        await queue.queue(
          {
            messages: [
              {
                body,
                ack: () => {
                  ack = true;
                },
                retry: () => {
                  throw new Error("unexpected enrichment retry");
                },
              },
            ],
          } as never,
          runtimeEnv,
        );
        expect(ack).toBe(true);
      },
    });
  let copies = 0;
  let observations = 0;
  const fetchErrors: string[] = [];
  let accepted:
    | { creator: string; meta: { source_sha256: string; operation_id: string } }
    | undefined;
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    try {
      const request =
        typeof url === "string" || url instanceof URL
          ? new Request(String(url), init)
          : new Request(url, init);
      const path = new URL(request.url);
      expect(path.origin).toBe("https://api.cloudflare.com");
      expect(request.headers.get("authorization")).toBe("Bearer fixture-stream");
      if (path.pathname.endsWith("/copy")) {
        copies++;
        const body = (await request.json()) as {
          input: string;
          creator: string;
          meta: { source_sha256: string; operation_id: string };
          requireSignedURLs: boolean;
        };
        expect(body.requireSignedURLs).toBe(true);
        expect(body.input).toMatch(
          /^https:\/\/video-source\.example\/\.well-known\/pirate\/video-source\/v1\/[A-Za-z0-9_-]{43}$/u,
        );
        accepted = body;
        throw new Error("accepted copy response lost");
      }
      if (path.pathname.endsWith("/downloads")) return Response.json({ success: true, result: {} });
      if (!accepted) throw new Error("observation before persisted copy");
      expect(path.searchParams.get("creator")).toBe(accepted.creator);
      observations++;
      return Response.json({
        success: true,
        result: [
          {
            uid: "c".repeat(32),
            creator: accepted.creator,
            meta: accepted.meta,
            requireSignedURLs: true,
            readyToStream: observations > 1,
            status: { state: observations > 1 ? "ready" : "inprogress" },
          },
        ],
      });
    } catch (error) {
      fetchErrors.push(String(error));
      throw error;
    }
  });
  try {
    expect(await dispatch()).toMatchObject({ selected: 2, sent: 2, failed: 0 });
    expect(await dispatch()).toMatchObject({ selected: 2, sent: 2, failed: 0 });
    const launched = [...instances].filter(([, row]) =>
      row.effectIdentity.startsWith("video-enrichment:"),
    );
    expect(launched).toHaveLength(2);
    let crash = true;
    let sleeps = 0;
    for (const [instanceId, { effectIdentity }] of launched) {
      const memo = new Map<string, unknown>();
      const completedSleeps = new Set<string>();
      const step: VideoAnalysisWorkflowStep = {
        do: async <T>(name: string, _options: unknown, run: () => Promise<T>) => {
          if (memo.has(name)) return memo.get(name) as T;
          const value = await run();
          if (effectIdentity.includes(":stream:") && value === true && crash) {
            crash = false;
            throw new Error("completion acknowledgement lost");
          }
          memo.set(name, value);
          return value;
        },
        sleep: async (name, duration) => {
          if (completedSleeps.has(name)) return;
          completedSleeps.add(name);
          expect(duration).toBe(30_000);
          sleeps++;
          if (sleeps > 4) {
            const rows = await admin.query(
              "SELECT state, count(*) OVER ()::int AS n FROM media_video_stream_ingests",
            );
            const grants = await admin.query(
              "SELECT count(*)::int AS n FROM media_video_source_grants WHERE consumer='stream'",
            );
            throw new Error(
              `enrichment did not converge: copies=${copies}, observations=${observations}, fetches=${fetcher.mock.calls.length}, grants=${grants.rows[0].n}, rows=${JSON.stringify(rows.rows)}, errors=${JSON.stringify(fetchErrors)}`,
            );
          }
          // Advance only an expired test lease, never the persisted attempt deadlines.
          await admin.query(
            "UPDATE media_video_enrichment_outbox SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1 AND state='running'",
            [operationId],
          );
        },
        waitForEvent: async () => {
          throw new Error("enrichment must not wait for approval");
        },
      };
      const run = () =>
        VideoAnalysisWorkflow.prototype.run.call(
          { env: runtimeEnv } as never,
          { instanceId, payload: { effectIdentity } } as never,
          step as never,
        );
      if (effectIdentity.includes(":stream:"))
        await expect(run()).rejects.toThrow("completion acknowledgement lost");
      expect(await run()).toEqual({ outcome: "enrichment_complete" });
      expect(await run()).toEqual({ outcome: "enrichment_complete" });
      expect(JSON.stringify([...memo])).not.toMatch(/https:|Bearer|fixture-stream|source_sha256/u);
    }
    expect(copies).toBe(1);
    expect(observations).toBe(2);
    expect(sleeps).toBe(2);
    expect(
      (
        await admin.query(
          "SELECT state FROM media_video_enrichment_outbox ORDER BY enrichment_kind",
        )
      ).rows,
    ).toEqual([{ state: "ready" }, { state: "ready" }]);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM media_video_source_grants WHERE consumer='stream'",
        )
      ).rows[0].n,
    ).toBe(1);
    expect(await dispatch()).toMatchObject({ selected: 0, sent: 0, failed: 0 });
    const postId = String(
      (await admin.query("SELECT post_id FROM posts WHERE post_type='video'")).rows[0].post_id,
    );
    const post = await Effect.runPromise(
      makeControlPlaneContentStore(layer).getPost({
        postId,
        communityId: community,
        viewerUserId: "public-post-anonymous",
      }),
    );
    expect(post).toMatchObject({
      video: { playback: { status: "ready" }, thumbnail: { status: "ready" } },
    });
  } finally {
    fetcher.mockRestore();
  }
}
