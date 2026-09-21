import { createHash } from "node:crypto";
import { Client, type QueryResult } from "pg";
import {
  AFTER_BODY,
  APPLY_SQL,
  BEFORE_BODY,
  RESTORE_SQL,
} from "./community-session-sufficiency-hotfix-sql.ts";
import { normalizePostgresConnectionString } from "./postgres-connection-string.ts";
import { loadPostgresMigrations } from "./postgres-migrations.ts";

const APPLY_CONFIRMATION = "apply-community-session-sufficiency-hotfix";
const RESTORE_CONFIRMATION = "restore-community-session-sufficiency-hotfix";
const LOCK_KEY = "api-next:community-session-sufficiency-hotfix:v1";

type QueryClient = Pick<Client, "query">;
type LedgerRow = Readonly<{ version: string; checksum: string }>;
type FunctionRow = Readonly<{
  body: string;
  language: string;
  volatility: string;
  security_definer: boolean;
  result_type: string;
  arguments: string;
}>;

export type HotfixState = "before" | "after";
export type HotfixObservation = Readonly<{
  ledgerCount: number;
  ledgerTip: string;
  state: HotfixState;
  functionSha256: string;
}>;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function expectedBody(state: HotfixState): string {
  return state === "before" ? BEFORE_BODY : AFTER_BODY;
}

async function readFunction(client: QueryClient): Promise<FunctionRow> {
  const result = (await client.query(`SELECT procedure.prosrc AS body,
       language.lanname AS language,
       procedure.provolatile AS volatility,
       procedure.prosecdef AS security_definer,
       pg_catalog.pg_get_function_result(procedure.oid) AS result_type,
       pg_catalog.pg_get_function_identity_arguments(procedure.oid) AS arguments
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_language AS language ON language.oid=procedure.prolang
 WHERE procedure.oid=pg_catalog.to_regprocedure('validate_persona_wallet_activation()')
   AND procedure.pronamespace=pg_catalog.current_schema()::pg_catalog.regnamespace`)) as QueryResult<FunctionRow>;
  const row = result.rows[0];
  if (row === undefined || result.rows.length !== 1) {
    throw new Error("community_session_hotfix_function_missing");
  }
  return row;
}

function assertFunction(row: FunctionRow, state: HotfixState): void {
  if (
    row.body.trim() !== expectedBody(state) ||
    row.language !== "plpgsql" ||
    row.volatility !== "v" ||
    row.security_definer !== false ||
    row.result_type !== "trigger" ||
    row.arguments !== ""
  ) {
    throw new Error(`community_session_hotfix_${state}_function_mismatch`);
  }
}

async function assertLedger(client: QueryClient): Promise<readonly LedgerRow[]> {
  const expected = await loadPostgresMigrations();
  const result = (await client.query(
    "SELECT version,checksum FROM schema_migrations ORDER BY version",
  )) as QueryResult<LedgerRow>;
  if (result.rows.length !== expected.length) {
    throw new Error("community_session_hotfix_ledger_length_mismatch");
  }
  for (const [index, row] of result.rows.entries()) {
    const planned = expected[index];
    if (
      planned === undefined ||
      row.version !== planned.version ||
      row.checksum !== planned.checksum
    ) {
      throw new Error("community_session_hotfix_ledger_mismatch");
    }
  }
  const tip = result.rows.at(-1)?.version;
  if (tip !== "0136_hns_existing_name_attachment.sql") {
    throw new Error("community_session_hotfix_ledger_tip_mismatch");
  }
  return result.rows;
}

export async function observeCommunitySessionHotfix(
  client: QueryClient,
  expectedState: HotfixState,
): Promise<HotfixObservation> {
  const ledger = await assertLedger(client);
  const functionRow = await readFunction(client);
  assertFunction(functionRow, expectedState);
  return {
    ledgerCount: ledger.length,
    ledgerTip: ledger.at(-1)?.version ?? "",
    state: expectedState,
    functionSha256: sha256(functionRow.body.trim()),
  };
}

export async function executeCommunitySessionHotfix(
  client: QueryClient,
  operation: "apply" | "restore",
): Promise<HotfixObservation> {
  const before: HotfixState = operation === "apply" ? "before" : "after";
  const after: HotfixState = operation === "apply" ? "after" : "before";
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout='3s'");
    await client.query("SET LOCAL statement_timeout='10s'");
    await client.query(
      "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1,0))",
      [LOCK_KEY],
    );
    await observeCommunitySessionHotfix(client, before);
    await client.query(operation === "apply" ? APPLY_SQL : RESTORE_SQL);
    const observation = await observeCommunitySessionHotfix(client, after);
    await client.query("COMMIT");
    return observation;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export function parseCommunitySessionHotfixOperation(
  args: readonly string[],
): "inspect" | "apply" | "restore" {
  const operation = args[0];
  if (operation !== "inspect" && operation !== "apply" && operation !== "restore") {
    throw new Error(
      "Usage: community-session-sufficiency-hotfix.ts inspect|apply|restore [--confirm token]",
    );
  }
  const allowedLength = operation === "inspect" ? 1 : 3;
  if (args.length !== allowedLength) throw new Error("community_session_hotfix_invalid_arguments");
  if (operation === "inspect") return operation;
  const expected = operation === "apply" ? APPLY_CONFIRMATION : RESTORE_CONFIRMATION;
  if (args[1] !== "--confirm" || args[2] !== expected) {
    throw new Error("community_session_hotfix_confirmation_mismatch");
  }
  return operation;
}

async function connect(): Promise<Client> {
  const raw = process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL?.trim();
  if (!raw) throw new Error("CONTROL_PLANE_POSTGRES_ADMIN_URL is required");
  const client = new Client({
    connectionString: normalizePostgresConnectionString(raw),
    connectionTimeoutMillis: 5_000,
    application_name: "community-session-sufficiency-hotfix",
  });
  await client.connect();
  return client;
}

export async function main(args: readonly string[] = Bun.argv.slice(2)): Promise<void> {
  const operation = parseCommunitySessionHotfixOperation(args);
  if (operation === "inspect") {
    const client = await connect();
    try {
      let observation: HotfixObservation;
      try {
        observation = await observeCommunitySessionHotfix(client, "before");
      } catch {
        observation = await observeCommunitySessionHotfix(client, "after");
      }
      console.log(JSON.stringify(observation));
      return;
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  const client = await connect();
  let committed: HotfixObservation;
  try {
    committed = await executeCommunitySessionHotfix(client, operation);
  } finally {
    await client.end().catch(() => undefined);
  }
  const readback = await connect();
  try {
    const observed = await observeCommunitySessionHotfix(
      readback,
      operation === "apply" ? "after" : "before",
    );
    if (JSON.stringify(observed) !== JSON.stringify(committed)) {
      throw new Error("community_session_hotfix_independent_readback_mismatch");
    }
    console.log(JSON.stringify(observed));
  } finally {
    await readback.end().catch(() => undefined);
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "community_session_hotfix_failed");
    process.exitCode = 1;
  });
}
