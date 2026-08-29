import { type Alert, AlertCollector, type AlertSeverity } from "@pirate/application";
import type { Effect as EffectType } from "effect";
import { Effect, Layer } from "effect";

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
  /** Injectable Workers Logs writer for focused tests. */
  readonly log?: (event: string, fields: AlertLogFields) => void;
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

/** Safe correlation values that can be persisted in Workers Logs or a page. */
export interface AlertCorrelationFields {
  readonly operation_id?: string;
  readonly outbox_id?: string;
  readonly workflow_revision?: number;
  readonly subsystem?: "media" | "data";
  readonly operation?: "media-analysis" | "data-registration" | "maintenance";
  readonly failure_class?: string;
  readonly outcome?: "ok" | "retryable" | "terminal";
}

/** One structured, queryable event persisted to Workers Logs. */
export interface AlertLogFields extends AlertCorrelationFields {
  readonly event: "pipeline.alert";
  readonly schema_version: 1;
  readonly emitted_at: string;
  readonly environment: string;
  readonly key: string;
  readonly severity: AlertSeverity;
  readonly count: number;
  readonly overflow: number;
  readonly suppression: AlertSuppressionDecision["reason"];
  readonly sampled: false;
}

export type PipelineHealthSnapshotFields = Readonly<{
  readonly event: "pipeline.health.snapshot";
  readonly schema_version: 1;
  readonly emitted_at: string;
  readonly environment: string;
  readonly subsystem: "media" | "data";
  readonly operation: "media-analysis" | "data-registration";
  readonly pending_count: number;
  readonly retrying_count: number;
  readonly exhausted_count: number;
  readonly terminal_count: number;
  readonly oldest_pending_age_seconds: number | null;
  readonly last_success_at: string | null;
  readonly health: "healthy" | "degraded" | "blocked";
  readonly sampled: false;
}>;

export type OperationsBalanceSnapshotFields = Readonly<{
  readonly event: "operations.balance.snapshot";
  readonly schema_version: 1;
  readonly emitted_at: string;
  readonly environment: string;
  readonly wallet_role: "data_registration_signer" | "megapot_custody";
  readonly chain_id: number | null;
  readonly public_address: string | null;
  readonly balance_wei: string | null;
  readonly balance_ratio_bps: number | null;
  readonly observation_status: "fresh" | "unavailable";
  readonly reserve_status: "sufficient" | "low" | "blocked" | "unknown";
  readonly sampled: false;
}>;

export type PipelineLogFields =
  | AlertLogFields
  | PipelineHealthSnapshotFields
  | OperationsBalanceSnapshotFields;
export type PipelineLogEvent = PipelineLogFields["event"];

export type PipelineHealthSnapshotInput = Readonly<{
  readonly environment: string;
  readonly emitted_at: string;
  readonly subsystem: "media" | "data";
  readonly pending_count: number;
  readonly retrying_count: number;
  readonly exhausted_count: number;
  readonly terminal_count: number;
  readonly oldest_pending_age_seconds: number | null;
  readonly last_success_at: string | null;
  readonly health: PipelineHealthSnapshotFields["health"];
}>;

export function writePipelineHealthSnapshot(
  input: PipelineHealthSnapshotInput,
  writer: (event: PipelineLogEvent, fields: PipelineLogFields) => void,
): void {
  const counts = [
    input.pending_count,
    input.retrying_count,
    input.exhausted_count,
    input.terminal_count,
  ];
  if (
    counts.some((count) => !Number.isSafeInteger(count) || count < 0) ||
    (input.oldest_pending_age_seconds !== null &&
      (!Number.isSafeInteger(input.oldest_pending_age_seconds) ||
        input.oldest_pending_age_seconds < 0)) ||
    (input.last_success_at !== null && !Number.isFinite(Date.parse(input.last_success_at)))
  ) {
    return;
  }
  writer("pipeline.health.snapshot", {
    event: "pipeline.health.snapshot",
    schema_version: 1,
    emitted_at: input.emitted_at,
    environment: safeCorrelationValue(input.environment) ?? "unknown",
    subsystem: input.subsystem,
    operation: input.subsystem === "media" ? "media-analysis" : "data-registration",
    pending_count: input.pending_count,
    retrying_count: input.retrying_count,
    exhausted_count: input.exhausted_count,
    terminal_count: input.terminal_count,
    oldest_pending_age_seconds: input.oldest_pending_age_seconds,
    last_success_at: input.last_success_at,
    health: input.health,
    sampled: false,
  });
}

export type OperationsBalanceSnapshotInput = Readonly<{
  readonly environment: string;
  readonly emitted_at: string;
  readonly wallet_role: OperationsBalanceSnapshotFields["wallet_role"];
  readonly chain_id: number | null;
  readonly public_address: string | null;
  readonly balance_wei: bigint | null;
  readonly reserve_floor_wei: bigint;
  readonly blocked_floor_wei: bigint;
}>;

