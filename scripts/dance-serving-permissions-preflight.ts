import { resolve } from "node:path";
import * as BunRuntime from "bun";
import pg from "pg";
import {
  DANCE_SERVING_CONSUMERS,
  type DanceServingConsumer,
  danceServingPrivilegeParameters,
} from "./dance-serving-permission-contract.ts";
import {
  assertDanceServingPrivileges,
  DANCE_SERVING_PRIVILEGES_SQL,
  DanceServingPrivilegesRefused,
} from "./dance-serving-permission-query.ts";
import { normalizePostgresConnectionString } from "./postgres-connection-string.ts";

type Client = {
  connect: () => Promise<unknown>;
  query: (
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: readonly Record<string, unknown>[] }>;
  end: () => Promise<unknown>;
};
export async function runDanceServingPermissionsPreflight(
  url: string,
  config: DanceServingConsumer,
  schema = "api_next",
  clientFactory: (connectionString: string) => Client = (connectionString) =>
    new pg.Client({
      connectionString,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
      query_timeout: 15000,
    }),
): Promise<string> {
  const db = clientFactory(normalizePostgresConnectionString(url));
  try {
    await db.connect();
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result = await db.query(DANCE_SERVING_PRIVILEGES_SQL, [
      ...danceServingPrivilegeParameters(schema, config),
    ]);
    return assertDanceServingPrivileges(result.rows, config);
  } finally {
    await db.query("ROLLBACK").catch(() => undefined);
    await db.end().catch(() => undefined);
  }
}

/** Every source consumer is checked, including the separately deployed media
 * source gateway. Older source without this contract predates these calls. */
export async function withDanceServingPermissionsDeployment<T>(
  root: string,
  configPath: string,
  operation: () => Promise<T>,
  preflight = runDanceServingPermissionsPreflight,
  writeDiagnostic: (text: string) => void = (text) => process.stderr.write(text),
): Promise<T> {
  if (!Object.hasOwn(DANCE_SERVING_CONSUMERS, configPath)) return operation();
  if (
    !(await BunRuntime.file(resolve(root, "scripts/dance-serving-permission-contract.ts")).exists())
  )
    return operation();
  const url = process.env.RUNTIME_POSTGRES_URL ?? process.env.CONTROL_PLANE_POSTGRES_RUNTIME_URL;
  if (!url)
    throw Error("Dance serving permission admission requires the serving-role database URL");
  try {
    await preflight(url, configPath as DanceServingConsumer);
  } catch (error) {
    if (error instanceof DanceServingPrivilegesRefused)
      writeDiagnostic(`${error.failures.join("\n")}\n`);
    throw Error(
      "Dance serving permissions refused; verify the reviewed purpose and direct-function grant plan",
      { cause: error },
    );
  }
  return operation();
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (
    args.length !== 2 ||
    args[0] !== "--config" ||
    args[1] === undefined ||
    !Object.hasOwn(DANCE_SERVING_CONSUMERS, args[1])
  )
    throw Error("Dance permission preflight requires --config with an admitted consumer");
  const url = process.env.RUNTIME_POSTGRES_URL ?? process.env.CONTROL_PLANE_POSTGRES_RUNTIME_URL;
  if (!url)
    throw Error("Dance serving permission admission requires the serving-role database URL");
  try {
    const role = await runDanceServingPermissionsPreflight(url, args[1] as DanceServingConsumer);
    console.log(JSON.stringify({ dance_serving_permissions: "ready", role, config: args[1] }));
  } catch (error) {
    if (error instanceof DanceServingPrivilegesRefused)
      process.stderr.write(`${error.failures.join("\n")}\n`);
    process.stderr.write("Dance serving permissions refused\n");
    process.exitCode = 1;
  }
}
