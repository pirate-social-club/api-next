import { type Alert, AlertCollector, type AlertSeverity } from "@pirate/application";
import type { Effect as EffectType } from "effect";
import { Data, Effect, Exit, Layer, Redacted, Schedule } from "effect";

export interface AlertDeliveryLedger {
  /** Marks a delivery before dispatch; false means it was already marked. */
  readonly markSent: (deliveryKey: string) => EffectType.Effect<boolean, unknown>;
  /** Removes a pre-dispatch mark after a known sink failure. */
  readonly compensate: (deliveryKey: string) => EffectType.Effect<void, unknown>;
  readonly suppression?: AlertSuppressionLedger;
}

export interface AlertDeliveryStore {
  readonly markAlertSent: (deliveryKey: string) => Promise<boolean>;
  readonly compensateAlert: (deliveryKey: string) => Promise<void>;
  readonly getAlertSuppression: (conditionKey: string) => Promise<AlertSuppressionState | null>;
  readonly saveAlertSuppression: (state: AlertSuppressionState) => Promise<void>;
}

export class AlertSinkDeliveryFailed extends Data.TaggedError("AlertSinkDeliveryFailed")<{
  readonly sink: "email" | "webhook";
}> {}

export interface AlertSuppressionState {
  readonly conditionKey: string;
  readonly severity: AlertSeverity;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly lastDeliveredAt: number;
  /** Index of the next widening reminder delay. */
  readonly reminderIndex: number;
}

export interface AlertSuppressionDecision {
  readonly deliver: boolean;
  readonly reason: "transition" | "severity-escalation" | "reminder" | "suppressed";
  readonly state: AlertSuppressionState;
}

export interface AlertSuppressionLedger {
  readonly get: (conditionKey: string) => EffectType.Effect<AlertSuppressionState | null, unknown>;
  readonly put: (state: AlertSuppressionState) => EffectType.Effect<void, unknown>;
}

export interface AlertTickOptions {
  /** Injectable clock for deterministic scheduler and repeated-tick tests. */
  readonly now?: () => number;
  readonly activeWindowMs?: number;
}

/** Transition immediately, then remind after 1h, 4h, 12h, 24h, 3d, 7d. */
export const ALERT_REMINDER_DELAYS_MS = [
  60 * 60 * 1000,
  4 * 60 * 60 * 1000,
  12 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
  3 * 24 * 60 * 60 * 1000,
  7 * 24 * 60 * 60 * 1000,
] as const;

/** A condition absent for two five-minute ticks is a new transition. */
export const ALERT_CONDITION_ACTIVE_WINDOW_MS = 10 * 60 * 1000;

/**
 * Pure §12 state policy. Identical digests are not suppressed for a flat
 * retention window: a new condition alerts immediately, then reminders widen.
 */
export function decideAlertSuppression(input: {
  readonly conditionKey: string;
  readonly severity: AlertSeverity;
  readonly nowMs: number;
  readonly previous?: AlertSuppressionState;
  readonly activeWindowMs?: number;
}): AlertSuppressionDecision {
  const previous = input.previous;
  const activeWindowMs = input.activeWindowMs ?? ALERT_CONDITION_ACTIVE_WINDOW_MS;
  const severityEscalated =
    previous !== undefined && SEVERITY_RANK[input.severity] > SEVERITY_RANK[previous.severity];
  const transitioned =
    previous === undefined || input.nowMs - previous.lastSeenAt >= activeWindowMs;

  if (transitioned || severityEscalated) {
    return {
      deliver: true,
      reason: transitioned ? "transition" : "severity-escalation",
      state: {
        conditionKey: input.conditionKey,
        severity: input.severity,
        firstSeenAt: transitioned ? input.nowMs : previous.firstSeenAt,
        lastSeenAt: input.nowMs,
        lastDeliveredAt: input.nowMs,
        reminderIndex: 0,
      },
    };
  }

  const reminderIndex = Math.min(previous.reminderIndex, ALERT_REMINDER_DELAYS_MS.length - 1);
  const reminderDelay = ALERT_REMINDER_DELAYS_MS[reminderIndex] ?? 0;
  const deliver = input.nowMs - previous.lastDeliveredAt >= reminderDelay;
  return {
    deliver,
    reason: deliver ? "reminder" : "suppressed",
    state: {
      ...previous,
      severity: input.severity,
      lastSeenAt: input.nowMs,
      lastDeliveredAt: deliver ? input.nowMs : previous.lastDeliveredAt,
      reminderIndex: deliver
        ? Math.min(reminderIndex + 1, ALERT_REMINDER_DELAYS_MS.length - 1)
        : reminderIndex,
    },
  };
}

