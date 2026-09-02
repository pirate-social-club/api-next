import { describe, expect, test } from "bun:test";
import {
  PROCESSING_QUEUE_RETRY_CAP_SECONDS,
  processingQueueRetryDelaySeconds,
} from "./processing-queue-primitives.ts";

describe("processing Queue retry delay", () => {
  test("uses the shared 15-second exponential policy without owning attempt limits", () => {
    expect([0, 1, 2, 3, 7, 8].map(processingQueueRetryDelaySeconds)).toEqual([
      15,
      15,
      30,
      60,
      900,
      PROCESSING_QUEUE_RETRY_CAP_SECONDS,
    ]);
  });
});
