import { env } from "cloudflare:test";
import { Client } from "pg";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  MediaProcessorRuntimeAdapters,
  MediaProcessorRuntimeEnv,
} from "../../apps/media-processor-worker/src/composition.ts";
import { makeMediaProcessorComposition } from "../../apps/media-processor-worker/src/composition.ts";
import { VideoAnalysisWorkflow } from "../../apps/media-processor-worker/src/entrypoint.ts";
import { makeMediaProcessorQueueWorker } from "../../apps/media-processor-worker/src/index.ts";
import type { VideoAnalysisWorkflowStep } from "../../apps/media-processor-worker/src/video-workflow.ts";
import sourceGatewayWorker from "../../apps/video-source-gateway/src/index.ts";
import type {
  VideoSafetyFact,
  VideoSoundtrackFact,
} from "../../packages/application/src/video/analysis.ts";
import { dispatchVideoPublicationWakeups } from "../../packages/application/src/video/publication-wakeup.ts";
import { recoverVideoWorkflowLaunches } from "../../packages/application/src/video/workflow-recovery.ts";
import {
  makeR2QencodeArtifactStore,
  type QencodeTaskQuery,
} from "../../packages/platform-cf/src/qencode-media-transform.ts";
import { makeControlPlaneVideoAnalysisOutboxRepository } from "../../packages/platform-cf/src/video-analysis-outbox-repository.ts";
import { makeCloudflareVideoAnalysisWorkflowLauncher } from "../../packages/platform-cf/src/video-analysis-workflow-cloudflare.ts";
import {
  actor,
  community,
  finalizedFixture,
  operationId,
  responseBytes,
  responseSha256,
  seedVideoActors,
  submissionId,
} from "../../packages/platform-cf/src/video-publication.pg-fixture.ts";
import { makeVideoPublicationWakeupStore } from "../../packages/platform-cf/src/video-publication-wakeup-repository.ts";

const injected = vi.hoisted(() => ({ adapters: {} as MediaProcessorRuntimeAdapters }));
vi.mock("../../apps/media-processor-worker/src/composition.ts", async (original) => {
  const actual =
    await original<typeof import("../../apps/media-processor-worker/src/composition.ts")>();
  return {
    ...actual,
    makeMediaProcessorComposition: (bindings: MediaProcessorRuntimeEnv) =>
      actual.makeMediaProcessorComposition(bindings, injected.adapters),
  };
});

const bindings = env as unknown as { VIDEO_TEST_DATABASE: string; VIDEO_TEST_RESET: string };
let admin: Client;
let fixture: Awaited<ReturnType<typeof finalizedFixture>>;
beforeEach(async () => {
  admin = new Client({ connectionString: bindings.VIDEO_TEST_DATABASE });
  await admin.connect();
  await admin.query("SET search_path TO api_next,pg_catalog");
  await admin.query(bindings.VIDEO_TEST_RESET);
  await seedVideoActors(admin);
  const url = new URL(bindings.VIDEO_TEST_DATABASE);
  url.searchParams.set("options", "-c search_path=api_next,pg_catalog");
  fixture = await finalizedFixture(url.toString());
});
afterEach(async () => {
  await admin?.end();
});

