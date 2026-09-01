import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  type KaraokeFinalizationRecoveryStore,
  redriveKaraokeFinalizations,
} from "./karaoke-finalization-recovery.ts";

describe("Karaoke finalization central re-drive", () => {
  test("continues after one RPC failure and reports only aggregate counts", async () => {
    const store: KaraokeFinalizationRecoveryStore = {
      listCandidates: () =>
        Effect.succeed([
          { sessionId: "session-rearmed" },
          { sessionId: "session-missing" },
          { sessionId: "session-failed" },
        ]),
    };
    const summary = await Effect.runPromise(
      redriveKaraokeFinalizations({
        store,
        namespace: {
          getByName: (sessionId) => ({
            redriveFinalization: async () => {
              if (sessionId === "session-failed") throw new Error("credential-shaped detail");
              if (sessionId === "session-missing") return { outcome: "missing", rearmed: [] };
              return { outcome: "scheduled", rearmed: ["score", "recording"] };
            },
          }),
        },
      }),
    );
    expect(summary).toEqual({
      selected: 3,
      scheduled: 1,
      rearmed: 2,
      missing: 1,
      rpcFailures: 1,
    });
    expect(JSON.stringify(summary)).not.toContain("session-");
    expect(JSON.stringify(summary)).not.toContain("credential");
  });
});
