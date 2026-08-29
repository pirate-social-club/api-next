/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env as testEnv } from "cloudflare:test";
import { type Alert, AlertCollector } from "@pirate/application";
import {
  type AlertLogFields,
  type AlertSuppressionObservationFields,
  alertTick,
  makeAlertDeliveryLedger,
  type PipelineLogFields,
  type ScheduledCronLockDO,
} from "@pirate/platform-cf";
import { Effect, type Exit } from "effect";
import { describe, expect, it } from "vitest";

/**
 * Spike (c): the AlertCollector context service aggregates emits into a
 * single per-tick delivery via the scope finalizer — including when the tick
 * is interrupted, which is the whole reason aggregation lives in a finalizer.
 */

function recordingSink() {
  const logs: AlertLogFields[] = [];
  return {
    logs,
    sink: {
      log: (_event: string, fields: PipelineLogFields) => {
        if (fields.event === "pipeline.alert") logs.push(fields);
      },
    },
  };
}

const emit = (alert: Alert) => AlertCollector.use((service) => service.emit(alert));
const env = testEnv as unknown as { CRON_LOCK: DurableObjectNamespace<ScheduledCronLockDO> };

describe("AlertCollector tick-finalizer aggregation (workerd)", () => {
  it("persists one structured log per tick: deduped, severity-excluded from the key, capped per family", async () => {
    const { logs, sink } = recordingSink();
    const body = Effect.gen(function* () {
      // Same key, three severities, one entity -> ONE group, severity escalates.
      yield* emit({ key: "wallet:underfunded", severity: "low", body: "a", entity: "vault-main" });
      yield* emit({
        key: "wallet:underfunded",
        severity: "medium",
        body: "a",
        entity: "vault-main",
      });
      yield* emit({ key: "wallet:underfunded", severity: "high", body: "a", entity: "vault-main" });
      // Same key, different entity -> distinct group (entity is in the dedupe key).
      yield* emit({ key: "wallet:underfunded", severity: "low", body: "a", entity: "vault-fees" });
      // Seven distinct dynamic keys in one family -> 5 kept, 2 overflow.
      for (let i = 0; i < 7; i++) {
        yield* emit({ key: `shard:lag-${i}`, severity: "medium", body: `s${i}` });
      }
      // 20 repeats of one low-severity key -> one group, count 20, log only.
      for (let i = 0; i < 20; i++) {
        yield* emit({ key: "digest:routine", severity: "low", body: "r" });
      }
    });
    await Effect.runPromise(alertTick(sink, body));

    const vaultMain = logs.find((entry) => entry.key === "wallet:underfunded" && entry.count === 3);
    if (vaultMain === undefined) throw new Error("missing vault-main group");
    expect(vaultMain.count).toBe(3);
    expect(vaultMain.severity).toBe("high");
    expect(logs.filter((entry) => entry.key === "wallet:underfunded")).toHaveLength(2);
    expect(logs.filter((g) => g.key.startsWith("shard:")).length).toBe(5);
    expect(logs.every((entry) => entry.overflow === 2)).toBe(true);
    const routine = logs.find((entry) => entry.key === "digest:routine");
    if (routine === undefined) throw new Error("missing digest:routine group");
    expect(routine.count).toBe(20);
    expect(routine.severity).toBe("low");
  });

  it("low-only ticks persist a log without paging", async () => {
    const { logs, sink } = recordingSink();
    await Effect.runPromise(
      alertTick(
        sink,
        Effect.gen(function* () {
          yield* emit({ key: "digest:routine", severity: "low", body: "r" });
        }),
      ),
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ key: "digest:routine", severity: "low" });
  });

  it("finalizer aggregates even when the tick is interrupted mid-flight", async () => {
    const { logs, sink } = recordingSink();
    const interrupted = Effect.gen(function* () {
      yield* emit({ key: "job:stuck", severity: "high", body: "halfway" });
      return yield* Effect.forever(Effect.sleep(10));
    });
    const exit: Exit.Exit<unknown, unknown> = await Effect.runPromiseExit(
      Effect.timeout(alertTick(sink, interrupted), 100),
    );
    expect(exit._tag).toBe("Failure");

    // The emit that happened BEFORE the interruption still aggregated into a
    // single delivery — alerts before a cancellation are never lost.
    expect(logs).toHaveLength(1);
    expect(logs[0]?.key).toBe("job:stuck");
  });

  it("emits one transition and one bounded suppression proof across overlapping ticks", async () => {
    const logs: PipelineLogFields[] = [];
    const delivery = makeAlertDeliveryLedger(
      env.CRON_LOCK.getByName("cron-lock:alert-finalizer-atomic"),
    );
    const run = () =>
      Effect.runPromise(
        alertTick(
          {
            environment: "staging",
            delivery,
            log: (_event, fields) => logs.push(fields),
          },
          emit({
            key: "song-pipeline:media-launch-exhausted",
            severity: "high",
            body: "fixed",
            entity: "media:operation-1:r1:outbox-1",
          }),
          { now: () => 30_000 },
        ),
      );

    await Promise.all([run(), run()]);
    expect(
      logs.filter((entry): entry is AlertLogFields => entry.event === "pipeline.alert"),
    ).toHaveLength(1);
    expect(
      logs.filter(
        (entry): entry is AlertSuppressionObservationFields =>
          entry.event === "pipeline.alert.suppression",
      ),
    ).toEqual([
      expect.objectContaining({
        key: "song-pipeline:media-launch-exhausted",
        alert_severity: "high",
        suppression: "suppressed",
      }),
    ]);
  });
});
