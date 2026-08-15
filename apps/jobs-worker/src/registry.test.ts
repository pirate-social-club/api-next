import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import {
  buildJobRegistry,
  defaultRetrySchedule,
  type JobDeclaration,
  RegistryConfigurationError,
  type TableKey,
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
  writes: ["control-plane:job_attempts"],
  run: Effect.void,
};

const errorOf = async (jobs: readonly JobDeclaration[], legacy: readonly TableKey[] = []) =>
  Effect.runPromise(Effect.flip(buildJobRegistry(jobs, legacy)));

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
      key: "control-plane:job_attempts",
    });
  });

  test("rejects a table still written by the old scheduler inventory", async () => {
    const error = await errorOf([baseJob], ["control-plane:job_attempts"]);
    expect(error).toMatchObject({ reason: "legacy-table-writer" });
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
});
