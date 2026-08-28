import { describe, expect, test } from "bun:test";
import { runMediaMaintenance } from "./media-runtime.ts";

describe("media scheduled maintenance", () => {
  test("dispatches durable outbox identities before checking retained Workflows", async () => {
    const events: string[] = [];
    const result = await runMediaMaintenance({
      dispatch: async () => {
        events.push("dispatch");
        return { selected: 2, sent: 2, failed: 0 };
      },
      sweep: async () => {
        events.push("sweep");
        return { inspected: 1, present: 1, replaced: 0, stale: 0, limitReached: 0 };
      },
    });

    expect(events).toEqual(["dispatch", "sweep"]);
    expect(result).toEqual({
      dispatch: { selected: 2, sent: 2, failed: 0 },
      sweep: { inspected: 1, present: 1, replaced: 0, stale: 0, limitReached: 0 },
    });
  });
});