/**
 * Production sinks for aggregated alert delivery (000 §12). One email per
 * tick plus a webhook page for high severity. Concrete email/webhook
 * adapters share this aggregation seam.
 */
export interface AlertSink {
  readonly email: (digest: AlertDigest) => EffectType.Effect<void, unknown>;
  readonly webhook: (alerts: readonly Alert[]) => EffectType.Effect<void, unknown>;
  /** Low-severity digest delivery is deliberately not an email sink. */
  readonly digest?: (digest: AlertDigest) => EffectType.Effect<void, unknown>;
  readonly delivery?: AlertDeliveryLedger;
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
const MAX_GROUPS_PER_TICK = 50;

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
    if (seen >= MAX_KEYS_PER_FAMILY || groups.length >= MAX_GROUPS_PER_TICK) {
      overflow += group.count;
      continue;
    }
    familyCounts.set(family, seen + 1);
    groups.push(group);
  }
  return { groups, overflow };
}

const memoryDeliveryLedger = (): AlertDeliveryLedger => {
  const marked = new Set<string>();
  const states = new Map<string, AlertSuppressionState>();
  return {
    markSent: (deliveryKey) =>
      Effect.sync(() => {
        if (marked.has(deliveryKey)) return false;
        marked.add(deliveryKey);
        return true;
      }),
    compensate: (deliveryKey) => Effect.sync(() => void marked.delete(deliveryKey)),
    suppression: {
      get: (conditionKey) => Effect.sync(() => states.get(conditionKey) ?? null),
      put: (state) => Effect.sync(() => void states.set(state.conditionKey, state)),
    },
  };
};

export function makeAlertDeliveryLedger(store: AlertDeliveryStore): AlertDeliveryLedger {
  return {
    markSent: (deliveryKey) => Effect.tryPromise(() => store.markAlertSent(deliveryKey)),
    compensate: (deliveryKey) =>
      Effect.tryPromise(() => store.compensateAlert(deliveryKey)).pipe(Effect.asVoid),
    suppression: {
      get: (conditionKey) => Effect.tryPromise(() => store.getAlertSuppression(conditionKey)),
      put: (state) =>
        Effect.tryPromise(() => store.saveAlertSuppression(state)).pipe(Effect.asVoid),
    },
  };
}

function deliveryKey(
  kind: "digest" | "email" | "webhook",
  digest: AlertDigest,
  nowMs: number,
): string {
  const groups = digest.groups
    .map((group) => `${group.dedupeKey}:${group.severity}:${group.count}`)
    .join(",");
  const window = Math.floor(nowMs / (5 * 60 * 1000));
  return `api-next-alert:${kind}:window-${window}:${groups}:overflow-${digest.overflow}`;
}

function deliverWithCompensatingRetry(
  ledger: AlertDeliveryLedger,
  key: string,
  send: EffectType.Effect<void, unknown>,
): EffectType.Effect<void, unknown> {
  const attempt = Effect.gen(function* () {
    const marked = yield* ledger.markSent(key);
    if (!marked) return;
    const result = yield* Effect.exit(send);
    if (Exit.isSuccess(result)) return;
    // The mark is removed only for a known dispatch failure. The bounded one-
    // retry schedule prevents a sink outage from becoming a resend storm.
    yield* ledger.compensate(key);
    return yield* Effect.failCause(result.cause);
  });
  return Effect.retry(attempt, Schedule.recurs(1));
}

