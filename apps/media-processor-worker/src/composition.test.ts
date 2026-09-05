import { describe, expect, test } from "bun:test";
import type { MediaTransformVideoCapabilities } from "@pirate/application/media/transform";
import type { VideoAnalysisProviders } from "@pirate/application/video/analysis";
import { Effect } from "effect";
import {
  type MediaProcessorRuntimeEnv,
  makeMediaProcessorComposition,
  mediaProcessingPhysicalObjectKey,
} from "./composition.ts";

const disabledEnv = (): MediaProcessorRuntimeEnv => ({
  MEDIA_PROCESSING_ENABLED: "false",
  CONTROL_PLANE: { connectionString: "postgres://disabled.invalid/control" },
  MEDIA_PROCESSING_WORKFLOW: {
    get: async () => ({
      status: async () => ({ status: "unknown" }),
      sendEvent: async () => undefined,
    }),
    createBatch: async () => [],
  },
  get ACRCLOUD_ACCESS_KEY(): string {
    throw new Error("disabled composition read a provider secret");
  },
  get ELEVENLABS_API_KEY(): string {
    throw new Error("disabled composition read a provider secret");
  },
  get OPENROUTER_API_KEY(): string {
    throw new Error("disabled composition read a provider secret");
  },
  get QENCODE_API_KEY(): string {
    throw new Error("disabled composition read a provider secret");
  },
});

