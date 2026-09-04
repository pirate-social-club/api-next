import { describe, expect, test } from "bun:test";
import {
  dispatchEligibleMediaOutbox,
  type MediaOutboxDispatchMessage,
} from "./media-outbox-dispatch.ts";

describe("media outbox dispatcher", () => {
  test("sends only bounded durable outbox identities", async () => {
    const limits: number[] = [];
    const messages: MediaOutboxDispatchMessage[] = [];
    const result = await dispatchEligibleMediaOutbox(
      {
        listEligible: async (limit) => {
          limits.push(limit);
          return [{ outboxEventId: "outbox-1" }, { outboxEventId: "outbox-2" }];
        },
      },
      {
        send: async (message) => {
          if (!("kind" in message)) messages.push(message);
        },
      },
      2,
    );

    expect(limits).toEqual([2]);
    expect(messages).toEqual([{ outbox_id: "outbox-1" }, { outbox_id: "outbox-2" }]);
    expect(messages.every((message) => Object.keys(message).join(",") === "outbox_id")).toBe(true);
    expect(result).toEqual({ selected: 2, sent: 2, failed: 0 });
  });

  test("leaves failed sends eligible and continues the bounded page", async () => {
    const seen: string[] = [];
    const result = await dispatchEligibleMediaOutbox(
      {
        listEligible: async () => [
          { outboxEventId: "outbox-fails" },
          { outboxEventId: "outbox-succeeds" },
        ],
      },
      {
        send: async ({ outbox_id }) => {
          seen.push(outbox_id);
          if (outbox_id === "outbox-fails") throw new Error("fixture queue failure");
        },
      },
    );

    expect(seen).toEqual(["outbox-fails", "outbox-succeeds"]);
    expect(result).toEqual({ selected: 2, sent: 1, failed: 1 });
  });

  test("rejects an unbounded page before reading PostgreSQL", async () => {
    let reads = 0;
    await expect(
      dispatchEligibleMediaOutbox(
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
