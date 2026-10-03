import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Predicate, Schema } from "effect";
import { Client } from "pg";
import { normalizePostgresConnectionString } from "./postgres-connection-string.ts";
import {
  assertRewardDatabaseConnectionTarget,
  createRewardDatabaseTargetCollector,
  type RewardDatabaseTargetDependencies,
  verifyRewardDatabaseTarget,
} from "./reward-operations-database-target.ts";
import {
  createRewardOperationsJournal,
  inspectRewardFlagsOperation,
  runRewardFlagsOperation,
} from "./reward-operations-flags.ts";
import {
  assertRewardResourceExclusion,
  decodeRewardOperationsPlan,
  type RewardOperationsPlan,
} from "./reward-operations-plan.ts";
import {
  createRewardOperationsReport,
  RewardOperationsRefusal,
} from "./reward-operations-report.ts";
import {
  boundedRewardOperation,
  createRewardWorkerClient,
  type RewardWorkerClient,
} from "./reward-operations-worker-client.ts";
import {
  assertRewardsShutdownInventory,
  withRewardsShutdownLock,
} from "./rewards-binding-deploy-preflight.ts";

export type RewardOperationsCommand = {
  readonly state: "running" | "settling" | "paused";
  readonly expectedRevision: string;
  readonly reason: string;
};

export function parseRewardOperationsCommand(args: readonly string[]): RewardOperationsCommand {
  const [mode, expectedRevision, reason] = args;
  if (
    args.length !== 3 ||
    (mode !== "pause" && mode !== "resume" && mode !== "settle") ||
    expectedRevision === undefined ||
    !/^(0|[1-9][0-9]*)$/u.test(expectedRevision) ||
    reason === undefined ||
    Buffer.byteLength(reason.trim()) < 1 ||
    Buffer.byteLength(reason.trim()) > 256
  ) {
    throw new Error(
      "Usage: reward-operations-control pause|settle|resume expected_revision reason",
    );
  }
  return {
    state: mode === "pause" ? "paused" : mode === "settle" ? "settling" : "running",
    expectedRevision,
    reason: reason.trim(),
  };
}

/** No rollback to running on any failure. The database function owns the cut-over lock. */
export async function setRewardOperationsControl(client: Client, command: RewardOperationsCommand) {
  const changed = await client.query<{ revision: string }>(
    command.state === "settling"
      ? "SELECT set_reward_operations_state_v2($1::bigint,$2::text,$3::text)::text AS revision"
      : "SELECT set_reward_operations_paused_v1($1::bigint,$2::boolean,$3::text)::text AS revision",
    [
      command.expectedRevision,
      command.state === "settling" ? command.state : command.state === "paused",
      command.reason,
    ],
  );
  const control = await client.query(
    "SELECT state,paused,revision::text,reason,changed_at FROM reward_operations_control WHERE singleton",
  );
  const row = control.rows[0];
  if (
    control.rowCount !== 1 ||
    row.state !== command.state ||
    row.paused !== (command.state !== "running") ||
    row.revision !== changed.rows[0]?.revision
  ) {
    throw new Error("Reward control readback failed; inspect the control before further action");
  }
  const admitted = await client.query(
    `SELECT effect_kind,state,count(*)::text AS effects
       FROM reward_chain_effects
      WHERE nonce IS NOT NULL AND state IN
        ('nonce_reserved','prepared','broadcast_pending','confirming','reconciliation_required')
      GROUP BY effect_kind,state ORDER BY effect_kind,state`,
  );
  return { control: row, admitted: admitted.rows };
}

export type RewardOperatorCommand =
  | { mode: "control"; control: RewardOperationsCommand }
  | { mode: "inspect"; planPath: string }
  | { mode: "flags"; planPath: string; leasePath: string; execute: boolean };

export function parseRewardOperatorCommand(args: readonly string[]): RewardOperatorCommand {
  if (["pause", "resume", "settle"].includes(args[0] ?? ""))
    return { mode: "control", control: parseRewardOperationsCommand(args) };
  if (args[0] === "inspect" && args.length === 2 && args[1])
    return { mode: "inspect", planPath: args[1] };
  if (
    ["flags", "preflight"].includes(args[0] ?? "") &&
    args[1] &&
    args[2] &&
    (args.length === 3 || (args[0] === "flags" && args.length === 4 && args[3] === "--execute"))
  )
    return { mode: "flags", planPath: args[1], leasePath: args[2], execute: args.length === 4 };
  throw new RewardOperationsRefusal("invalid-plan");
}

