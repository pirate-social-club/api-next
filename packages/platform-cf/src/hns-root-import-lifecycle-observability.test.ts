import { describe, expect, test } from "bun:test";
import {
  HnsLifecycleObservabilityUnavailable,
  readHnsLifecycleOperationalSnapshotV1,
} from "./hns-root-import-lifecycle-observability.ts";

const sampledAt = new Date("2026-09-12T20:00:00.000Z");

function snapshotQuery(overrides: Record<string, readonly Record<string, unknown>[]> = {}) {
  const rowsFor = (text: string): readonly Record<string, unknown>[] => {
    if (text.includes("GROUP BY phase")) {
      return (
        overrides.phases ?? [
          { phase: "preparing", count: 2 },
          { phase: "activated", count: 1 },
        ]
      );
    }
    if (text.includes("min(updated_at)")) return overrides.pending ?? [{ age_seconds: 120 }];
    if (text.includes("hns_root_import_lifecycle_jobs")) {
      return overrides.overdueLifecycle ?? [{ count: 1, oldest_seconds: 30 }];
    }
    if (text.includes("hns_root_health_renewal_jobs")) {
      return overrides.overdueRenewal ?? [{ count: 0, oldest_seconds: null }];
    }
    if (text.includes("max(consecutive_operational_failures)")) {
      return overrides.failures ?? [{ operations: 1, max_consecutive: 3 }];
    }
    if (text.includes("LIMIT 10")) {
      return (
        overrides.correlation ?? [
          {
            root_import_session_id: "operation-a",
            phase: "checking_authority",
            generation: 2,
            revision: 7,
            consecutive_operational_failures: 3,
            last_useful_error: "provider failed at https://user:secret@hsd.example/rpc",
            last_useful_error_at: new Date("2026-09-12T19:59:00.000Z"),
          },
        ]
      );
    }
    return [{ sampled_at: sampledAt }];
  };
  return async (text: string) => ({ rows: rowsFor(text) as never });
}

describe("HNS lifecycle operational snapshot", () => {
  test("reports phase counts, ages, overdue work and redacted correlation", async () => {
    const snapshot = await readHnsLifecycleOperationalSnapshotV1(snapshotQuery());
    expect(snapshot.phase_counts).toEqual([
      { phase: "preparing", count: 2 },
      { phase: "activated", count: 1 },
    ]);
    expect(snapshot.oldest_pending_age_seconds).toBe(120);
    expect(snapshot.overdue_lifecycle_jobs).toBe(1);
    expect(snapshot.overdue_renewal_jobs).toBe(0);
    expect(snapshot.oldest_overdue_seconds).toBe(30);
    expect(snapshot.operations_with_failures).toBe(1);
    expect(snapshot.max_consecutive_failures).toBe(3);
    expect(snapshot.sampled_at).toBe(sampledAt.toISOString());
    expect(snapshot.correlation).toEqual([
      {
        root_import_session_id: "operation-a",
        phase: "checking_authority",
        generation: 2,
        revision: 7,
        consecutive_operational_failures: 3,
        last_useful_error: "provider failed at <redacted>",
        last_useful_error_at: "2026-09-12T19:59:00.000Z",
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("secret");
  });

  test("a failing snapshot query reports a bounded, redacted cause", async () => {
    const failure = readHnsLifecycleOperationalSnapshotV1(async () => {
      throw new Error("connect failed for postgres://user:secret@host/db");
    });
    await expect(failure).rejects.toBeInstanceOf(HnsLifecycleObservabilityUnavailable);
    await failure.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "";
      expect(message).toContain("unavailable");
      expect(message).not.toContain("secret");
      expect(message).not.toContain("postgres://");
    });
  });
});
