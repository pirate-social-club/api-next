import { describe, expect, test } from "bun:test";
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
});

describe("media processor composition", () => {
  test("disabled posture constructs no providers and reads no provider secret", () => {
    const composition = makeMediaProcessorComposition(disabledEnv());
    expect(composition.workflow.options.enabled).toBe(false);
    expect(composition.workflow.providers).toBeNull();
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