export async function runRewardOperatorCommand(
  command: RewardOperatorCommand,
  input: {
    root?: string;
    env?: Record<string, string | undefined>;
    signal?: AbortSignal;
    read?: (path: string) => Promise<string>;
    tracked?: (path: string, signal: AbortSignal) => Promise<string>;
    database?: () => Client;
    workerClient?: (plan: RewardOperationsPlan) => RewardWorkerClient;
    databaseTarget?: RewardDatabaseTargetDependencies;
    now?: () => number;
  } = {},
) {
  const root = input.root ?? process.cwd();
  const env = input.env ?? process.env;
  const terminalSignal = AbortSignal.timeout(180_000);
  const databaseLifetime = new AbortController();
  let signal = AbortSignal.any([
    input.signal ?? new AbortController().signal,
    AbortSignal.timeout(178_000),
    databaseLifetime.signal,
  ]);
  const read = input.read ?? ((path: string) => readFile(resolve(root, path), "utf8"));
  const tracked =
    input.tracked ??
    (async (path: string, activeSignal: AbortSignal) => {
      activeSignal.throwIfAborted();
      const process = Bun.spawn(["git", "show", `HEAD:${path}`], {
        cwd: root,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      const cancel = () => process.kill("SIGKILL");
      activeSignal.addEventListener("abort", cancel, { once: true });
      try {
        const [source, code] = await boundedRewardOperation(
          Promise.all([new Response(process.stdout).text(), process.exited]),
          activeSignal,
        );
        if (code !== 0) throw new RewardOperationsRefusal("identity-drift");
        return source;
      } finally {
        activeSignal.removeEventListener("abort", cancel);
      }
    });
  let diagnostics = createRewardOperationsReport("control");
  let db: Client | undefined;
  let ending: Promise<void> | undefined;
  let teardown = false;
  const onDatabaseEnd = () => databaseLifetime.abort(new RewardOperationsRefusal("guard-lost"));
  const onDatabaseError = (error: unknown) => {
    if (teardown) diagnostics.cleanup("database-end", error);
    else onDatabaseEnd();
  };
  const end = () => {
    if (!db) return Promise.resolve();
    if (!teardown) {
      teardown = true;
      db.removeListener("end", onDatabaseEnd);
      ending = db.end();
    }
    return ending ?? Promise.resolve();
  };
  const onAbort = () => {
    void end().catch((error: unknown) => diagnostics.cleanup("database-end", error));
  };
  try {
    let plan: RewardOperationsPlan | undefined;
    let workerClient: RewardWorkerClient | undefined;
    if (command.mode !== "control") {
      const source = await boundedRewardOperation(read(command.planPath), signal);
      if (source.length > 2_000_000) throw new RewardOperationsRefusal("invalid-plan");
      try {
        plan = decodeRewardOperationsPlan(JSON.parse(source));
      } catch {
        throw new RewardOperationsRefusal("invalid-plan");
      }
      diagnostics = createRewardOperationsReport(plan.operationId);
      if (command.mode === "flags")
        signal = AbortSignal.any([
          signal,
          AbortSignal.timeout(Math.max(0, Date.parse(plan.expiresAt) - (input.now ?? Date.now)())),
        ]);
      for (const label of ["http", "jobs"] as const) {
        const path = `apps/${label}-worker/wrangler.jsonc`;
        const source = await boundedRewardOperation(read(path), signal);
        if (source !== (await tracked(path, signal)))
          throw new RewardOperationsRefusal("identity-drift");
        const config: unknown = Bun.JSONC.parse(source);
        if (!Predicate.isObject(config)) throw new RewardOperationsRefusal("identity-drift");
        const environments: unknown = Reflect.get(config, "env");
        const selected: unknown = Predicate.isObject(environments)
          ? Reflect.get(environments, plan.environment)
          : undefined;
        if (
          !Predicate.isObject(selected) ||
          Reflect.get(selected, "name") !== plan.workers[label].name ||
          (Reflect.get(selected, "account_id") ?? Reflect.get(config, "account_id")) !==
            plan.accountId
        )
          throw new RewardOperationsRefusal("identity-drift");
        const hyperdrives = Schema.decodeUnknownSync(
          Schema.Array(Schema.Struct({ binding: Schema.String, id: Schema.String })),
        )(Reflect.get(selected, "hyperdrive"));
        const matches = hyperdrives.filter((binding) => binding.binding === "CONTROL_PLANE");
        if (matches.length !== 1 || matches[0]?.id !== plan.workers[label].hyperdriveId)
          throw new RewardOperationsRefusal("database-target");
      }
      workerClient =
        input.workerClient?.(plan) ??
        createRewardWorkerClient({ root, plan, token: env.CLOUDFLARE_API_TOKEN ?? "" });
      if (command.mode === "inspect") {
        await inspectRewardFlagsOperation(plan, { client: workerClient, signal }, diagnostics);
        diagnostics.report.ok = Object.values(diagnostics.report.workers).every(
          (worker) => worker.current !== null,
        );
        diagnostics.enter("inspection");
        return diagnostics.report;
      }
    }
    diagnostics.enter("database-connect");
    if (!env.REWARD_OPERATIONS_OPERATOR_DATABASE_URL?.trim())
      throw new RewardOperationsRefusal("authentication");
    if (plan)
      assertRewardDatabaseConnectionTarget(plan, env.REWARD_OPERATIONS_OPERATOR_DATABASE_URL);
    db =
      input.database?.() ??
      new Client({
        connectionString: normalizePostgresConnectionString(
          env.REWARD_OPERATIONS_OPERATOR_DATABASE_URL,
        ),
        connectionTimeoutMillis: 5_000,
        statement_timeout: 10_000,
        application_name: "reward_operations_operator",
      });
    db.on("error", onDatabaseError);
    db.on("end", onDatabaseEnd);
    signal.addEventListener("abort", onAbort, { once: true });
    await boundedRewardOperation(db.connect(), signal);
    if (command.mode === "control") {
      diagnostics.enter("mutation");
      diagnostics.report.mutation = "attempted";
      const verified = await boundedRewardOperation(
        setRewardOperationsControl(db, command.control),
        signal,
      );
      const admitted = Schema.decodeUnknownSync(
        Schema.Array(
          Schema.Struct({
            effect_kind: Schema.Literals([
              "usdc_approval",
              "ticket_purchase",
              "winnings_claim",
              "reward_payout",
              "reward_refund",
              "gas_topup",
            ]),
            state: Schema.Literals([
              "nonce_reserved",
              "prepared",
              "broadcast_pending",
              "confirming",
              "reconciliation_required",
            ]),
            effects: Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]*)$/u)),
          }),
        ),
      )(verified.admitted);
      diagnostics.report.control = {
        state: command.control.state,
        paused: command.control.state !== "running",
        revision: Schema.decodeUnknownSync(
          Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]*)$/u)),
        )(verified.control.revision),
        admitted,
      };
      diagnostics.report.mutation = "verified";
      diagnostics.report.ok = true;
      diagnostics.enter("complete");
    } else {
      if (!plan || !workerClient) throw new RewardOperationsRefusal("invalid-plan");
      const client = db;
      let guardHeld = false;
      const collector =
        input.databaseTarget ??
        createRewardDatabaseTargetCollector({
          hyperdrive: (id, active) => {
            if (!workerClient?.hyperdrive) throw new RewardOperationsRefusal("database-target");
            return workerClient.hyperdrive(id, active);
          },
        });
      await runRewardFlagsOperation(plan, command.execute, {
        client: workerClient,
        signal,
        cleanupSignal: terminalSignal,
        diagnostics,
        now: input.now,
        guard: (operation, options) =>
          withRewardsShutdownLock(
            client,
            async (activeSignal) => {
              guardHeld = true;
              try {
                await operation(activeSignal);
              } finally {
                guardHeld = false;
              }
            },
            "api_next",
            options,
          ),
        async assertDatabaseTarget(currentPlan, activeSignal) {
          await verifyRewardDatabaseTarget(
            currentPlan,
            env.REWARD_OPERATIONS_OPERATOR_DATABASE_URL ?? "",
            client,
            collector,
            activeSignal,
          );
          if (guardHeld)
            await assertRewardsShutdownInventory(client, "api_next", {
              signal: activeSignal,
              observe(event) {
                diagnostics.enter(event.stage);
                if (
                  event.present &&
                  event.category &&
                  !diagnostics.report.blockers.includes(event.category)
                )
                  diagnostics.report.blockers.push(event.category);
              },
            });
        },
        async assertExclusion(currentPlan, activeSignal) {
          const source = await boundedRewardOperation(read(command.leasePath), activeSignal);
          if (source.length > 16_384) throw new RewardOperationsRefusal("exclusion");
          let value: unknown;
          try {
            value = JSON.parse(source);
          } catch {
            throw new RewardOperationsRefusal("exclusion");
          }
          assertRewardResourceExclusion(value, currentPlan, (input.now ?? Date.now)());
        },
        journal: command.execute
          ? createRewardOperationsJournal(plan.journalNamespace, plan.operationId)
          : undefined,
      });
    }
  } catch (error) {
    if (diagnostics.report.mutation === "attempted") diagnostics.report.mutation = "uncertain";
    diagnostics.fail(error);
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      await boundedRewardOperation(
        end(),
        AbortSignal.any([terminalSignal, AbortSignal.timeout(2_000)]),
      );
    } catch (error) {
      diagnostics.cleanup("database-end", error);
    }
  }
  return diagnostics.report;
}

if (import.meta.main) {
  let report: Awaited<ReturnType<typeof runRewardOperatorCommand>>;
  try {
    report = await runRewardOperatorCommand(parseRewardOperatorCommand(process.argv.slice(2)));
  } catch (error) {
    const diagnostics = createRewardOperationsReport("control");
    diagnostics.fail(error);
    report = diagnostics.report;
  }
  console.log(JSON.stringify(report));
  if (!report.ok) process.exitCode = 1;
}
