import { describe, expect, test } from "bun:test";
import {
  dispatchEligibleVideoAnalysisOutbox,
  type VideoAnalysisOutboxDispatchSource,
} from "./video-analysis-outbox-dispatch.ts";

describe("video analysis outbox dispatcher", () => {
  test("sends a bounded page containing no media facts", async () => {
    const messages: unknown[] = [];
    const source: VideoAnalysisOutboxDispatchSource = {
      listEligible: async () => [
        { effectIdentity: "video-analysis:operation-1:v1:c1" },
        { effectIdentity: "video-analysis:operation-2:v1:c1" },
      ],
    };
    const result = await dispatchEligibleVideoAnalysisOutbox(source, {
      send: async (message) => {
        messages.push(message);
      },
    });
    expect(messages).toEqual([
      { kind: "video_analysis", outbox_id: "video-analysis:operation-1:v1:c1" },
      { kind: "video_analysis", outbox_id: "video-analysis:operation-2:v1:c1" },
    ]);
    expect(result).toEqual({ selected: 2, sent: 2, failed: 0 });
  });

  test("rejects an unbounded page before reading the store", async () => {
    let reads = 0;
    await expect(
      dispatchEligibleVideoAnalysisOutbox(
        {
          listEligible: async () => {
            reads += 1;
            return [];
          },
        },
        { send: async () => undefined },
        101,
      ),
    ).rejects.toBeInstanceOf(TypeError);
    expect(reads).toBe(0);
  });
});
