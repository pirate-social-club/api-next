import { resolve } from "node:path";
import * as BunRuntime from "bun";
import pg from "pg";
import { normalizePostgresConnectionString } from "./postgres-connection-string.ts";

const REWARD_CONFIGS = new Set([
  "apps/http-worker/wrangler.jsonc",
  "apps/jobs-worker/wrangler.jsonc",
]);

export function rewardsBinding(source: string, environment: string): boolean {
  const config: unknown = BunRuntime.JSONC.parse(source);
  if (typeof config !== "object" || config === null) throw Error("invalid Worker config");
  const environments = Reflect.get(config, "env");
  const selected: unknown =
    typeof environments === "object" && environments !== null
      ? Reflect.get(environments, environment)
      : undefined;
  if (typeof selected !== "object" || selected === null)
    throw Error("reward deploy environment missing");
  const vars: unknown = Reflect.get(selected, "vars");
  const value: unknown =
    typeof vars === "object" && vars !== null
      ? Reflect.get(vars, "MEGAPOT_REWARDS_ENABLED")
      : undefined;
  if (value !== "true" && value !== "false")
    throw Error("reward deploy binding missing or invalid");
  return value === "true";
}

export function rewardsLifecycle(
  source: string,
  environment: string,
): "dormant" | "prelaunch" | "launched" {
  const policy: unknown = JSON.parse(source);
  if (typeof policy !== "object" || policy === null || Reflect.get(policy, "schema_version") !== 1)
    throw Error("reward deployment lifecycle invalid");
  const environments: unknown = Reflect.get(policy, "environments");
  const phase: unknown =
    typeof environments === "object" && environments !== null
      ? Reflect.get(environments, environment)
      : undefined;
  if (phase !== "dormant" && phase !== "prelaunch" && phase !== "launched")
    throw Error("reward deployment lifecycle missing");
  return phase;
}

/** Count rows, never sum balances across owners: opposite balances cannot cancel. */
export const REWARD_SHUTDOWN_PREDICATES = [
  [
    "unpaid_credits",
    "reward_ledger_credits",
    "amount_atomic <> paid_atomic OR reserved_atomic <> 0",
  ],
  [
    "leg_liabilities",
    "song_reward_offer_legs",
    "funded_atomic <> spent_atomic+fulfilled_atomic+refunded_atomic OR reserved_atomic <> 0",
  ],
  [
    "sponsor_liabilities",
    "platform_sponsorship_budgets",
    "funded_atomic+winnings_credited_atomic <> spent_atomic+withdrawn_atomic OR reserved_atomic <> 0",
  ],
  ["open_offers", "song_reward_offers", "status NOT IN ('ended','expired','exhausted')"],
  ["open_legs", "song_reward_offer_legs", "status NOT IN ('ended','exhausted')"],
  [
    "unresolved_drawings",
    "megapot_pool_drawings",
    "status NOT IN ('no_win','credited','closed_no_entries','closed_unfunded','closed_fallback_ineligible','closed_fallback_unavailable','closed_fallback_ceiling','closed_purchase_unavailable')",
  ],
  [
    "unresolved_funding",
    "song_reward_leg_funding_effects",
    "state NOT IN ('confirmed','reverted','reclaimable_failed') OR (state='reclaimable_failed' AND transaction_hash IS NOT NULL)",
  ],
  [
    "unresolved_chain_effects",
    "reward_chain_effects",
    "state NOT IN ('confirmed','reverted','replaced','reclaimable_failed','terminal_failed') OR (state IN ('reclaimable_failed','terminal_failed') AND signed_transaction IS NOT NULL)",
  ],
  ["unresolved_gas_topups", "reward_gas_topups", "status NOT IN ('confirmed','released')"],
] as const;

export async function assertRewardsShutdownInventory(db: pg.Client, schema = "api_next") {
  if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw Error("invalid reward inventory schema");
  const liabilities: string[] = [];
  for (const [category, table, predicate] of REWARD_SHUTDOWN_PREDICATES) {
    const result = await db.query<{ present: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM "${schema}"."${table}" WHERE ${predicate}) AS present`,
    );
    if (result.rows.length !== 1 || typeof result.rows[0]?.present !== "boolean")
      throw Error("reward shutdown inventory malformed");
    if (result.rows[0].present) liabilities.push(category);
  }
  if (liabilities.length) throw Error(`reward binding shutdown refused: ${liabilities.join(", ")}`);
}

/** SELECT-only operator connection; row lock prevents resume during the upload. */
export async function withRewardsShutdownLock<T>(
  db: pg.Client,
  operation: (signal: AbortSignal) => Promise<T>,
  schema = "api_next",
): Promise<T> {
  if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw Error("invalid reward inventory schema");
  const cancellation = new AbortController();
  const connectionLost = () => cancellation.abort();
  db.on("error", connectionLost);
  db.on("end", connectionLost);
  try {
    await db.query("BEGIN");
    await db.query(
      "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'; SET LOCAL idle_in_transaction_session_timeout=0",
    );
    const control = await db.query<{ paused: boolean }>(
      `SELECT paused FROM "${schema}".reward_operations_control WHERE singleton=TRUE FOR SHARE`,
    );
    if (control.rows.length !== 1 || control.rows[0]?.paused !== true)
      throw Error("reward binding shutdown requires persisted pause");
    await assertRewardsShutdownInventory(db, schema);
    if (cancellation.signal.aborted) throw Error("reward shutdown control connection lost");
    const result = await operation(cancellation.signal);
    if (cancellation.signal.aborted)
      throw Error("reward shutdown control connection lost during deploy");
    return result;
  } finally {
    await db.query("ROLLBACK").catch(() => undefined);
    db.off("error", connectionLost);
    db.off("end", connectionLost);
  }
}

export async function withRewardsBindingDeployment<T>(
  root: string,
  configPath: string,
  environment: string,
  operation: (signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!REWARD_CONFIGS.has(configPath)) return operation();
  const phase = rewardsLifecycle(
    await BunRuntime.file(resolve(root, "docs/rewards-deployment-lifecycle.json")).text(),
    environment,
  );
  if (phase === "launched") {
    for (const pairedConfig of REWARD_CONFIGS)
      if (!rewardsBinding(await BunRuntime.file(resolve(root, pairedConfig)).text(), environment))
        throw Error("launched rewards require both tracked Worker bindings on");
  }
  const enabled = rewardsBinding(
    await BunRuntime.file(resolve(root, configPath)).text(),
    environment,
  );
  if (enabled) return operation();
  const connectionString = process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL;
  if (!connectionString)
    throw Error("reward binding shutdown requires direct operator database URL");
  const db = new pg.Client({
    connectionString: normalizePostgresConnectionString(connectionString),
    connectionTimeoutMillis: 5_000,
    keepAlive: true,
  });
  let uploadStarted = false;
  try {
    await db.connect();
    return await withRewardsShutdownLock(db, (signal) => {
      uploadStarted = true;
      return operation(signal);
    });
  } catch (error) {
    if (uploadStarted) throw error;
    const reason = error instanceof Error ? error.message : "";
    if (reason.startsWith("reward binding shutdown") || reason.startsWith("reward shutdown"))
      throw error;
    throw Error("reward binding shutdown inventory unavailable");
  } finally {
    await db.end().catch(() => undefined);
  }
}