function harness(durableGrants = false) {
  const objects = new Map<
    string,
    {
      key: string;
      size: number;
      httpMetadata: { contentType: string };
      customMetadata: Record<string, string>;
    }
  >();
  const bucket = {
    head: async (key: string) => objects.get(key) ?? null,
    put: async (
      key: string,
      value: Uint8Array,
      options: { httpMetadata: { contentType: string }; customMetadata: Record<string, string> },
    ) => {
      if (objects.has(key)) return null;
      const object = {
        key,
        size: value.byteLength,
        httpMetadata: options.httpMetadata,
        customMetadata: options.customMetadata,
      };
      objects.set(key, object);
      return object;
    },
  };
  const tasks = new Map<string, QencodeTaskQuery>();
  const starts: string[] = [];
  const instances = new Map<string, { effectIdentity: string; status: string }>();
  const events: unknown[] = [];
  let nextTask = 0;
  let loseStart = false;
  let frameFailure = false;
  let terminalFrameFailure = false;
  const expiredTasks = new Set<string>();
  let safetyHold = false;
  let afterStart: (() => Promise<void>) | undefined;
  const artifacts = makeR2QencodeArtifactStore(bucket, async (url) => {
    if (String(url).endsWith("metadata"))
      return Response.json({
        format: { duration: "10" },
        streams: [
          {
            codec_type: "video",
            codec_name: "h264",
            width: 1080,
            height: 1920,
            avg_frame_rate: "30/1",
          },
          { codec_type: "audio", codec_name: "aac" },
        ],
      });
    const audio = String(url).endsWith("audio");
    return new Response(
      audio
        ? new Uint8Array([0, 0, 0, 12, 102, 116, 121, 112, 0, 0, 0, 0])
        : new Uint8Array(frameFailure ? [0, 0, 0, 0] : [255, 216, 255, 217]),
      { headers: { "content-type": audio ? "audio/mp4" : "image/jpeg" } },
    );
  });
  // Only provider boundaries are replaced; every application command and repository is concrete.
  const providerFetch = async (url: string): Promise<Response> =>
    url.endsWith("recognition")
      ? Response.json({
          verification: {
            status: "no_match",
            evidenceRef: "acr:fixture",
            adapterRevision: "acr-fixture-v1",
          },
          evidenceRef: "acr:fixture",
          adapterRevision: "acr-fixture-v1",
        })
      : Response.json({
          requestId: "safety:fixture",
          evidenceRef: "safety:fixture",
          minorSafetyEvidenceRef: "minor-safety:fixture",
          mediaSafety: safetyHold ? "review_required" : "allow",
          captionSafety: "not_applicable",
          automatedRating: "general",
          policyRevision: "safety-v1",
          adapterRevision: "safety-fixture-v1",
        });
  injected.adapters = {
    videoAnalysis: {
      providers: {
        hash: async () => {
          throw new Error("unexpected source body hash");
        },
        identifySoundtrack: async () =>
          (
            await providerFetch("https://fixture.invalid/recognition")
          ).json() as Promise<VideoSoundtrackFact>,
        moderate: async () =>
          (
            await providerFetch("https://fixture.invalid/safety")
          ).json() as Promise<VideoSafetyFact>,
      },
      qencode: {
        artifacts,
        ...(durableGrants
          ? {}
          : {
              sourceGateway: {
                issue: async (input) => ({
                  url: "https://video-source.example.invalid/grant",
                  expiresAtMs: input.expiresAtMs,
                }),
              },
            }),
        transport: {
          createTask: async () => (++nextTask).toString(16).padStart(32, "0"),
          startTask: async ({ taskToken, query }) => {
            starts.push(taskToken);
            tasks.set(taskToken, query);
            if (afterStart) {
              const run = afterStart;
              afterStart = undefined;
              await run();
            }
            if (loseStart) {
              loseStart = false;
              throw new Error("accepted start response lost");
            }
            return "accepted";
          },
          getStatus: async (token) => {
            const query = tasks.get(token);
            if (!query || expiredTasks.has(token)) return { state: "not_started" };
            if (
              terminalFrameFailure &&
              query.format.some((format) => String(format.user_tag).includes("frame"))
            )
              return {
                state: "failed",
                errorDescription: `Source download failed HTTP 503 ${query.source}`,
              };
            return {
              state: "completed",
              outputs: query.format.map((format) => {
                const tag = String(format.user_tag);
                const kind = tag.includes("probe")
                  ? ("metadata" as const)
                  : tag.includes("audio")
                    ? ("audio" as const)
                    : ("image" as const);
                return {
                  kind,
                  userTag: tag,
                  url: `https://cdn.qencode.com/${kind}`,
                  outputFormat:
                    kind === "metadata" ? "metadata" : kind === "audio" ? "m4a" : "thumbnail",
                  mediaFacts: {
                    codec: null,
                    sampleRateHz: null,
                    channels: null,
                    width: kind === "image" ? 288 : null,
                    height: kind === "image" ? 512 : null,
                  },
                };
              }),
            };
          },
        },
      },
    },
  };
  const runtimeEnv: MediaProcessorRuntimeEnv = {
    CONTROL_PLANE: { connectionString: bindings.VIDEO_TEST_DATABASE },
    MEDIA_PROCESSING_ENABLED: "false",
    MEDIA_PROCESSING_WORKFLOW: {
      get: async () => ({ status: async () => ({ status: "running" }), sendEvent: async () => {} }),
      createBatch: async () => [],
    },
    MEDIA_IMMUTABLE_ORIGINALS: {
      head: async () => ({
        etag: "immutable-etag",
        version: "immutable-version",
        size: 1024,
        httpMetadata: { contentType: "video/mp4" },
      }),
    } as unknown as R2Bucket,
    MEDIA_DERIVED_ARTIFACTS: bucket as unknown as R2Bucket,
    VIDEO_ANALYSIS_ENABLED: "true",
    QENCODE_API_KEY: "fixture-key",
    VIDEO_SOURCE_GATEWAY_ORIGIN: "https://video-source.example",
    VIDEO_WORKFLOW_ACCOUNT_ID: "a".repeat(32),
    VIDEO_WORKFLOW_NAME: "video-fixture",
    VIDEO_WORKFLOW_SCRIPT_NAME: "processor-fixture",
    VIDEO_WORKFLOW_READ_TOKEN: "fixture-workflow-read-token",
    VIDEO_ANALYSIS_WORKFLOW: {
      createBatch: async (requests) =>
        requests.flatMap((request) => {
          if (instances.has(request.id)) return [];
          instances.set(request.id, { ...request.params, status: "running" });
          return [{}];
        }),
      get: async (id) => ({
        status: async () => ({ status: instances.get(id)?.status ?? "errored" }),
        sendEvent: async (event) => {
          events.push(event);
        },
      }),
    },
  };
  const workflowBinding = runtimeEnv.VIDEO_ANALYSIS_WORKFLOW;
  if (workflowBinding === undefined) throw new Error("missing test Workflow binding");
  const launcher = makeCloudflareVideoAnalysisWorkflowLauncher(workflowBinding, () => false);
  const composition = makeMediaProcessorComposition(runtimeEnv);
  const queue = makeMediaProcessorQueueWorker(makeMediaProcessorComposition);
  const outbox = makeControlPlaneVideoAnalysisOutboxRepository(fixture.layer);
  const wakeups = makeVideoPublicationWakeupStore(fixture.layer);
  const launch = async (creation = 1) => {
    let acknowledged = false;
    await queue.queue(
      {
        messages: [
          {
            body: {
              kind: "video_analysis",
              outbox_id: `video-analysis:${operationId}:v1:c${creation}`,
            },
            ack: () => {
              acknowledged = true;
            },
            retry: () => {
              throw new Error("unexpected queue retry");
            },
          },
        ],
      } as never,
      runtimeEnv,
    );
    expect(acknowledged).toBe(true);
    const intent = await outbox.get(`video-analysis:${operationId}:v1:c${creation}`);
    if (!intent?.workflowInstanceId) throw new Error("Workflow was not launched");
    return {
      instanceId: intent.workflowInstanceId,
      payload: { effectIdentity: instances.get(intent.workflowInstanceId)?.effectIdentity ?? "" },
    };
  };
  const memo = new Map<string, unknown>();
  let crashAfter: string | null = null;
  let beforeWait: (() => Promise<void>) | undefined;
  let afterDecision: (() => Promise<void>) | undefined;
  const step: VideoAnalysisWorkflowStep = {
    do: async <T>(name: string, _options: unknown, run: () => Promise<T>) => {
      if (memo.has(name)) return memo.get(name) as T;
      const value = await run();
      if (name === "decide-and-publish" && afterDecision) {
        const callback = afterDecision;
        afterDecision = undefined;
        await callback();
      }
      if (name === crashAfter) {
        crashAfter = null;
        throw new Error("injected Worker termination");
      }
      memo.set(name, value);
      return value;
    },
    sleep: async () => {},
    waitForEvent: async () => {
      if (beforeWait) await beforeWait();
      if (events.length === 0) throw new Error("publication event was not delivered");
      return events.shift();
    },
  };
  const run = (event: Awaited<ReturnType<typeof launch>>) =>
    VideoAnalysisWorkflow.prototype.run.call(
      { env: runtimeEnv } as never,
      event as never,
      step as never,
    );
  const approve = async () => {
    const held = await fixture.store.getSubmissionByOperation({ submissionId, operationId });
    if (!held) throw new Error("missing submission");
    await fixture.store.moderate({
      submission: held.state,
      actor: { kind: "user", userId: actor },
      expectedCreationRevision: held.state.creationRevision,
      action: { kind: "approve", hold: "safety", evidenceRef: null },
      endpointTemplate: "/moderation/media-post-submissions/:submissionId/actions",
      idempotencyKey: "approve-composed",
      requestHash: "8".repeat(64),
      responseBytes,
      responseSha256,
    });
    const video = composition.videoAnalysis;
    if (!video) throw new Error("missing video composition");
    await dispatchVideoPublicationWakeups({
      wakeups,
      outbox,
      store: fixture.store,
      launcher,
    });
  };
  return {
    runtimeEnv,
    composition,
    outbox,
    starts,
    tasks,
    memo,
    launch,
    run,
    approve,
    loseStart: () => {
      loseStart = true;
    },
    hold: () => {
      safetyHold = true;
    },
    failFrames: (value: boolean) => {
      frameFailure = value;
    },
    rejectFrameJob: (value: boolean) => {
      terminalFrameFailure = value;
    },
    expireExistingOutputs: () => {
      for (const token of tasks.keys()) expiredTasks.add(token);
    },
    crash: (name: string) => {
      crashAfter = name;
    },
    beforeWait: (callback: () => Promise<void>) => {
      beforeWait = callback;
    },
    afterDecision: (callback: () => Promise<void>) => {
      afterDecision = callback;
    },
    afterStart: (callback: () => Promise<void>) => {
      afterStart = callback;
    },
  };
}

