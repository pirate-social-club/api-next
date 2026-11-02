import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  buildJobRegistry,
  defaultRetrySchedule,
  groupDueJobsByLane,
  isScheduleDue,
  type JobDeclaration,
  RegistryConfigurationError,
  SHARED_TABLE_WRITERS,
  type SharedTableWriters,
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

describe("partitioned shared table writers", () => {
  const writer = (name: string, writes: JobDeclaration["writes"]): JobDeclaration => ({
    ...baseJob,
    name,
    lane: name,
    writes,
  });
  const bindings = "postgres:community_canonical_route_bindings" as const;
  const saleCurrent = "postgres:community_handle_sale_namespace_activation_current" as const;

  test("admits the listed writers of distinct row families on their listed tables", async () => {
    const registry = await Effect.runPromise(
      buildJobRegistry([
        writer("hns-active-lease-renewal.poll", [bindings, saleCurrent]),
        writer("spaces-native.route-renewal", [bindings]),
        writer("spaces-native.root-observation", [saleCurrent]),
      ]),
    );
    expect(registry.declarations).toHaveLength(3);
  });

  test("the shipped list gives every shared table one writer per family", () => {
    for (const [table, listed] of Object.entries(SHARED_TABLE_WRITERS)) {
      const partitions = Object.values(listed ?? {});
      expect({ table, size: new Set(partitions).size }).toEqual({
        table,
        size: partitions.length,
      });
      expect(partitions.length).toBeGreaterThan(1);
    }
  });

  test("rejects a third writer whose family is already taken, in every order", async () => {
    const three: SharedTableWriters = { [bindings]: { a: "hns", b: "spaces", c: "hns" } };
    const orders = [
      ["a", "b", "c"],
      ["a", "c", "b"],
      ["b", "a", "c"],
      ["b", "c", "a"],
      ["c", "a", "b"],
      ["c", "b", "a"],
    ];
    for (const order of orders) {
      const error = await Effect.runPromise(
        Effect.flip(
          buildJobRegistry(
            order.map((name) => writer(name, [bindings])),
            three,
          ),
        ),
      );
      expect(error).toMatchObject({ reason: "duplicate-table-writer", key: bindings });
    }
  });

  test("rejects two writers in the same partition even when both are listed", async () => {
    const sameFamily: SharedTableWriters = {
      [bindings]: { "hns.first": "hns", "hns.second": "hns" },
    };
    const error = await Effect.runPromise(
      Effect.flip(
        buildJobRegistry(
          [writer("hns.first", [bindings]), writer("hns.second", [bindings])],
          sameFamily,
        ),
      ),
    );
    expect(error).toMatchObject({ reason: "duplicate-table-writer", key: bindings });
  });

  test("rejects an unlisted writer on a listed table, in either order", async () => {
    const listed = writer("hns-active-lease-renewal.poll", [bindings]);
    const unlisted = writer("hns-route-revalidation.poll", [bindings]);
    for (const jobs of [
      [listed, unlisted],
      [unlisted, listed],
    ]) {
      expect(await errorOf(jobs)).toMatchObject({
        reason: "duplicate-table-writer",
        key: bindings,
      });
    }
  });

  test("rejects a listed name on a table it is not listed for", async () => {
    // Route renewal is listed for bindings, never for sale-namespace activations.
    for (const jobs of [
      [
        writer("hns-active-lease-renewal.poll", [saleCurrent]),
        writer("spaces-native.route-renewal", [saleCurrent]),
      ],
      [
        writer("spaces-native.root-observation", [bindings]),
        writer("hns-active-lease-renewal.poll", [bindings]),
      ],
      [writer("spaces-native.route-renewal", ["postgres:job_attempts"]), baseJob],
    ]) {
      expect(await errorOf(jobs)).toMatchObject({ reason: "duplicate-table-writer" });
    }
  });

  test("rejects one declaration listing a shared table twice", async () => {
    const error = await errorOf([writer("spaces-native.route-renewal", [bindings, bindings])]);
    expect(error).toMatchObject({ reason: "duplicate-table-writer", key: bindings });
  });
});