describe("media processor composition", () => {
  test("disabled posture constructs no providers and reads no provider secret", () => {
    const composition = makeMediaProcessorComposition(disabledEnv());
    expect(composition.workflow.options.enabled).toBe(false);
    expect(composition.workflow.providers).toBeNull();
  });

  test("requires explicit provider composition before video analysis is enabled", () => {
    const base = disabledEnv();
    expect(() =>
      makeMediaProcessorComposition({
        MEDIA_PROCESSING_ENABLED: base.MEDIA_PROCESSING_ENABLED as string,
        CONTROL_PLANE: base.CONTROL_PLANE as NonNullable<MediaProcessorRuntimeEnv["CONTROL_PLANE"]>,
        MEDIA_PROCESSING_WORKFLOW: base.MEDIA_PROCESSING_WORKFLOW as NonNullable<
          MediaProcessorRuntimeEnv["MEDIA_PROCESSING_WORKFLOW"]
        >,
        VIDEO_ANALYSIS_ENABLED: "true",
        VIDEO_ANALYSIS_WORKFLOW: {
          createBatch: async () => [],
          get: async () => ({ status: async () => ({ status: "running" }) }),
        },
      }),
    ).toThrow("video analysis providers are required");
  });

  test("refuses the Qencode provisioning sentinel before provider work", () => {
    const base = disabledEnv();
    const providers = {} as VideoAnalysisProviders;
    expect(() =>
      makeMediaProcessorComposition(
        {
          MEDIA_PROCESSING_ENABLED: base.MEDIA_PROCESSING_ENABLED as string,
          CONTROL_PLANE: base.CONTROL_PLANE as NonNullable<
            MediaProcessorRuntimeEnv["CONTROL_PLANE"]
          >,
          MEDIA_PROCESSING_WORKFLOW: base.MEDIA_PROCESSING_WORKFLOW as NonNullable<
            MediaProcessorRuntimeEnv["MEDIA_PROCESSING_WORKFLOW"]
          >,
          VIDEO_ANALYSIS_ENABLED: "true",
          QENCODE_API_KEY: "PENDING",
        },
        {
          videoAnalysis: {
            providers,
            qencode: {
              sourceGateway: {
                issue: async () => {
                  throw new Error("provider gateway must not run");
                },
              },
              transport: {
                createTask: async () => {
                  throw new Error("provider transport must not run");
                },
                startTask: async () => {
                  throw new Error("provider transport must not run");
                },
                getStatus: async () => {
                  throw new Error("provider transport must not run");
                },
              },
              artifacts: {
                readJson: async () => {
                  throw new Error("provider artifacts must not run");
                },
                seal: async () => {
                  throw new Error("provider artifacts must not run");
                },
              },
            },
          },
        },
      ),
    ).toThrow("QENCODE_API_KEY is pending provisioning");
  });

  test("composes the video consumer through the same transform port and maps its sealed key", async () => {
    let observedObjectKey = "";
    const transform: MediaTransformVideoCapabilities = {
      probe: (input) => {
        observedObjectKey = input.source.objectKey;
        return Effect.succeed({
          status: "unavailable",
          reason: "disabled",
          attempt: input.attempt,
        });
      },
      extractVideoAudio: (input) =>
        Effect.succeed({ status: "unavailable", reason: "disabled", attempt: input.attempt }),
      extractVideoFrames: (input) =>
        Effect.succeed({ status: "unavailable", reason: "disabled", attempt: input.attempt }),
    };
    const providers = {} as VideoAnalysisProviders;
    const base = disabledEnv();
    const composition = makeMediaProcessorComposition(
      {
        MEDIA_PROCESSING_ENABLED: base.MEDIA_PROCESSING_ENABLED as string,
        CONTROL_PLANE: base.CONTROL_PLANE as NonNullable<MediaProcessorRuntimeEnv["CONTROL_PLANE"]>,
        MEDIA_PROCESSING_WORKFLOW: base.MEDIA_PROCESSING_WORKFLOW as NonNullable<
          MediaProcessorRuntimeEnv["MEDIA_PROCESSING_WORKFLOW"]
        >,
        VIDEO_ANALYSIS_ENABLED: "true",
        VIDEO_ANALYSIS_WORKFLOW: {
          createBatch: async () => [],
          get: async () => ({ status: async () => ({ status: "running" }) }),
        },
      },
      { videoAnalysis: { providers, transform } },
    );
    const attempt = {
      version: "media-transform-attempt-v1" as const,
      runtimeFence: { submittedAtMs: 1, runtimeDeadlineMs: 2 },
    };
    await Effect.runPromise(
      composition.videoAnalysis?.runtime.transform.probe({
        version: "media-transform-video-probe-input-v1",
        binding: {
          operationId: "video-operation-1",
          videoRevision: 1,
          analysisRevision: 1,
          creationRevision: 1,
          canonicalVideoSha256: "a".repeat(64),
          requestId: "video-probe-1",
        },
        source: {
          objectKey: "media://immutable/video-operation-1/video/1",
          sha256: "a".repeat(64),
          byteLength: 1,
          mediaType: "video/mp4",
        },
        attempt,
      }) ?? Effect.die("video analysis composition is missing"),
    );
    expect(observedObjectKey).toBe("immutable/video-operation-1/video/1");
  });

  test("maps only the canonical immutable logical reference to a physical R2 key", () => {
    expect(mediaProcessingPhysicalObjectKey("media://immutable/operation-1")).toBe(
      "immutable/operation-1",
    );
    expect(() => mediaProcessingPhysicalObjectKey("immutable/operation-1")).toThrow();
    expect(() => mediaProcessingPhysicalObjectKey("media://immutable/../secret")).toThrow();
  });

  test("refuses the classifier provisioning sentinel before a provider call", () => {
    expect(() =>
      makeMediaProcessorComposition({
        MEDIA_PROCESSING_ENABLED: "true",
        DATA_REGISTRATION_ENABLED: "false",
        CONTROL_PLANE: { connectionString: "postgres://enabled.invalid/control" },
        MEDIA_PROCESSING_WORKFLOW: {
          get: async () => ({
            status: async () => ({ status: "unknown" }),
            sendEvent: async () => undefined,
          }),
          createBatch: async () => [],
        },
        MEDIA_IMMUTABLE_ORIGINALS: {} as R2Bucket,
        MEDIA_DERIVED_ARTIFACTS: {} as R2Bucket,
        IMAGE_TRANSFORMATIONS: {} as ImagesBinding,
        ACRCLOUD_IDENTIFY_HOST: "identify-eu-west-1.acrcloud.com",
        ACRCLOUD_ACCESS_KEY: "fixture-access-key",
        ACRCLOUD_ACCESS_SECRET: "fixture-access-secret",
        ELEVENLABS_API_KEY: "fixture-elevenlabs-key",
        OPENAI_API_KEY: "fixture-openai-key",
        OPENROUTER_API_KEY: "PENDING",
      }),
    ).toThrow("OPENROUTER_API_KEY is pending provisioning");
  });
});