function pageOnce(alerts: readonly Alert[]): readonly Alert[] {
  const seen = new Set<string>();
  return alerts.filter((alert) => {
    const key = `${alert.key}|${alert.entity ?? ""}`;
    if (alert.severity !== "high" || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A safe local sink for development; it never contacts a provider. */
export function makeLocalAlertSink(
  log: (event: string, digest: AlertDigest) => void = (event, digest) =>
    console.info(event, { groups: digest.groups.length, overflow: digest.overflow }),
): AlertSink {
  const delivery = memoryDeliveryLedger();
  return {
    email: (digest) => Effect.sync(() => log("api-next alert email-equivalent", digest)),
    digest: (digest) => Effect.sync(() => log("api-next alert digest", digest)),
    webhook: (alerts) =>
      Effect.sync(() =>
        log("api-next alert webhook-equivalent", {
          groups: alerts.map((alert) => ({
            dedupeKey: `${alert.key}|${alert.entity ?? ""}`,
            key: alert.key,
            ...(alert.entity === undefined ? {} : { entity: alert.entity }),
            severity: alert.severity,
            count: 1,
          })),
          overflow: 0,
        }),
      ),
    delivery,
  };
}

export interface AlertHttpSinkConfig {
  readonly emailUrl: string;
  readonly webhookUrl: string;
  readonly emailToken: Redacted.Redacted<string>;
  readonly webhookToken: Redacted.Redacted<string>;
  readonly fetch?: typeof globalThis.fetch;
  readonly delivery?: AlertDeliveryLedger;
}

function postAlert(
  sink: "email" | "webhook",
  url: string,
  token: Redacted.Redacted<string>,
  payload: unknown,
  fetcher: typeof globalThis.fetch,
): EffectType.Effect<void, AlertSinkDeliveryFailed> {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetcher(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${Redacted.value(token)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error("alert sink rejected delivery");
    },
    catch: () => new AlertSinkDeliveryFailed({ sink }),
  });
}

/** Production HTTP adapters. Endpoint and token values never enter alert data. */
export function makeHttpAlertSink(config: AlertHttpSinkConfig): AlertSink {
  const fetcher = config.fetch ?? globalThis.fetch;
  return {
    email: (digest) => postAlert("email", config.emailUrl, config.emailToken, digest, fetcher),
    webhook: (alerts) =>
      postAlert(
        "webhook",
        config.webhookUrl,
        config.webhookToken,
        alerts.map((alert) => ({
          key: alert.key,
          severity: alert.severity,
          entity: alert.entity,
          body: "api-next high-severity maintenance alert",
        })),
        fetcher,
      ),
    ...(config.delivery === undefined ? {} : { delivery: config.delivery }),
  };
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
  options: AlertTickOptions = {},
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
          const ledger = sink.delivery ?? memoryDeliveryLedger();
          const nowMs = options.now?.() ?? Date.now();
          const suppression = ledger.suppression;
          const pendingStates: AlertSuppressionState[] = [];
          const deliverGroups: AlertGroup[] = [];
          if (suppression === undefined) {
            deliverGroups.push(...digest.groups);
          } else {
            for (const group of digest.groups) {
              const previous = yield* suppression.get(group.dedupeKey);
              const decision = decideAlertSuppression({
                conditionKey: group.dedupeKey,
                severity: group.severity,
                nowMs,
                ...(options.activeWindowMs === undefined
                  ? {}
                  : { activeWindowMs: options.activeWindowMs }),
                ...(previous === null ? {} : { previous }),
              });
              if (decision.deliver) {
                pendingStates.push(decision.state);
                deliverGroups.push(group);
              } else {
                yield* suppression.put(decision.state);
              }
            }
          }
          if (deliverGroups.length === 0) return;
          const deliverDigest: AlertDigest = { ...digest, groups: deliverGroups };
          const deliverKeys = new Set(deliverGroups.map((group) => group.dedupeKey));
          const paging = pageOnce(buffer).filter((alert) =>
            deliverKeys.has(`${alert.key}|${alert.entity ?? ""}`),
          );
          const hasEmailSeverity = deliverGroups.some((group) => group.severity !== "low");
          if (hasEmailSeverity) {
            yield* deliverWithCompensatingRetry(
              ledger,
              deliveryKey("email", deliverDigest, nowMs),
              sink.email(deliverDigest),
            ).pipe(
              Effect.catch(() => Effect.die("alert email sink failed after compensating retry")),
            );
          } else if (sink.digest !== undefined) {
            yield* deliverWithCompensatingRetry(
              ledger,
              deliveryKey("digest", deliverDigest, nowMs),
              sink.digest(deliverDigest),
            ).pipe(
              Effect.catch(() => Effect.die("alert digest sink failed after compensating retry")),
            );
          }
          if (deliverGroups.some((group) => group.severity === "high")) {
            yield* deliverWithCompensatingRetry(
              ledger,
              deliveryKey("webhook", deliverDigest, nowMs),
              sink.webhook(paging),
            ).pipe(
              Effect.catch(() => Effect.die("alert webhook sink failed after compensating retry")),
            );
          }
          if (suppression !== undefined) {
            for (const state of pendingStates) yield* suppression.put(state);
          }
        }).pipe(Effect.catchCause(() => Effect.die("api-next alert finalizer failed"))),
      );
      return yield* Effect.provide(body, collector) as EffectType.Effect<A, E, R>;
    }),
  ) as EffectType.Effect<A, E, Exclude<R, AlertCollector>>;
}