function balanceRatioBps(balance: bigint, floor: bigint): number {
  if (floor <= 0n || balance <= 0n) return 0;
  const ratio = (balance * 10_000n) / floor;
  return Number(ratio > 1_000_000n ? 1_000_000n : ratio);
}

export function writeOperationsBalanceSnapshot(
  input: OperationsBalanceSnapshotInput,
  writer: (event: PipelineLogEvent, fields: PipelineLogFields) => void,
): void {
  const address = input.public_address?.toLowerCase() ?? null;
  const identityUnavailable = input.chain_id === null && address === null;
  if (
    (!identityUnavailable &&
      (input.chain_id === null ||
        address === null ||
        !/^0x[0-9a-f]{40}$/u.test(address) ||
        !Number.isSafeInteger(input.chain_id) ||
        input.chain_id <= 0)) ||
    (identityUnavailable && input.balance_wei !== null) ||
    input.reserve_floor_wei <= 0n ||
    input.blocked_floor_wei <= 0n ||
    input.blocked_floor_wei > input.reserve_floor_wei ||
    (input.balance_wei !== null && input.balance_wei < 0n)
  ) {
    return;
  }
  const balance = input.balance_wei;
  const ratio = balance === null ? null : balanceRatioBps(balance, input.reserve_floor_wei);
  let reserveStatus: OperationsBalanceSnapshotFields["reserve_status"] = "unknown";
  if (balance !== null) {
    if (balance < input.blocked_floor_wei) {
      reserveStatus = "blocked";
    } else if (balance < input.reserve_floor_wei) {
      reserveStatus = "low";
    } else {
      reserveStatus = "sufficient";
    }
  }
  writer("operations.balance.snapshot", {
    event: "operations.balance.snapshot",
    schema_version: 1,
    emitted_at: input.emitted_at,
    environment: safeCorrelationValue(input.environment) ?? "unknown",
    wallet_role: input.wallet_role,
    chain_id: input.chain_id,
    public_address: address,
    balance_wei: balance?.toString(10) ?? null,
    balance_ratio_bps: ratio,
    observation_status: input.balance_wei === null ? "unavailable" : "fresh",
    reserve_status: reserveStatus,
    sampled: false,
  });
}

/**
 * Every operational alert is written to Workers Logs. Suppression state stays
 * in the existing ledger so transitions and reminders remain bounded.
 */
export interface AlertSink {
  /** Injectable Workers Logs adapter retained for development callers. */
  readonly log?: (event: PipelineLogEvent, fields: PipelineLogFields) => void;
  readonly environment?: string;
  readonly delivery?: AlertDeliveryLedger;
}

