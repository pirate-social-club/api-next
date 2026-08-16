import type { AlertSeverity } from "@pirate/application";
import type { AlertSink, FencedLeaseRecord } from "@pirate/platform-cf";
import { Context, Data, type Duration, Effect, Schedule } from "effect";

export type TableKey = `control-plane:${string}` | `community-shard:${string}`;

export interface JobRuntimeContext {
  readonly owner: string;
  readonly attemptId: string;
  readonly lease: () => FencedLeaseRecord;
  readonly adapterSafety: {
    readonly markAbortedOrFenced: () => void;
    readonly isProven: () => boolean;
  };
}

/** Runtime values are supplied by the generic runner, never by a job module. */
export class JobContext extends Context.Service<JobContext, JobRuntimeContext>()(
  "api-next/jobs/JobContext",
) {}

export interface SeverityMapping {
  readonly expectedFailure: Readonly<Record<string, AlertSeverity>>;
  readonly timeout: AlertSeverity;
  readonly transactionOutcomeUnknown: AlertSeverity;
  readonly defect: AlertSeverity;
}

export interface JobDeclaration<Failure = unknown, Requirements = never> {
  readonly name: string;
  readonly lane: string;
  readonly schedule: string;
  readonly timeout: Duration.Input;
  readonly retry: Schedule.Schedule<unknown, Failure, never, never>;
  readonly expectedFailures: readonly string[];
  readonly severity: SeverityMapping;
  readonly reads: readonly TableKey[];
  readonly writes: readonly TableKey[];
  readonly alertSink?: AlertSink;
  readonly requiresAdapterSafety?: boolean;
  readonly run: Effect.Effect<void, Failure, JobContext | Requirements>;
}

export type RegistryConfigurationReason =
  | "duplicate-job-name"
  | "duplicate-lane"
  | "duplicate-table-writer"
  | "duplicate-table-read"
  | "legacy-table-writer"
  | "invalid-table-key"
  | "missing-severity-mapping"
  | "missing-required-field"
  | "invalid-retry-schedule";

export class RegistryConfigurationError extends Data.TaggedError("RegistryConfigurationError")<{
  readonly reason: RegistryConfigurationReason;
  readonly key: string;
}> {}

export interface JobRegistry<Failure = unknown, Requirements = never> {
  readonly declarations: readonly JobDeclaration<Failure, Requirements>[];
  readonly byName: ReadonlyMap<string, JobDeclaration<Failure, Requirements>>;
}

/** Shared bounded jittered retry schedule; the runner filters by failure tag. */
export const defaultRetrySchedule = Schedule.exponential("5 seconds").pipe(
  Schedule.jittered,
  Schedule.upTo({ times: 3 }),
);

function invalid(reason: RegistryConfigurationReason, key: string) {
  return Effect.fail(new RegistryConfigurationError({ reason, key }));
}

function isTableKey(value: string): value is TableKey {
  return /^(control-plane|community-shard):[^:]+$/.test(value);
}

/**
 * Validates the complete writer inventory before a scheduler is registered.
 * This is the enforcement point for one-writing-scheduler-per-table.
 */
export function buildJobRegistry<Failure = unknown, Requirements = never>(
  declarations: readonly JobDeclaration<Failure, Requirements>[],
  liveLegacyWriters: readonly TableKey[] = [],
): Effect.Effect<JobRegistry<Failure, Requirements>, RegistryConfigurationError> {
  const names = new Set<string>();
  const lanes = new Set<string>();
  const writers = new Map<string, string>();
  const legacy = new Set(liveLegacyWriters);

  for (const declaration of declarations) {
    if (
      declaration.name.length === 0 ||
      declaration.lane.length === 0 ||
      declaration.schedule.length === 0
    ) {
      return invalid("missing-required-field", declaration.name || declaration.lane);
    }
    if (names.has(declaration.name)) return invalid("duplicate-job-name", declaration.name);
    if (lanes.has(declaration.lane)) return invalid("duplicate-lane", declaration.lane);
    names.add(declaration.name);
    lanes.add(declaration.lane);

    if (!Schedule.isSchedule(declaration.retry)) {
      return invalid("invalid-retry-schedule", declaration.name);
    }

    const mappedFailures = new Set<string>();
    for (const expectedFailure of declaration.expectedFailures) {
      if (mappedFailures.has(expectedFailure)) {
        return invalid("missing-severity-mapping", expectedFailure);
      }
      mappedFailures.add(expectedFailure);
      if (declaration.severity.expectedFailure[expectedFailure] === undefined) {
        return invalid("missing-severity-mapping", expectedFailure);
      }
    }

    for (const table of declaration.writes) {
      if (!isTableKey(table)) return invalid("invalid-table-key", table);
      if (legacy.has(table)) return invalid("legacy-table-writer", table);
      const previous = writers.get(table);
      if (previous !== undefined) return invalid("duplicate-table-writer", table);
      writers.set(table, declaration.name);
    }
    const declaredReads = new Set<string>();
    for (const table of declaration.reads) {
      if (!isTableKey(table)) return invalid("invalid-table-key", table);
      if (declaredReads.has(table)) return invalid("duplicate-table-read", table);
      declaredReads.add(table);
    }
  }

  const byName = new Map(declarations.map((declaration) => [declaration.name, declaration]));
  return Effect.succeed({ declarations, byName });
}
