import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  buildJobRegistry,
  defaultRetrySchedule,
  groupDueJobsByLane,
  isScheduleDue,
  type JobDeclaration,
  RegistryConfigurationError,
  selectDueJobs,
} from "./registry";

const baseJob: JobDeclaration = {
  name: "control-plane.probe",
  lane: "control-plane-probe",
  schedule: "*/5 * * * *",
  timeout: "5 seconds",
  retry: defaultRetrySchedule,
  expectedFailures: ["ProviderUnavailable"],
  severity: {
    expectedFailure: { ProviderUnavailable: "medium" },
    timeout: "high",
    transactionOutcomeUnknown: "high",
    defect: "high",
  },
  reads: ["postgres:communities"],
  writes: ["postgres:job_attempts"],
  run: Effect.void,
};

const errorOf = async (jobs: readonly JobDeclaration[]) =>
  Effect.runPromise(Effect.flip(buildJobRegistry(jobs)));

describe("jobs-kernel declaration registry", () => {
  test("keeps complete declarations as data and builds a name index", async () => {
    const registry = await Effect.runPromise(buildJobRegistry([baseJob]));
    expect(registry.declarations).toEqual([baseJob]);
    expect(registry.byName.get(baseJob.name)).toBe(baseJob);
  });

  test("rejects two active writers for the same table before startup", async () => {
    const error = await errorOf([
      baseJob,
      {
        ...baseJob,
        name: "control-plane.other",
        lane: "control-plane-other",
      },
    ]);
    expect(error).toBeInstanceOf(RegistryConfigurationError);
    expect(error).toMatchObject({
      reason: "duplicate-table-writer",
      key: "postgres:job_attempts",
    });
  });

  test("rejects ambiguous lane/name ownership and missing failure severity", async () => {
    const duplicateName = await errorOf([
      baseJob,
      { ...baseJob, lane: "control-plane-other", writes: [], expectedFailures: [] },
    ]);
    expect(duplicateName).toMatchObject({ reason: "duplicate-job-name" });

    const missingSeverity = await errorOf([
      {
        ...baseJob,
        name: "control-plane.other",
        lane: "control-plane-other",
        severity: {
          ...baseJob.severity,
          expectedFailure: {},
        },
      },
    ]);
    expect(missingSeverity).toMatchObject({ reason: "missing-severity-mapping" });
  });

  test("rejects duplicate table declarations in the read inventory", async () => {
    const error = await errorOf([
      {
        ...baseJob,
        name: "control-plane.read-duplicate",
        lane: "control-plane-read-duplicate",
        reads: ["postgres:communities", "postgres:communities"],
        writes: [],
      },
    ]);
    expect(error).toMatchObject({ reason: "duplicate-table-read" });
  });

  test("rejects retired D1 table-key families after narrowing to Postgres", async () => {
    for (const tableKey of ["control-plane:communities", "community-shard:community-a"]) {
      const error = await errorOf([
        {
          ...baseJob,
          name: `retired.${tableKey}`,
          lane: `retired-${tableKey}`,
          reads: [tableKey] as never,
          writes: [],
        },
      ]);
      expect(error).toMatchObject({ reason: "invalid-table-key", key: tableKey });
    }
  });

  test("allows sequential jobs in one lane and selects only due schedules", async () => {
    const secondJob: JobDeclaration = {
      ...baseJob,
      name: "control-plane.hourly",
      schedule: "0 * * * *",
      reads: ["postgres:communities"],
      writes: [],
    };
    const registry = await Effect.runPromise(buildJobRegistry([baseJob, secondJob]));
    const atFivePast = Date.UTC(2026, 7, 16, 0, 5);

    expect(registry.declarations).toHaveLength(2);
    expect(isScheduleDue(baseJob.schedule, atFivePast)).toBe(true);
    expect(isScheduleDue(secondJob.schedule, atFivePast)).toBe(false);
    expect(selectDueJobs(registry, atFivePast).map((job) => job.name)).toEqual([baseJob.name]);

    const atTheHour = Date.UTC(2026, 7, 16, 1, 0);
    expect(
      groupDueJobsByLane(registry, atTheHour)
        .get(baseJob.lane)
        ?.map((job) => job.name),
    ).toEqual([baseJob.name, secondJob.name]);
  });

  test("rejects malformed cron declarations", async () => {
    const error = await errorOf([{ ...baseJob, schedule: "not-a-cron" }]);
    expect(error).toMatchObject({ reason: "invalid-schedule" });
  });
});