async function assertPublished(creationRevision = 1) {
  const current = await fixture.store.getSubmissionByOperation({ submissionId, operationId });
  expect(current?.state.status).toBe("published");
  expect(
    (await admin.query("SELECT count(*)::int AS n FROM posts WHERE post_type='video'")).rows[0].n,
  ).toBe(1);
  expect(
    (
      await admin.query(
        "SELECT count(*)::int AS n FROM media_video_stage_facts WHERE creation_revision=$1",
        [creationRevision],
      )
    ).rows[0].n,
  ).toBe(5);
  expect(
    (await admin.query("SELECT count(*)::int AS n FROM media_video_enrichment_outbox")).rows[0].n,
  ).toBe(2);
}

test("composed success: queue and exported Workflow class reach one Post without test-side publication", async () => {
  const h = harness();
  expect(await h.run(await h.launch())).toEqual({ status: "published" });
  await assertPublished();
  expect(h.starts).toHaveLength(3);
  expect(
    (await admin.query("SELECT count(*)::int AS n FROM data_registration_outbox")).rows[0].n,
  ).toBe(1);
});

test("drill 1: accepted start and lost response survive Workflow replay with one start per capability", async () => {
  const h = harness();
  h.loseStart();
  h.crash("probe-submit");
  const event = await h.launch();
  await expect(h.run(event)).rejects.toThrow("injected Worker termination");
  expect(
    (
      await admin.query(
        "SELECT provider_job_phase FROM media_video_transform_attempts WHERE capability='probe'",
      )
    ).rows[0].provider_job_phase,
  ).toBe("submitting");
  expect(await h.run(event)).toEqual({ status: "published" });
  await assertPublished();
  expect(h.starts).toHaveLength(3);
});