export interface AlertGroup {
  /** Dedupe identity: key plus entity, severity deliberately excluded (000 §12). */
  readonly dedupeKey: string;
  readonly key: string;
  readonly entity?: string;
  readonly severity: AlertSeverity;
  readonly count: number;
  readonly operation_id?: string;
  readonly outbox_id?: string;
  readonly workflow_revision?: number;
  readonly subsystem?: "media" | "data";
  readonly operation?: "media-analysis" | "data-registration" | "maintenance";
  readonly failure_class?: string;
  readonly outcome?: "ok" | "retryable" | "terminal";
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

const SAFE_CORRELATION_VALUE = /^[A-Za-z0-9._:/-]{1,256}$/u;

function safeCorrelationValue(value: string | null | undefined): string | undefined {
  return value !== undefined && value !== null && SAFE_CORRELATION_VALUE.test(value)
    ? value
    : undefined;
}

function safeCorrelationFields(alert: Alert): AlertCorrelationFields {
  const observable = alert as Alert & Partial<AlertCorrelationFields>;
  const operationId = safeCorrelationValue(observable.operation_id);
  const outboxId = safeCorrelationValue(observable.outbox_id);
  const workflowRevision =
    typeof observable.workflow_revision === "number" &&
    Number.isSafeInteger(observable.workflow_revision) &&
    observable.workflow_revision >= 0
      ? observable.workflow_revision
      : undefined;
  const failureClass = safeCorrelationValue(observable.failure_class);
  return {
    ...(operationId === undefined ? {} : { operation_id: operationId }),
    ...(outboxId === undefined ? {} : { outbox_id: outboxId }),
    ...(workflowRevision === undefined ? {} : { workflow_revision: workflowRevision }),
    ...(observable.subsystem === "media" || observable.subsystem === "data"
      ? { subsystem: observable.subsystem }
      : {}),
    ...(observable.operation === "media-analysis" ||
    observable.operation === "data-registration" ||
    observable.operation === "maintenance"
      ? { operation: observable.operation }
      : {}),
    ...(failureClass === undefined ? {} : { failure_class: failureClass }),
    ...(observable.outcome === "ok" ||
    observable.outcome === "retryable" ||
    observable.outcome === "terminal"
      ? { outcome: observable.outcome }
      : {}),
  };
}

function alertDedupeKey(alert: Alert): string {
  return `${alert.key}|${alert.entity ?? ""}`;
}

/**
 * Pure aggregation for one tick: group by key family, dedupe with severity
 * excluded from the key (severity escalates via max), cap distinct keys per
 * family, count overflow.
 */
export function aggregateAlerts(alerts: readonly Alert[]): AlertDigest {
  const byKey = new Map<string, AlertGroup>();
  for (const alert of alerts) {
    const dedupeKey = alertDedupeKey(alert);
    const correlation = safeCorrelationFields(alert);
    const existing = byKey.get(dedupeKey);
    if (existing === undefined) {
      byKey.set(dedupeKey, {
        dedupeKey,
        key: alert.key,
        ...(alert.entity !== undefined ? { entity: alert.entity } : {}),
        severity: alert.severity,
        count: 1,
        ...correlation,
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

/** A safe local sink for development; it never contacts a provider. */
export function makeLocalAlertSink(environment = "development"): AlertSink {
  const delivery = memoryDeliveryLedger();
  return {
    log: (event: PipelineLogEvent, fields: PipelineLogFields) => console.info(event, fields),
    environment,
    delivery,
  };
}

function writeAlertLog(
  group: AlertGroup,
  overflow: number,
  suppression: AlertLogFields["suppression"],
  emittedAt: string,
  environment: string,
  writer: (event: string, fields: AlertLogFields) => void,
): void {
  writer("pipeline.alert", {
    event: "pipeline.alert",
    schema_version: 1,
    emitted_at: emittedAt,
    environment,
    key: group.key,
    severity: group.severity,
    count: group.count,
    overflow,
    suppression,
    sampled: false,
    ...(group.operation_id === undefined ? {} : { operation_id: group.operation_id }),
    ...(group.outbox_id === undefined ? {} : { outbox_id: group.outbox_id }),
    ...(group.workflow_revision === undefined
      ? {}
      : { workflow_revision: group.workflow_revision }),
    ...(group.subsystem === undefined ? {} : { subsystem: group.subsystem }),
    operation: group.operation ?? "maintenance",
    ...(group.failure_class === undefined ? {} : { failure_class: group.failure_class }),
    ...(group.outcome === undefined ? {} : { outcome: group.outcome }),
  });
}

function reportAlertDiagnostic(message: string): void {
  console.error(message);
}

function safelyWriteAlertLog(
  group: AlertGroup,
  overflow: number,
  suppression: AlertLogFields["suppression"],
  emittedAt: string,
  environment: string,
  writer: (event: string, fields: AlertLogFields) => void,
): void {
  try {
    writeAlertLog(group, overflow, suppression, emittedAt, environment, writer);
  } catch {
    reportAlertDiagnostic("api-next alert log unavailable");
  }
}

/**
 * Runs `body` with an `AlertCollector` that buffers emits, then — in a scope
 * finalizer — aggregates the buffer and persists one structured Workers Logs
 * event per group. The finalizer runs on every exit (success, expected failure,
 * interruption), so alerts emitted before an interruption are never lost.
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
          const emittedAt = new Date(nowMs).toISOString();
          const environment = safeCorrelationValue(sink.environment) ?? "unknown";
          const suppression = ledger.suppression;
          const log: (event: string, fields: AlertLogFields) => void =
            options.log ??
            ((event, fields) => {
              if (sink.log !== undefined) sink.log("pipeline.alert", fields);
              else console.info(event, fields);
            });
          if (suppression === undefined) {
            for (const group of digest.groups) {
              safelyWriteAlertLog(
                group,
                digest.overflow,
                "transition",
                emittedAt,
                environment,
                log,
              );
            }
          } else {
            for (const group of digest.groups) {
              const previous = yield* suppression.get(group.dedupeKey).pipe(
                Effect.catchCause(() =>
                  Effect.sync(() => {
                    reportAlertDiagnostic("api-next alert suppression read unavailable");
                    return null;
                  }),
                ),
              );
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
                safelyWriteAlertLog(
                  group,
                  digest.overflow,
                  decision.reason,
                  emittedAt,
                  environment,
                  log,
                );
              }
              yield* suppression.put(decision.state).pipe(
                Effect.catchCause(() =>
                  Effect.sync(() => {
                    reportAlertDiagnostic("api-next alert suppression write unavailable");
                  }),
                ),
              );
            }
          }
        }).pipe(
          Effect.catchCause(() =>
            Effect.sync(() => {
              reportAlertDiagnostic("api-next alert finalizer unavailable");
            }),
          ),
        ),
      );
      return yield* Effect.provide(body, collector) as EffectType.Effect<A, E, R>;
    }),
  ) as EffectType.Effect<A, E, Exclude<R, AlertCollector>>;
}
