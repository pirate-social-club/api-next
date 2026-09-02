import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  KARAOKE_FINALIZATION_RECOVERY_BINDING_PROBE,
  type KaraokeFinalizationRecoveryStore,
  type KaraokeFinalizationRedriveResult,
  redriveKaraokeFinalizations,
} from "./karaoke-finalization-recovery.ts";

describe("Karaoke finalization central re-drive", () => {
  test("continues after one RPC failure and reports only aggregate counts", async () => {
    const calls: string[] = [];
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
              calls.push(sessionId);
              if (sessionId === KARAOKE_FINALIZATION_RECOVERY_BINDING_PROBE) {
                return { outcome: "missing", rearmed: [] };
              }
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
    expect(calls).toEqual([
      KARAOKE_FINALIZATION_RECOVERY_BINDING_PROBE,
      "session-rearmed",
      "session-missing",
      "session-failed",
    ]);
    expect(JSON.stringify(summary)).not.toContain("session-");
    expect(JSON.stringify(summary)).not.toContain("credential");
  });

  const rejectedProbeResults: readonly [string, () => Promise<KaraokeFinalizationRedriveResult>][] =
    [
      ["non-missing result", async () => ({ outcome: "idle", rearmed: [] })],
      ["rearmed result", async () => ({ outcome: "missing", rearmed: ["score"] })],
      ["RPC failure", async () => Promise.reject(new Error("credential-shaped detail"))],
    ];

  test.each(rejectedProbeResults)(
    "fails closed on a %s before scanning candidates",
    async (_label, probe) => {
      let scanned = false;
      const store: KaraokeFinalizationRecoveryStore = {
        listCandidates: () => {
          scanned = true;
          return Effect.succeed([]);
        },
      };
      const failure = await Effect.runPromise(
        Effect.flip(
          redriveKaraokeFinalizations({
            store,
            namespace: {
              getByName: () => ({ redriveFinalization: probe }),
            },
          }),
        ),
      );
      expect(failure._tag).toBe("KaraokeFinalizationRecoveryBindingProbeFailed");
      expect(JSON.stringify(failure)).not.toContain("credential-shaped detail");
      expect(scanned).toBe(false);
    },
  );
});