test("drill 3: publication commit before completion acknowledgement replays to one Post and registration", async () => {
  const h = harness();
  h.crash("decide-and-publish");
  const event = await h.launch();
  await expect(h.run(event)).rejects.toThrow("injected Worker termination");
  await assertPublished();
  expect(await h.run(event)).toEqual({ status: "published" });
  expect(
    (await admin.query("SELECT count(*)::int AS n FROM data_registration_outbox")).rows[0].n,
  ).toBe(1);
  expect(h.starts).toHaveLength(3);
});

for (const timing of ["before-wait", "entering-wait"] as const) {
  test(`drill 4: last hold approved ${timing}, scheduled delivery publishes without author action`, async () => {
    const h = harness();
    h.hold();
    if (timing === "before-wait") h.afterDecision(h.approve);
    else h.beforeWait(h.approve);
    expect(await h.run(await h.launch())).toEqual({ status: "published" });
    await assertPublished();
    expect(h.starts).toHaveLength(3);
  });
}

test("drill 7: terminal undecodable poster then author retry uses new attempts and requested timestamp", async () => {
  const h = harness();
  h.failFrames(true);
  expect(await h.run(await h.launch())).toEqual({ status: "stopped" });
  const failed = await fixture.store.getSubmissionByOperation({ submissionId, operationId });
  expect(failed?.state.failureCode).toBe("poster_undecodable");
  if (!failed) throw new Error("missing failure");
  const firstRequests = (
    await admin.query("SELECT request_id FROM media_video_transform_attempts")
  ).rows.map((row) => row.request_id);
  await fixture.store.retryPoster({
    submission: failed.state,
    posterTimestampMs: 2500,
    endpointTemplate: "/media-post-submissions/:submissionId/retry-poster",
    idempotencyKey: "retry-composed-poster",
    requestHash: "9".repeat(64),
    responseBytes,
    responseSha256,
  });
  h.failFrames(false);
  h.memo.clear();
  expect(await h.run(await h.launch(2))).toEqual({ status: "published" });
  await assertPublished(2);
  const currentRequests = (
    await admin.query(
      "SELECT request_id FROM media_video_transform_attempts WHERE creation_revision=2",
    )
  ).rows.map((row) => row.request_id);
  expect(currentRequests).toHaveLength(3);
  expect(currentRequests.every((request) => !firstRequests.includes(request))).toBe(true);
  const published = await fixture.store.getSubmissionByOperation({ submissionId, operationId });
  expect(published?.state.analysis?.frames.extracted[0].requestedTimestampMs).toBe(2500);
  expect(h.starts).toHaveLength(6);
});

