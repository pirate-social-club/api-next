/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { type Alert, AlertCollector } from "@pirate/application";
import { type AlertDigest, alertTick } from "@pirate/platform-cf";
import { Effect, type Exit } from "effect";
import { describe, expect, it } from "vitest";

/**
 * Spike (c): the AlertCollector context service aggregates emits into a
 * single per-tick delivery via the scope finalizer — including when the tick
 * is interrupted, which is the whole reason aggregation lives in a finalizer.
 */

function recordingSink() {
  const emails: AlertDigest[] = [];
  const digests: AlertDigest[] = [];
  const webhooks: (readonly Alert[])[] = [];
  return {
    emails,
    digests,
    webhooks,
    sink: {
      email: (digest: AlertDigest) =>
        Effect.sync(() => {
          emails.push(digest);
        }),
      digest: (digest: AlertDigest) =>
        Effect.sync(() => {
          digests.push(digest);
        }),
      webhook: (alerts: readonly Alert[]) =>
        Effect.sync(() => {
          webhooks.push(alerts);
        }),
    },
  };
}

const emit = (alert: Alert) => AlertCollector.use((service) => service.emit(alert));

function requireDigest(digests: AlertDigest[]): AlertDigest {
  if (digests.length !== 1) throw new Error(`expected exactly one email, got ${digests.length}`);
  return digests[0] as AlertDigest;
}

describe("AlertCollector tick-finalizer aggregation (workerd)", () => {
  it("delivers one email per tick: deduped, severity-excluded from the key, capped per family", async () => {
    const { emails, webhooks, sink } = recordingSink();
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
      // 20 repeats of one low-severity key -> one group, count 20, digest only.
      for (let i = 0; i < 20; i++) {
        yield* emit({ key: "digest:routine", severity: "low", body: "r" });
      }
    });
    await Effect.runPromise(alertTick(sink, body));

    const digest = requireDigest(emails);
    // One webhook pass, containing only the high-severity alert.
    expect(webhooks.length).toBe(1);
    const paged = webhooks[0] as readonly Alert[];
    expect(paged.every((a) => a.severity === "high")).toBe(true);
    expect(paged.length).toBe(1);

    const byDedupe = new Map(digest.groups.map((g) => [g.dedupeKey, g]));
    const vaultMain = byDedupe.get("wallet:underfunded|vault-main");
    if (vaultMain === undefined) throw new Error("missing vault-main group");
    expect(vaultMain.count).toBe(3);
    expect(vaultMain.severity).toBe("high");
    expect(byDedupe.get("wallet:underfunded|vault-fees")?.count).toBe(1);
    expect(digest.groups.filter((g) => g.key.startsWith("shard:")).length).toBe(5);
    expect(digest.overflow).toBe(2);
    const routine = byDedupe.get("digest:routine|");
    if (routine === undefined) throw new Error("missing digest:routine group");
    expect(routine.count).toBe(20);
    expect(routine.severity).toBe("low");
  });

  it("low-only ticks digest without paging", async () => {
    const { emails, digests, webhooks, sink } = recordingSink();
    await Effect.runPromise(
      alertTick(
        sink,
        Effect.gen(function* () {
          yield* emit({ key: "digest:routine", severity: "low", body: "r" });
        }),
      ),
    );
    expect(emails.length).toBe(0);
    expect(digests.length).toBe(1);
    expect(webhooks.length).toBe(0);
  });

  it("finalizer aggregates even when the tick is interrupted mid-flight", async () => {
    const { emails, webhooks, sink } = recordingSink();
    const interrupted = Effect.gen(function* () {
      yield* emit({ key: "job:stuck", severity: "high", body: "halfway" });
      yield* Effect.forever(Effect.sleep(10));
    });
    const exit: Exit.Exit<unknown, unknown> = await Effect.runPromiseExit(
      Effect.timeout(alertTick(sink, interrupted), 100),
    );
    expect(exit._tag).toBe("Failure");

    // The emit that happened BEFORE the interruption still aggregated into a
    // single delivery — alerts before a cancellation are never lost.
    const digest = requireDigest(emails);
    expect(digest.groups).toHaveLength(1);
    expect(webhooks.length).toBe(1);
  });
});
