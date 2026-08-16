import type { AlertSeverity } from "@pirate/application";
import type { AlertSink, FencedLeaseRecord } from "@pirate/platform-cf";
import { Context, Data, type Duration, Effect, Schedule } from "effect";

export type TableKey = `postgres:${string}`;

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
  | "duplicate-table-writer"
  | "duplicate-table-read"
  | "invalid-table-key"
  | "invalid-schedule"
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

interface ParsedCronSchedule {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  readonly daysOfMonthWildcard: boolean;
  readonly daysOfWeekWildcard: boolean;
}

function parseCronField(value: string, minimum: number, maximum: number): Set<number> | null {
  const result = new Set<number>();
  for (const part of value.split(",")) {
    const pieces = part.split("/");
    if (pieces.length > 2) return null;
    const base = pieces[0];
    if (base === undefined || base.length === 0) return null;
    const step = pieces[1] === undefined ? 1 : Number(pieces[1]);
    if (!Number.isInteger(step) || step < 1) return null;

    let start = minimum;
    let end = maximum;
    if (base !== "*") {
      const range = base.split("-");
      if (range.length === 1) {
        start = Number(range[0]);
        end = start;
      } else if (range.length === 2) {
        start = Number(range[0]);
        end = Number(range[1]);
      } else {
        return null;
      }
    }
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < minimum ||
      end > maximum ||
      start > end
    )
      return null;
    for (let current = start; current <= end; current += step) result.add(current);
  }
  return result.size === 0 ? null : result;
}

function parseCronSchedule(schedule: string): ParsedCronSchedule | null {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (minute === undefined || hour === undefined || dayOfMonth === undefined) return null;
  if (month === undefined || dayOfWeek === undefined) return null;
  const minutes = parseCronField(minute, 0, 59);
  const hours = parseCronField(hour, 0, 23);
  const daysOfMonth = parseCronField(dayOfMonth, 1, 31);
  const months = parseCronField(month, 1, 12);
  const daysOfWeek = parseCronField(dayOfWeek, 0, 7);
  if (minutes === null || hours === null || daysOfMonth === null) return null;
  if (months === null || daysOfWeek === null) return null;
  if (daysOfWeek.has(7)) daysOfWeek.add(0);
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    daysOfMonthWildcard: dayOfMonth === "*",
    daysOfWeekWildcard: dayOfWeek === "*",
  };
}

/** Returns whether a five-field UTC cron schedule is due at `now`. */
export function isScheduleDue(schedule: string, now: number): boolean {
  const parsed = parseCronSchedule(schedule);
  if (parsed === null) return false;
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) return false;
  const dayOfMonthMatches = parsed.daysOfMonth.has(date.getUTCDate());
  const dayOfWeekMatches = parsed.daysOfWeek.has(date.getUTCDay());
  const dayMatches =
    parsed.daysOfMonthWildcard || parsed.daysOfWeekWildcard
      ? dayOfMonthMatches && dayOfWeekMatches
      : dayOfMonthMatches || dayOfWeekMatches;
  return (
    parsed.minutes.has(date.getUTCMinutes()) &&
    parsed.hours.has(date.getUTCHours()) &&
    parsed.months.has(date.getUTCMonth() + 1) &&
    dayMatches
  );
}

function invalid(reason: RegistryConfigurationReason, key: string) {
  return Effect.fail(new RegistryConfigurationError({ reason, key }));
}

function isTableKey(value: string): value is TableKey {
  return /^postgres:[^:]+$/.test(value);
}

/**
 * Validates the complete writer inventory before a scheduler is registered.
 * This is the enforcement point for one-writing-scheduler-per-table.
 */
export function buildJobRegistry<Failure = unknown, Requirements = never>(
  declarations: readonly JobDeclaration<Failure, Requirements>[],
): Effect.Effect<JobRegistry<Failure, Requirements>, RegistryConfigurationError> {
  const names = new Set<string>();
  const writers = new Map<string, string>();

  for (const declaration of declarations) {
    if (
      declaration.name.length === 0 ||
      declaration.lane.length === 0 ||
      declaration.schedule.length === 0
    ) {
      return invalid("missing-required-field", declaration.name || declaration.lane);
    }
    if (names.has(declaration.name)) return invalid("duplicate-job-name", declaration.name);
    names.add(declaration.name);
    if (parseCronSchedule(declaration.schedule) === null) {
      return invalid("invalid-schedule", declaration.schedule);
    }

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

/** Selects only declarations whose schedule is due in the current UTC tick. */
export function selectDueJobs<Failure = unknown, Requirements = never>(
  registry: JobRegistry<Failure, Requirements>,
  now: number,
): readonly JobDeclaration<Failure, Requirements>[] {
  return registry.declarations.filter((job) => isScheduleDue(job.schedule, now));
}

/** Groups due declarations by lane; declaration order is the execution order. */
export function groupDueJobsByLane<Failure = unknown, Requirements = never>(
  registry: JobRegistry<Failure, Requirements>,
  now: number,
): ReadonlyMap<string, readonly JobDeclaration<Failure, Requirements>[]> {
  const grouped = new Map<string, JobDeclaration<Failure, Requirements>[]>();
  for (const job of selectDueJobs(registry, now)) {
    const lane = grouped.get(job.lane);
    if (lane === undefined) grouped.set(job.lane, [job]);
    else lane.push(job);
  }
  return grouped;
}
