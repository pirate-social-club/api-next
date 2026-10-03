import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import type { Client } from "pg";
import {
  parseRewardOperationsCommand,
  parseRewardOperatorCommand,
  runRewardOperatorCommand,
  setRewardOperationsControl,
} from "./reward-operations-control.ts";
import { rewardPlanFixture } from "./reward-operations-test-fixture.ts";
import type { RewardWorkerClient } from "./reward-operations-worker-client.ts";

test("operator command requires explicit mode, revision and bounded reason", () => {
  expect(parseRewardOperationsCommand(["pause", "2", " incident "])).toEqual({
    state: "paused",
    expectedRevision: "2",
    reason: "incident",
  });
  expect(parseRewardOperationsCommand(["resume", "3", "rehearsal_complete"]).state).toBe("running");
  expect(parseRewardOperationsCommand(["settle", "3", "incident"]).state).toBe("settling");
  for (const args of [
    [],
    ["off", "0", "incident"],
    ["pause", "-1", "incident"],
    ["pause", "01", "incident"],
    ["pause", "0", " "],
    ["pause", "0", "x".repeat(257)],
    ["pause", "0", "incident", "extra"],
  ]) {
    expect(() => parseRewardOperationsCommand(args)).toThrow();
  }
});

test("single entrypoint preserves control forms, defaults flags to dry run and rejects a different journal argument", () => {
  expect(parseRewardOperatorCommand(["settle", "3", "incident"])).toMatchObject({
    mode: "control",
    control: { state: "settling" },
  });
  expect(parseRewardOperatorCommand(["flags", "plan.json", "lease.json"])).toEqual({
    mode: "flags",
    planPath: "plan.json",
    leasePath: "lease.json",
    execute: false,
  });
  expect(parseRewardOperatorCommand(["flags", "plan.json", "lease.json", "--execute"]).mode).toBe(
    "flags",
  );
  expect(() =>
    parseRewardOperatorCommand([
      "flags",
      "plan.json",
      "lease.json",
      "--execute",
      "different-journal",
    ]),
  ).toThrow();
  expect(() =>
    parseRewardOperatorCommand(["preflight", "plan.json", "lease.json", "--execute"]),
  ).toThrow();
});

test("CLI control report retains verified state, revision and admitted counts with sanitized cleanup diagnostics", async () => {
  let queries = 0;
  const db = Object.assign(new EventEmitter(), {
    connect: async () => {},
    end: async () => {
      throw Error("private cleanup");
    },
    query: async () => {
      if (++queries === 1) return { rows: [{ revision: "4" }] };
      if (queries === 2)
        return {
          rows: [{ state: "settling", paused: true, revision: "4", reason: "private" }],
          rowCount: 1,
        };
      return { rows: [{ effect_kind: "reward_refund", state: "confirming", effects: "1" }] };
    },
  }) as unknown as Client;
  const report = await runRewardOperatorCommand(
    parseRewardOperatorCommand(["settle", "3", "incident"]),
    {
      env: { REWARD_OPERATIONS_OPERATOR_DATABASE_URL: "postgresql://fixture" },
      database: () => db,
    },
  );
  expect(report.control).toEqual({
    state: "settling",
    paused: true,
    revision: "4",
    admitted: [{ effect_kind: "reward_refund", state: "confirming", effects: "1" }],
  });
  expect(report.ok).toBe(false);
  expect(report.cleanupFailures).toHaveLength(1);
  expect(JSON.stringify(report)).not.toContain("private");
});