test("database failure after accepted start keeps submitting and resumes without an additional encode", async () => {
  const h = harness();
  h.afterStart(async () => {
    await admin.query(`CREATE FUNCTION reject_started_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.provider_job_phase='started' THEN RAISE EXCEPTION 'injected database failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_started_fixture BEFORE UPDATE ON media_video_transform_attempts FOR EACH ROW EXECUTE FUNCTION reject_started_fixture()`);
  });
  const event = await h.launch();
  try {
    await expect(h.run(event)).rejects.toThrow();
  } finally {
    await admin.query(
      "DROP TRIGGER IF EXISTS reject_started_fixture ON media_video_transform_attempts; DROP FUNCTION IF EXISTS reject_started_fixture()",
    );
  }
  expect(
    (await fixture.store.getSubmissionByOperation({ submissionId, operationId }))?.state.status,
  ).toBe("processing");
  expect(await h.run(event)).toEqual({ status: "published" });
  await assertPublished();
  expect(h.starts).toHaveLength(3);
});

test("event-sequence change during status inspection fences recovery while the real runner can resume", async () => {
  const h = harness();
  h.crash("probe-allocate");
  const event = await h.launch();
  await expect(h.run(event)).rejects.toThrow("injected Worker termination");
  const result = await recoverVideoWorkflowLaunches({
    outbox: h.outbox,
    store: fixture.store,
    launcher: {
      instanceId: async () => event.instanceId,
      inspect: async () => {
        await admin.query(
          "UPDATE media_post_submissions SET event_sequence=event_sequence+1 WHERE submission_id=$1",
          [submissionId],
        );
        return { state: "terminal", status: "errored" };
      },
    },
  });
  expect(result.failed).toBe(1);
  expect(
    (await fixture.store.getSubmissionByOperation({ submissionId, operationId }))?.state
      .reconciliationRequired,
  ).toBe(false);
  expect(await h.run(event)).toEqual({ status: "published" });
  await assertPublished();
  expect(h.starts).toHaveLength(3);
});

test("drill 5 fail closed: membership loss before publication cannot create a Post", async () => {
  const h = harness();
  await admin.query(
    "UPDATE community_memberships SET status='left',left_at=clock_timestamp(),updated_at=clock_timestamp() WHERE community_id=$1 AND user_id=$2",
    [community, actor],
  );
  await expect(h.run(await h.launch())).rejects.toMatchObject({
    name: "NonRetryableError",
    message: "video Workflow terminal: membership_rejected",
  });
  expect(
    (await admin.query("SELECT count(*)::int AS n FROM posts WHERE post_type='video'")).rows[0].n,
  ).toBe(0);
});

for (const boundary of ["probe-allocate", "probe-submit", "safety"] as const) {
  test(`terminal continuation after ${boundary} resumes the real class without duplicate encode`, async () => {
    const h = harness();
    h.crash(boundary);
    const event = await h.launch();
    await expect(h.run(event)).rejects.toThrow("injected Worker termination");
    const recovered = await recoverVideoWorkflowLaunches({
      outbox: h.outbox,
      store: fixture.store,
      launcher: {
        instanceId: async () => event.instanceId,
        inspect: async () => ({ state: "terminal", status: "errored" }),
      },
    });
    expect(recovered.recovered).toBe(1);
    h.memo.clear();
    const continuation = await h.launch();
    expect(continuation.instanceId).not.toBe(event.instanceId);
    expect(continuation.payload.effectIdentity.endsWith(":k1")).toBe(true);
    expect(await h.run(continuation)).toEqual({ status: "published" });
    await assertPublished();
    expect(h.starts).toHaveLength(3);
  });
}

