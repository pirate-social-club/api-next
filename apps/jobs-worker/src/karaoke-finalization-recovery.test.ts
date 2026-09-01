import { describe, expect, test } from "bun:test";
import { karaokeFinalizationRecoveryAlerts } from "./karaoke-finalization-recovery-alerts.ts";

describe("Karaoke finalization recovery alerts", () => {
  test("contains only aggregate recovery counts", () => {
    const alerts = karaokeFinalizationRecoveryAlerts({
      rearmed: 2,
      missing: 1,
      rpcFailures: 3,
    });
    expect(alerts.map((alert) => alert.key)).toEqual([
      "karaoke-finalization-recovery:exhausted",
      "karaoke-finalization-recovery:missing-object",
      "karaoke-finalization-recovery:rpc-failure",
    ]);
    expect(alerts.map((alert) => alert.entity)).toEqual([
      "job:karaoke.finalization-recovery:count:2",
      "job:karaoke.finalization-recovery:count:1",
      "job:karaoke.finalization-recovery:count:3",
    ]);
    expect(JSON.stringify(alerts)).not.toContain("session");
    expect(JSON.stringify(alerts)).not.toContain("attempt");
  });
});
