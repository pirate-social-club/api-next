import { expect, test } from "bun:test";
import type { Client } from "pg";
import {
  createRewardDatabaseTargetCollector,
  type RewardDatabaseTargetDependencies,
  verifyRewardDatabaseTarget,
} from "./reward-operations-database-target.ts";
import { rewardPlanFixture } from "./reward-operations-test-fixture.ts";

function fixture() {
  const plan = rewardPlanFixture();
  const target = plan.databaseTarget;
  const calls: string[] = [];
  let sqlReads = 0;
  const roles = [target.operator, target.runtime.http].map((role) => ({
    id: role.id,
    username: role.login,
    access_host_url: role.host,
    database_name: role.database,
    base_username: role.sqlRole,
    branch: { id: target.branchId },
    expired: false,
  }));
  const dependencies: RewardDatabaseTargetDependencies = {
    now: () => Date.parse("2026-10-03T12:00:00Z"),
    async provider(path, page) {
      calls.push(`${path}:${page ?? ""}`);
      if (path.endsWith("/roles")) return { data: roles, current_page: page, next_page: null };
      if (path.includes("/branches/"))
        return {
          id: target.branchId,
          name: target.branchName,
          kind: "postgresql",
          ready: true,
          state: "ready",
        };
      return { id: target.databaseId, name: target.databaseName, kind: "postgresql" };
    },
    async hyperdrive(id) {
      return {
        id,
        origin: {
          host: target.runtime.http.host,
          port: 5432,
          database: target.runtime.http.database,
          user: target.runtime.http.login,
        },
      };
    },
  };
  const db = {
    query: async () => {
      sqlReads++;
      return { rows: [{ database: "postgres", login: "operator", active: "operator" }] };
    },
  } as unknown as Client;
  return {
    plan,
    dependencies,
    db,
    roles,
    calls,
    sqlReads: () => sqlReads,
    url: "postgresql://operator-login:private@operator.fixture/postgres?sslmode=verify-full",
  };
}

test("fresh provider and Hyperdrive facts bind the very guard client; no secret evidence is returned", async () => {
  const run = fixture();
  await expect(
    verifyRewardDatabaseTarget(
      run.plan,
      run.url,
      run.db,
      run.dependencies,
      new AbortController().signal,
    ),
  ).resolves.toBeUndefined();
  expect(run.sqlReads()).toBe(1);
  expect(run.calls).toHaveLength(3);
});

test("wrong URL, stale branch/role, wrong Hyperdrive origin or SQL role refuses", async () => {
  for (const kind of ["url", "branch", "role", "hyperdrive", "sql"] as const) {
    const run = fixture();
    const firstRole = run.roles[0];
    if (!firstRole) throw Error("missing role fixture");
    let url = run.url;
    if (kind === "url") url = url.replace("operator.fixture", "staging.fixture");
    if (kind === "branch") {
      const original = run.dependencies.provider;
      run.dependencies.provider = async (path, page, signal) =>
        path.endsWith("/main")
          ? { id: "wrong", name: "main", kind: "postgresql", ready: true, state: "ready" }
          : original(path, page, signal);
    }
    if (kind === "role") firstRole.expired = true;
    if (kind === "hyperdrive")
      run.dependencies.hyperdrive = async (id) => ({
        id,
        origin: { host: "wrong.fixture", port: 5432, database: "postgres", user: "runtime-login" },
      });
    if (kind === "sql")
      run.db = {
        query: async () => ({
          rows: [{ database: "postgres", login: "runtime", active: "runtime" }],
        }),
      } as unknown as Client;
    await expect(
      verifyRewardDatabaseTarget(
        run.plan,
        url,
        run.db,
        run.dependencies,
        new AbortController().signal,
      ),
    ).rejects.toThrow("database-target");
  }
});

test("production target cannot use staging URL; missing, duplicated or wrong-branch roles refuse before SQL", async () => {
  for (const kind of ["production", "missing", "duplicate", "wrong-branch"] as const) {
    const run = fixture();
    const firstRole = run.roles[0];
    if (!firstRole) throw Error("missing role fixture");
    let plan = run.plan;
    if (kind === "production")
      plan = {
        ...plan,
        environment: "production",
        databaseTarget: {
          ...plan.databaseTarget,
          databaseId: "production-database-id",
          operator: { ...plan.databaseTarget.operator, host: "production.fixture" },
        },
      };
    if (kind === "missing") run.roles.shift();
    if (kind === "duplicate") run.roles.push(structuredClone(firstRole));
    if (kind === "wrong-branch") firstRole.branch.id = "restored-other-branch";
    await expect(
      verifyRewardDatabaseTarget(
        plan,
        run.url,
        run.db,
        run.dependencies,
        new AbortController().signal,
      ),
    ).rejects.toThrow("database-target");
    expect(run.sqlReads()).toBe(0);
  }
});

test("session and current role must both match the direct operator on the same client", async () => {
  for (const [login, active] of [
    ["runtime", "operator"],
    ["operator", "runtime"],
  ]) {
    const run = fixture();
    run.db = {
      query: async () => ({ rows: [{ database: "postgres", login, active }] }),
    } as unknown as Client;
    await expect(
      verifyRewardDatabaseTarget(
        run.plan,
        run.url,
        run.db,
        run.dependencies,
        new AbortController().signal,
      ),
    ).rejects.toThrow("database-target");
  }
});

test("expired role, incomplete pagination and wrong Hyperdrive login refuse", async () => {
  for (const kind of ["expiry", "pagination", "hyperdrive-login"] as const) {
    const run = fixture();
    if (kind === "expiry")
      Object.assign(run.roles[0] ?? {}, { expires_at: "2026-10-03T12:01:00Z" });
    if (kind === "pagination") {
      const original = run.dependencies.provider;
      run.dependencies.provider = async (path, page, signal) =>
        path.endsWith("/roles")
          ? { data: run.roles, current_page: page, next_page: (page ?? 0) + 1 }
          : original(path, page, signal);
    }
    if (kind === "hyperdrive-login")
      run.dependencies.hyperdrive = async (id) => ({
        id,
        origin: {
          host: "runtime.fixture",
          port: 5432,
          database: "postgres",
          user: "other-branch-login",
        },
      });
    await expect(
      verifyRewardDatabaseTarget(
        run.plan,
        run.url,
        run.db,
        run.dependencies,
        new AbortController().signal,
      ),
    ).rejects.toThrow("database-target");
  }
});

test("collector only issues bounded GET commands and cannot take caller evidence JSON", async () => {
  const args: readonly string[][] = [];
  const captured = args as string[][];
  const collector = createRewardDatabaseTargetCollector({
    hyperdrive: async () => ({}),
    command: async (command) => {
      captured.push([...command]);
      return { stdout: JSON.stringify({ id: "fresh" }), exitCode: 0 };
    },
  });
  expect(
    await collector.provider(
      "organizations/fixture/databases/fixture-db",
      undefined,
      new AbortController().signal,
    ),
  ).toEqual({ id: "fresh" });
  expect(captured[0]).toContain("GET");
  expect(captured[0]).not.toContain("POST");
  await expect(
    collector.provider("https://private/evidence", undefined, new AbortController().signal),
  ).rejects.toThrow();
});