test("drill 7: terminal provider job failure then technical retry creates a fresh provider attempt", async () => {
  const h = harness();
  h.rejectFrameJob(true);
  expect(await h.run(await h.launch())).toEqual({ status: "stopped" });
  const failed = await fixture.store.getSubmissionByOperation({ submissionId, operationId });
  expect(failed?.state.failureCode).toBe("transform_failed");
  const evidence = (
    await admin.query(
      "SELECT failure_evidence_ref FROM media_post_submissions WHERE submission_id=$1",
      [submissionId],
    )
  ).rows[0].failure_evidence_ref;
  expect(decodeURIComponent(evidence)).toContain("Source download failed HTTP 503");
  expect(decodeURIComponent(evidence)).not.toContain("https://");

  if (!failed) throw new Error("missing failure");
  await fixture.store.retryTechnical({
    submission: failed.state,
    endpointTemplate: "/media-post-submissions/:submissionId/retry",
    idempotencyKey: "retry-provider-failure",
    requestHash: "9".repeat(64),
    responseBytes,
    responseSha256,
  });
  h.rejectFrameJob(false);
  h.memo.clear();
  expect(await h.run(await h.launch(2))).toEqual({ status: "published" });
  await assertPublished(2);
  expect(h.starts).toHaveLength(6);
  expect(new Set(h.starts).size).toBe(6);
});

test("sealed audio survives a failed fact write and expired provider output", async () => {
  const h = harness();
  await admin.query(`CREATE FUNCTION reject_audio_fact_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.stage='audio' THEN RAISE EXCEPTION 'injected fact write failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_audio_fact_fixture BEFORE INSERT ON media_video_stage_facts FOR EACH ROW EXECUTE FUNCTION reject_audio_fact_fixture()`);
  const event = await h.launch();
  try {
    await expect(h.run(event)).rejects.toThrow();
  } finally {
    await admin.query(
      "DROP TRIGGER IF EXISTS reject_audio_fact_fixture ON media_video_stage_facts; DROP FUNCTION IF EXISTS reject_audio_fact_fixture()",
    );
  }
  h.expireExistingOutputs();
  expect(await h.run(event)).toEqual({ status: "published" });
  await assertPublished();
  expect(h.starts).toHaveLength(3);
});

test("durable source grant composition: submit replay preserves one grant and start per capability", async () => {
  const h = harness(true);
  h.loseStart();
  h.crash("probe-submit");
  const event = await h.launch();
  await expect(h.run(event)).rejects.toThrow("injected Worker termination");
  const first = (
    await admin.query("SELECT capability_sha256,request_id FROM media_video_source_grants")
  ).rows;
  expect(first).toHaveLength(1);
  expect(await h.run(event)).toEqual({ status: "published" });
  await assertPublished();
  const rows = (
    await admin.query(
      "SELECT capability_sha256,request_id,expires_at FROM media_video_source_grants",
    )
  ).rows;
  expect(rows).toHaveLength(3);
  expect(rows.filter((row) => row.request_id === first[0].request_id)).toHaveLength(1);
  expect(h.starts).toHaveLength(3);
  for (const query of h.tasks.values()) {
    const source = new URL(query.source);
    expect(source.origin).toBe("https://video-source.example");
    expect(source.search).toBe("");
    const response = await sourceGatewayWorker.fetch(
      new Request(source.toString(), { method: "HEAD" }),
      {
        CONTROL_PLANE: { connectionString: bindings.VIDEO_TEST_DATABASE },
        MEDIA_IMMUTABLE_ORIGINALS: {
          head: async (key) => ({
            key,
            etag: "immutable-etag",
            version: "immutable-version",
            size: 1024,
            httpMetadata: { contentType: "video/mp4" },
          }),
          get: async () => null,
        },
      },
    );
    expect(response.status).toBe(200);

    expect(source.pathname).toMatch(
      /^\/\.well-known\/pirate\/video-source\/v1\/[A-Za-z0-9_-]{43}$/u,
    );
    expect(JSON.stringify(rows)).not.toContain(source.pathname.split("/").at(-1));
  }
});