test("CLI inspection derives account, environment, Worker and CONTROL_PLANE from actual tracked configs", async () => {
  for (const environment of ["staging", "production"] as const) {
    const original = rewardPlanFixture();
    const sources: Record<string, string> = {};
    const workers = { ...original.workers };
    for (const label of ["http", "jobs"] as const) {
      const path = `apps/${label}-worker/wrangler.jsonc`;
      sources[path] = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
      const config = Schema.decodeUnknownSync(
        Schema.Struct({
          account_id: Schema.String,
          env: Schema.Record(
            Schema.String,
            Schema.Struct({
              name: Schema.String,
              hyperdrive: Schema.Array(
                Schema.Struct({ binding: Schema.String, id: Schema.String }),
              ),
            }),
          ),
        }),
      )(Bun.JSONC.parse(sources[path]));
      const selected = config.env[environment];
      if (!selected) throw Error("missing tracked fixture environment");
      const binding = selected.hyperdrive.find(
        (item: { binding: string }) => item.binding === "CONTROL_PLANE",
      );
      if (!binding) throw Error("missing tracked fixture Hyperdrive");
      workers[label] = {
        ...workers[label],
        name: selected.name,
        hyperdriveId: binding.id,
        baseline: {
          ...workers[label].baseline,
          bindings: workers[label].baseline.bindings.map((item) =>
            item.name === "CONTROL_PLANE" ? { ...item, id: binding.id } : item,
          ),
        },
      };
    }
    const plan = {
      ...original,
      environment,
      accountId: Schema.decodeUnknownSync(Schema.Struct({ account_id: Schema.String }))(
        Bun.JSONC.parse(sources["apps/http-worker/wrangler.jsonc"] ?? ""),
      ).account_id,
      workers,
    };
    const client = {
      serving: async (worker: typeof plan.workers.http) => worker.baseline,
    } as unknown as RewardWorkerClient;
    const run = async (wrongAccount = false) =>
      runRewardOperatorCommand(parseRewardOperatorCommand(["inspect", "plan.json"]), {
        read: async (path) =>
          path === "plan.json"
            ? JSON.stringify({ ...plan, accountId: wrongAccount ? "c".repeat(32) : plan.accountId })
            : (sources[path] ?? ""),
        tracked: async (path) => sources[path] ?? "",
        workerClient: () => client,
      });
    expect((await run()).ok).toBe(true);
    expect((await run(true)).ok).toBe(false);
  }
});

test("CLI refuses a plan's wrong direct database URL before connecting", async () => {
  const plan = rewardPlanFixture();
  let connects = 0;
  const source = (label: "http" | "jobs") =>
    JSON.stringify({
      account_id: plan.accountId,
      env: {
        staging: {
          name: plan.workers[label].name,
          hyperdrive: [{ binding: "CONTROL_PLANE", id: plan.workers[label].hyperdriveId }],
        },
      },
    });
  const sources = {
    "apps/http-worker/wrangler.jsonc": source("http"),
    "apps/jobs-worker/wrangler.jsonc": source("jobs"),
  };
  const db = Object.assign(new EventEmitter(), {
    connect: async () => {
      connects++;
    },
    end: async () => {},
  }) as unknown as Client;
  const report = await runRewardOperatorCommand(
    parseRewardOperatorCommand(["preflight", "plan.json", "lease.json"]),
    {
      read: async (path) =>
        path === "plan.json" ? JSON.stringify(plan) : sources[path as keyof typeof sources],
      tracked: async (path) => sources[path as keyof typeof sources],
      database: () => db,
      workerClient: () => ({}) as RewardWorkerClient,
      env: {
        REWARD_OPERATIONS_OPERATOR_DATABASE_URL:
          "postgresql://operator-login:private@wrong.fixture/postgres?sslmode=verify-full",
      },
    },
  );
  expect(report.failure?.reason).toBe("database-target");
  expect(connects).toBe(0);
});

