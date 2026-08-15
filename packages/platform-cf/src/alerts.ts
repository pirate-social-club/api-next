import { type Alert, AlertCollector, type AlertSeverity } from "@pirate/application";
import type { Effect as EffectType } from "effect";
import { Effect, Layer } from "effect";

/**
 * Production sinks for aggregated alert delivery (000 §12). One email per
 * tick plus a webhook page for high severity. Concrete email/webhook
 * adapters land in M1; the spike proves the aggregation seam.
 */
export interface AlertSink {
  readonly email: (digest: AlertDigest) => EffectType.Effect<void>;
  readonly webhook: (alerts: readonly Alert[]) => EffectType.Effect<void>;
}

export interface AlertGroup {
  /** Dedupe identity: key plus entity, severity deliberately excluded (000 §12). */
  readonly dedupeKey: string;
  readonly key: string;
  readonly entity?: string;
  readonly severity: AlertSeverity;
  readonly count: number;
}

export interface AlertDigest {
  readonly groups: readonly AlertGroup[];
  /** Keys dropped by the per-family cap, reported as overflow counts. */
  readonly overflow: number;
}

/** Key family is the leading colon-delimited segment (`wallet:underfunded` -> `wallet`). */
function familyOf(key: string): string {
  return key.split(":")[0] ?? key;
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { low: 0, medium: 1, high: 2 };

const MAX_KEYS_PER_FAMILY = 5;

/**
 * Pure aggregation for one tick: group by key family, dedupe with severity
 * excluded from the key (severity escalates via max), cap distinct keys per
 * family, count overflow.
 */
export function aggregateAlerts(alerts: readonly Alert[]): AlertDigest {
  const byKey = new Map<string, AlertGroup>();
  for (const alert of alerts) {
    const dedupeKey = `${alert.key}|${alert.entity ?? ""}`;
    const existing = byKey.get(dedupeKey);
    if (existing === undefined) {
      byKey.set(dedupeKey, {
        dedupeKey,
        key: alert.key,
        ...(alert.entity !== undefined ? { entity: alert.entity } : {}),
        severity: alert.severity,
        count: 1,
      });
      continue;
    }
    const severity =
      SEVERITY_RANK[alert.severity] > SEVERITY_RANK[existing.severity]
        ? alert.severity
        : existing.severity;
    byKey.set(dedupeKey, { ...existing, severity, count: existing.count + 1 });
  }

  let overflow = 0;
  const familyCounts = new Map<string, number>();
  const groups: AlertGroup[] = [];
  for (const group of byKey.values()) {
    const family = familyOf(group.key);
    const seen = familyCounts.get(family) ?? 0;
    if (seen >= MAX_KEYS_PER_FAMILY) {
      overflow += group.count;
      continue;
    }
    familyCounts.set(family, seen + 1);
    groups.push(group);
  }
  return { groups, overflow };
}

/**
 * Runs `body` with an `AlertCollector` that buffers emits, then — in a scope
 * finalizer — aggregates the buffer and delivers at most one email per tick
 * plus a webhook for high severity. The finalizer runs on every exit
 * (success, expected failure, interruption), so alerts emitted before an
 * interruption are never lost. Severity floor: `low` never pages, it only
 * lands in the digest.
 */
export function alertTick<A, E, R>(
  sink: AlertSink,
  body: EffectType.Effect<A, E, R | AlertCollector>,
): EffectType.Effect<A, E, Exclude<R, AlertCollector>> {
  return Effect.scoped(
    Effect.gen(function* () {
      const buffer: Alert[] = [];
      const collector = Layer.succeed(AlertCollector, {
        emit: (alert) =>
          Effect.sync(() => {
            buffer.push(alert);
          }),
      });
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (buffer.length === 0) return;
          const digest = aggregateAlerts(buffer);
          yield* sink.email(digest);
          const paging = digest.groups.filter((g) => g.severity === "high");
          if (paging.length > 0) {
            yield* sink.webhook(buffer.filter((a) => a.severity === "high"));
          }
        }),
      );
      return yield* Effect.provide(body, collector) as EffectType.Effect<A, E, R>;
    }),
  ) as EffectType.Effect<A, E, Exclude<R, AlertCollector>>;
}
