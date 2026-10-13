import { resolve } from "node:path";
import * as BunRuntime from "bun";
import pg from "pg";
import {
  assertServingFunctionPrivileges,
  SERVING_FUNCTION_PRIVILEGES_SQL,
  ServingFunctionPrivilegesRefused,
  servingFunctionPrivilegeParameters,
} from "../packages/platform-cf/src/serving-function-privileges.ts";
import { normalizePostgresConnectionString } from "./postgres-connection-string.ts";

/** Workers whose CONTROL_PLANE connection calls the owner-only entry points. */
const SERVING_CONFIGS = new Set([
  "apps/http-worker/wrangler.jsonc",
  "apps/jobs-worker/wrangler.jsonc",
]);
const SOURCE_MARKER = "packages/platform-cf/src/serving-function-privileges.ts";
const SERVING_SCHEMA = "api_next";

export async function runServingFunctionPrivilegesPreflight(
  connectionString: string,
  schema: string = SERVING_SCHEMA,
): Promise<string> {
  const db = new pg.Client({
    connectionString: normalizePostgresConnectionString(connectionString),
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    query_timeout: 15_000,
  });
  try {
    await db.connect();
    await db.query("BEGIN READ ONLY");
    const result = await db.query(SERVING_FUNCTION_PRIVILEGES_SQL, [
      ...servingFunctionPrivilegeParameters(schema),
    ]);
    return assertServingFunctionPrivileges(result.rows);
  } finally {
    await db.query("ROLLBACK").catch(() => undefined);
    await db.end().catch(() => undefined);
  }
}

/**
 * Refuses an HTTP or jobs upload whose source calls the owner-only entry points
 * unless the serving connection can execute exactly the reviewed set. A source
 * that predates the list has no such calls and is not checked.
 */
export async function withServingFunctionPrivilegesDeployment<T>(
  root: string,
  configPath: string,
  operation: () => Promise<T>,
  preflight: (connectionString: string) => Promise<unknown> = runServingFunctionPrivilegesPreflight,
  writeDiagnostic: (text: string) => void = (text) => process.stderr.write(text),
): Promise<T> {
  if (!SERVING_CONFIGS.has(configPath)) return operation();
  if (!(await BunRuntime.file(resolve(root, SOURCE_MARKER)).exists())) return operation();
  const url = process.env.RUNTIME_POSTGRES_URL ?? process.env.CONTROL_PLANE_POSTGRES_RUNTIME_URL;
  if (!url) throw Error("Serving-role function admission requires the serving-role database URL");
  try {
    await preflight(url);
  } catch (error) {
    if (error instanceof ServingFunctionPrivilegesRefused)
      writeDiagnostic(`${error.failures.join("\n")}\n`);
    throw Error(
      "Serving-role function privileges refused; apply and verify the reviewed grant block",
    );
  }
  return operation();
}

if (import.meta.main) {
  const url = process.env.RUNTIME_POSTGRES_URL ?? process.env.CONTROL_PLANE_POSTGRES_RUNTIME_URL;
  if (!url) throw Error("Serving-role function admission requires the serving-role database URL");
  try {
    const role = await runServingFunctionPrivilegesPreflight(url);
    process.stdout.write(`${JSON.stringify({ serving_function_privileges: "ready", role })}\n`);
  } catch (error) {
    if (error instanceof ServingFunctionPrivilegesRefused)
      process.stderr.write(`${error.failures.join("\n")}\n`);
    process.stderr.write("Serving-role function privileges refused\n");
    process.exitCode = 1;
  }
}