test("production execute with actual tracked configs and missing fresh provider proof creates no journal or Worker write", async () => {
  const namespace = await mkdtemp(join(tmpdir(), "rewards-cli-journal-"));
  try {
    const original = rewardPlanFixture();
    const sources: Record<string, string> = {};
    const workers = { ...original.workers };
    for (const label of ["http", "jobs"] as const) {
      const path = `apps/${label}-worker/wrangler.jsonc`;
      sources[path] = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
      const config = Schema.decodeUnknownSync(
        Schema.Struct({
          env: Schema.Struct({
            production: Schema.Struct({
              name: Schema.String,
              hyperdrive: Schema.Array(
                Schema.Struct({ binding: Schema.String, id: Schema.String }),
              ),
            }),
          }),
        }),
      )(Bun.JSONC.parse(sources[path]));
      const selected = config.env.production;
      const binding = selected.hyperdrive.find((item) => item.binding === "CONTROL_PLANE");
      if (!binding) throw Error("missing tracked fixture Hyperdrive");
      workers[label] = {
        ...workers[label],
        name: selected.name,
        hyperdriveId: binding.id,
        baseline: {
          ...workers[label].baseline,
          bindings: workers[label].baseline.bindings.map((item) =>
            item.name === "CONTROL_PLANE" ? { ...item, id: binding.id } : item,
          ),
        },
      };
    }
    const plan = {
      ...original,
      environment: "production",
      journalNamespace: namespace,
      workers,
      accountId: Schema.decodeUnknownSync(Schema.Struct({ account_id: Schema.String }))(
        Bun.JSONC.parse(sources["apps/http-worker/wrangler.jsonc"] ?? ""),
      ).account_id,
    };
    const lease = {
      schemaVersion: 1,
      reference: plan.exclusionReference,
      operationId: plan.operationId,
      accountId: plan.accountId,
      http: workers.http.name,
      jobs: workers.jobs.name,
      active: true,
      startsAt: "2026-10-03T12:00:00Z",
      expiresAt: plan.expiresAt,
    };
    let mutations = 0;
    let connects = 0;
    let providerReads = 0;
    const client: RewardWorkerClient = {
      authenticate: async () => {},
      serving: async (worker) => worker.baseline,
      versions: async (worker) => [
        { id: worker.baseline.id, message: worker.baseline.message, createdAt: 1 },
      ],
      view: async (worker) => worker.baseline,
      patch: async () => {
        mutations++;
      },
      deploy: async () => {
        mutations++;
      },
    };
    const db = Object.assign(new EventEmitter(), {
      connect: async () => {
        connects++;
      },
      end: async () => {},
      query: async () => {
        throw Error("no inventory before target proof");
      },
    }) as unknown as Client;
    const report = await runRewardOperatorCommand(
      parseRewardOperatorCommand(["flags", "plan.json", "lease.json", "--execute"]),
      {
        read: async (path) =>
          path === "plan.json"
            ? JSON.stringify(plan)
            : path === "lease.json"
              ? JSON.stringify(lease)
              : (sources[path] ?? ""),
        tracked: async (path) => sources[path] ?? "",
        database: () => db,
        workerClient: () => client,
        now: () => Date.parse("2026-10-03T12:00:00Z"),
        env: {
          REWARD_OPERATIONS_OPERATOR_DATABASE_URL:
            "postgresql://operator-login:private@operator.fixture/postgres?sslmode=verify-full",
        },
        databaseTarget: {
          provider: async () => {
            providerReads++;
            throw Error("private unavailable provider proof");
          },
          hyperdrive: async () => ({}),
        },
      },
    );
    expect(report.failure?.reason).toBe("database-target");
    expect(providerReads).toBe(1);
    expect(connects).toBe(1);
    expect(mutations).toBe(0);
    expect(await readdir(namespace)).toEqual([]);
    expect(JSON.stringify(report)).not.toContain("private");
  } finally {
    await rm(namespace, { recursive: true, force: true });
  }
});

test("a failed readback never performs a compensating resume", async () => {
  const calls: { text: string; values: readonly unknown[] | undefined }[] = [];
  const client = {
    query: async (text: string, values?: readonly unknown[]) => {
      calls.push({ text, values });
      if (calls.length === 1) return { rows: [{ revision: "2" }], rowCount: 1 };
      throw new Error("readback unavailable");
    },
  } as unknown as Client;
  await expect(
    setRewardOperationsControl(client, {
      state: "paused",
      expectedRevision: "1",
      reason: "incident",
    }),
  ).rejects.toThrow("readback unavailable");
  expect(calls).toHaveLength(2);
  expect(calls[0]?.values).toEqual(["1", true, "incident"]);
  expect(
    calls.filter((call) => call.text.includes("set_reward_operations_paused_v1")),
  ).toHaveLength(1);
});

