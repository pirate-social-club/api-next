import { Predicate, Schema } from "effect";
import type { Client } from "pg";
import type { RewardOperationsPlan } from "./reward-operations-plan.ts";
import { RewardOperationsRefusal } from "./reward-operations-report.ts";
import { boundedRewardOperation, readWithBoundedRetry } from "./reward-operations-worker-client.ts";

const Id = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/u));
const Name = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_.-]{1,128}$/u));
const RoleTarget = Schema.Struct({
  id: Id,
  host: Name,
  port: Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,4}$/u)),
  database: Name,
  login: Name,
  sqlRole: Name,
});
export const RewardDatabaseTargetSchema = Schema.Struct({
  organization: Id,
  databaseName: Id,
  databaseId: Id,
  branchName: Id,
  branchId: Id,
  operator: RoleTarget,
  runtime: Schema.Struct({ http: RoleTarget, jobs: RoleTarget }),
});
export type RewardDatabaseTargetDependencies = {
  provider(path: string, page: number | undefined, signal: AbortSignal): Promise<unknown>;
  hyperdrive(id: string, signal: AbortSignal): Promise<unknown>;
  now?: () => number;
};

const Database = Schema.Struct({ id: Id, name: Id, kind: Schema.Literal("postgresql") });
const Branch = Schema.Struct({
  id: Id,
  name: Id,
  kind: Schema.Literal("postgresql"),
  ready: Schema.Literal(true),
  state: Schema.Literal("ready"),
  expires_at: Schema.optional(Schema.Unknown),
  deleted_at: Schema.optional(Schema.Unknown),
});
const Role = Schema.Struct({
  id: Id,
  username: Name,
  access_host_url: Name,
  database_name: Name,
  base_username: Name,
  branch: Schema.Struct({ id: Id }),
  expired: Schema.Literal(false),
  expires_at: Schema.optional(Schema.Unknown),
  deleted_at: Schema.optional(Schema.Unknown),
  disabled_at: Schema.optional(Schema.Unknown),
  dropped_at: Schema.optional(Schema.Unknown),
});
const Page = Schema.Struct({
  data: Schema.Array(Schema.Unknown),
  current_page: Schema.Number,
  next_page: Schema.Unknown,
});
const Hyperdrive = Schema.Struct({
  id: Schema.String,
  origin: Schema.Struct({
    host: Schema.String,
    port: Schema.Number,
    database: Schema.String,
    user: Schema.String,
  }),
});

/** Fresh authenticated provider calls only. This factory never consumes evidence JSON. */
export function createRewardDatabaseTargetCollector(input: {
  hyperdrive: RewardDatabaseTargetDependencies["hyperdrive"];
  command?: (
    args: readonly string[],
    signal: AbortSignal,
  ) => Promise<{ stdout: string; exitCode: number }>;
}): RewardDatabaseTargetDependencies {
  return {
    hyperdrive: input.hyperdrive,
    async provider(path, page, signal) {
      if (
        !/^organizations\/[a-zA-Z0-9_-]+\/databases\/[a-zA-Z0-9_-]+(?:\/branches\/[a-zA-Z0-9_-]+(?:\/roles)?)?$/u.test(
          path,
        )
      )
        throw new RewardOperationsRefusal("database-target");
      return readWithBoundedRetry(async () => {
        const args = [
          "api",
          path,
          "--method",
          "GET",
          "--api-url",
          "https://api.planetscale.com/",
          ...(page === undefined ? [] : ["--query", `page=${page}`]),
        ];
        let result: { stdout: string; exitCode: number };
        if (input.command)
          result = await boundedRewardOperation(input.command(args, signal), signal);
        else {
          if (signal.aborted) throw new RewardOperationsRefusal("deadline");
          const proc = Bun.spawn(["pscale", ...args], {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "ignore",
          });
          const cancel = () => proc.kill("SIGKILL");
          signal.addEventListener("abort", cancel, { once: true });
          if (signal.aborted) cancel();
          try {
            const [stdout, exitCode] = await boundedRewardOperation(
              Promise.all([new Response(proc.stdout).text(), proc.exited]),
              signal,
            );
            result = { stdout, exitCode };
          } finally {
            signal.removeEventListener("abort", cancel);
          }
        }
        if (result.exitCode !== 0 || result.stdout.length > 2_000_000)
          throw new RewardOperationsRefusal("provider");
        try {
          return JSON.parse(result.stdout) as unknown;
        } catch {
          throw new RewardOperationsRefusal("provider");
        }
      }, signal);
    },
  };
}

