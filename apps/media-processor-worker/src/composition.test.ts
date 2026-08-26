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
    create: async () => undefined,
  },
  get TRANSLOADIT_AUTH_KEY(): string {
    throw new Error("disabled composition read a provider secret");
  },
  get ACRCLOUD_ACCESS_KEY(): string {
    throw new Error("disabled composition read a provider secret");
  },
  get ELEVENLABS_API_KEY(): string {
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
});