test("database lifetime loss during external prechecks refuses safely before journal or writes", async () => {
  for (const stage of ["worker", "target"] as const) {
    for (const event of ["error", "end"] as const) {
      const namespace = await mkdtemp(join(tmpdir(), "rewards-cli-lifetime-"));
      try {
        const plan = { ...rewardPlanFixture(), journalNamespace: namespace };
        const config = (label: "http" | "jobs") =>
          JSON.stringify({
            account_id: plan.accountId,
            env: {
              staging: {
                name: plan.workers[label].name,
                hyperdrive: [{ binding: "CONTROL_PLANE", id: plan.workers[label].hyperdriveId }],
              },
            },
          });
        const db = Object.assign(new EventEmitter(), {
          connect: async () => {},
          end: async () => {
            db.emit("end");
          },
          query: async () => {
            throw Error("private unreachable inventory");
          },
        });
        let writes = 0;
        let lost = false;
        const lose = () => {
          if (!lost) {
            lost = true;
            db.emit(event, Error("private connection lost"));
          }
          return new Promise<never>(() => {});
        };
        const client: RewardWorkerClient = {
          authenticate: async () => {},
          serving: async (worker) => (stage === "worker" ? lose() : worker.baseline),
          versions: async (worker) => [
            { id: worker.baseline.id, message: worker.baseline.message, createdAt: 1 },
          ],
          view: async (worker) => worker.baseline,
          patch: async () => {
            writes++;
          },
          deploy: async () => {
            writes++;
          },
        };
        const lease = {
          schemaVersion: 1,
          reference: plan.exclusionReference,
          operationId: plan.operationId,
          accountId: plan.accountId,
          http: plan.workers.http.name,
          jobs: plan.workers.jobs.name,
          active: true,
          startsAt: "2026-10-03T12:00:00Z",
          expiresAt: plan.expiresAt,
        };
        const report = await runRewardOperatorCommand(
          parseRewardOperatorCommand(["flags", "plan.json", "lease.json", "--execute"]),
          {
            read: async (path) =>
              path === "plan.json"
                ? JSON.stringify(plan)
                : path === "lease.json"
                  ? JSON.stringify(lease)
                  : config(path.includes("http") ? "http" : "jobs"),
            tracked: async (path) => config(path.includes("http") ? "http" : "jobs"),
            database: () => db as unknown as Client,
            workerClient: () => client,
            databaseTarget: { provider: lose, hyperdrive: async () => ({}) },
            now: () => Date.parse("2026-10-03T12:00:00Z"),
            env: {
              REWARD_OPERATIONS_OPERATOR_DATABASE_URL:
                "postgresql://operator-login:private@operator.fixture/postgres?sslmode=verify-full",
            },
          },
        );
        expect(report.failure?.reason).toBe("guard-lost");
        expect(report.stage).toBe(stage === "worker" ? "worker-precheck" : "database-target");
        expect(writes).toBe(0);
        expect(await readdir(namespace)).toEqual([]);
        // A delayed error after deliberate teardown still has a safe listener.
        db.emit("error", Error("private delayed teardown"));
        expect(report.cleanupFailures).toHaveLength(1);
        expect(report.failure?.reason).toBe("guard-lost");
        expect(JSON.stringify(report)).not.toContain("private");
      } finally {
        await rm(namespace, { recursive: true, force: true });
      }
    }
  }
});

test("settling uses explicit authority and verifies state as well as the projected pause", async () => {
  for (const state of ["settling", "paused", "running"]) {
    const calls: { text: string; values: readonly unknown[] | undefined }[] = [];
    const client = {
      query: async (text: string, values?: readonly unknown[]) => {
        calls.push({ text, values });
        if (calls.length === 1) return { rows: [{ revision: "4" }], rowCount: 1 };
        if (calls.length === 2)
          return { rows: [{ state, paused: true, revision: "4" }], rowCount: 1 };
        return { rows: [{ effect_kind: "ticket_purchase", state: "confirming", effects: "1" }] };
      },
    } as unknown as Client;
    const result = setRewardOperationsControl(client, {
      state: "settling",
      expectedRevision: "3",
      reason: "incident",
    });
    if (state === "settling") {
      await expect(result).resolves.toMatchObject({
        control: { state: "settling", paused: true, revision: "4" },
        admitted: [{ effect_kind: "ticket_purchase", state: "confirming", effects: "1" }],
      });
    } else await expect(result).rejects.toThrow("readback failed");
    expect(calls[0]?.values).toEqual(["3", "settling", "incident"]);
    expect(calls[0]?.text).toContain("set_reward_operations_state_v2");
    expect(calls.filter((call) => call.text.includes("set_reward_operations_"))).toHaveLength(1);
  }
});