export function assertRewardDatabaseConnectionTarget(
  plan: RewardOperationsPlan,
  privateUrl: string,
) {
  try {
    const target = plan.databaseTarget;
    const url = new URL(privateUrl);
    const parameters = [...url.searchParams.entries()];
    if (
      !target ||
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      url.hash ||
      !url.password ||
      url.hostname !== target.operator.host ||
      (url.port || "5432") !== target.operator.port ||
      decodeURIComponent(url.pathname) !== `/${target.operator.database}` ||
      decodeURIComponent(url.username) !== target.operator.login ||
      url.searchParams.get("sslmode") !== "verify-full" ||
      new Set(parameters.map(([key]) => key)).size !== parameters.length ||
      parameters.some(
        ([key, value]) =>
          !(key === "sslmode" && value === "verify-full") &&
          !(key === "sslrootcert" && value === "system"),
      )
    )
      throw new RewardOperationsRefusal("database-target");
  } catch {
    throw new RewardOperationsRefusal("database-target");
  }
}

export async function verifyRewardDatabaseTarget(
  plan: RewardOperationsPlan,
  privateUrl: string,
  db: Client,
  dependencies: RewardDatabaseTargetDependencies,
  signal: AbortSignal,
) {
  try {
    assertRewardDatabaseConnectionTarget(plan, privateUrl);
    const target = plan.databaseTarget;
    const base = `organizations/${target.organization}/databases/${target.databaseName}`;
    const database = Schema.decodeUnknownSync(Database)(
      await boundedRewardOperation(dependencies.provider(base, undefined, signal), signal),
    );
    const branch = Schema.decodeUnknownSync(Branch)(
      await boundedRewardOperation(
        dependencies.provider(`${base}/branches/${target.branchName}`, undefined, signal),
        signal,
      ),
    );
    const now = (dependencies.now ?? Date.now)();
    const validExpiry = (value: unknown) =>
      value == null ||
      (Predicate.isString(value) &&
        Date.parse(value) >= Date.parse(plan.expiresAt) &&
        Date.parse(value) > now);
    if (
      database.id !== target.databaseId ||
      database.name !== target.databaseName ||
      branch.id !== target.branchId ||
      branch.name !== target.branchName ||
      branch.deleted_at != null ||
      !validExpiry(branch.expires_at)
    )
      throw new RewardOperationsRefusal("database-target");
    const roles: unknown[] = [];
    let complete = false;
    for (let page = 1; page <= 20; page++) {
      const result = Schema.decodeUnknownSync(Page)(
        await boundedRewardOperation(
          dependencies.provider(`${base}/branches/${target.branchName}/roles`, page, signal),
          signal,
        ),
      );
      if (
        result.current_page !== page ||
        !(result.next_page === null || result.next_page === page + 1)
      )
        throw new RewardOperationsRefusal("database-target");
      roles.push(...result.data);
      if (result.next_page === null) {
        complete = true;
        break;
      }
    }
    if (!complete) throw new RewardOperationsRefusal("database-target");
    const matchRole = (expected: typeof RoleTarget.Type) => {
      const matches = roles.filter(
        (role) => Predicate.isObject(role) && Reflect.get(role, "id") === expected.id,
      );
      if (matches.length !== 1) throw new RewardOperationsRefusal("database-target");
      const role = Schema.decodeUnknownSync(Role)(matches[0]);
      if (
        role.branch.id !== target.branchId ||
        role.username !== expected.login ||
        role.base_username !== expected.sqlRole ||
        role.access_host_url !== expected.host ||
        role.database_name !== expected.database ||
        role.deleted_at != null ||
        role.disabled_at != null ||
        role.dropped_at != null ||
        !validExpiry(role.expires_at)
      )
        throw new RewardOperationsRefusal("database-target");
    };
    matchRole(target.operator);
    for (const label of ["http", "jobs"] as const) {
      const runtime = target.runtime[label];
      if (runtime.id === target.operator.id || runtime.sqlRole === target.operator.sqlRole)
        throw new RewardOperationsRefusal("database-target");
      matchRole(runtime);
      const worker = plan.workers[label];
      const binding = worker.baseline.bindings.find(
        (item) => item.name === "CONTROL_PLANE" && item.type === "hyperdrive",
      );
      if (binding?.id !== worker.hyperdriveId) throw new RewardOperationsRefusal("database-target");
      const hyperdrive = Schema.decodeUnknownSync(Hyperdrive)(
        await boundedRewardOperation(dependencies.hyperdrive(worker.hyperdriveId, signal), signal),
      );
      if (
        hyperdrive.id !== worker.hyperdriveId ||
        hyperdrive.origin.host !== runtime.host ||
        String(hyperdrive.origin.port) !== runtime.port ||
        hyperdrive.origin.database !== runtime.database ||
        hyperdrive.origin.user !== runtime.login
      )
        throw new RewardOperationsRefusal("database-target");
    }
    const identity = await boundedRewardOperation(
      db.query(
        "SELECT current_database() AS database,session_user AS login,current_user AS active",
      ),
      signal,
    );
    if (
      identity.rows.length !== 1 ||
      identity.rows[0]?.database !== target.operator.database ||
      identity.rows[0]?.login !== target.operator.sqlRole ||
      identity.rows[0]?.active !== target.operator.sqlRole
    )
      throw new RewardOperationsRefusal("database-target");
  } catch (error) {
    throw error instanceof RewardOperationsRefusal
      ? error
      : new RewardOperationsRefusal("database-target");
  }
}
