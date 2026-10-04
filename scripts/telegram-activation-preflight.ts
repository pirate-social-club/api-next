import { resolve } from "node:path";
import * as BunRuntime from "bun";
import pg from "pg";
import {
  assertTelegramActivationPrivileges,
  TELEGRAM_ACTIVATION_PRIVILEGES_SQL,
} from "../packages/platform-cf/src/telegram-activation-privileges.ts";
import { normalizePostgresConnectionString } from "./postgres-connection-string.ts";

const configurations = new Set([
  "apps/http-worker/wrangler.jsonc",
  "apps/jobs-worker/wrangler.jsonc",
]);
export function telegramActivationBinding(source: string, environment: string, linking: boolean) {
  const config = BunRuntime.JSONC.parse(source) as {
    env?: Record<string, { vars?: Record<string, unknown> }>;
  };
  const vars = config?.env?.[environment]?.vars;
  if (!vars) throw Error("Telegram activation environment missing");
  const flags = linking ? ["TELEGRAM_ENABLED", "TELEGRAM_LINKING_ENABLED"] : ["TELEGRAM_ENABLED"];
  if (vars.TELEGRAM_STUDY_PRACTICE_ENABLED !== undefined)
    flags.push("TELEGRAM_STUDY_PRACTICE_ENABLED");
  for (const flag of flags)
    if (vars[flag] !== "true" && vars[flag] !== "false")
      throw Error("Telegram activation binding missing or invalid");
  return flags.some((flag) => vars[flag] === "true");
}

export async function runTelegramActivationPreflight(connectionString: string) {
  const db = new pg.Client({
    connectionString: normalizePostgresConnectionString(connectionString),
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    query_timeout: 15_000,
  });
  try {
    await db.connect();
    await db.query("BEGIN READ ONLY");
    const result = await db.query(TELEGRAM_ACTIVATION_PRIVILEGES_SQL);
    return assertTelegramActivationPrivileges(result.rows);
  } finally {
    await db.query("ROLLBACK").catch(() => undefined);
    await db.end().catch(() => undefined);
  }
}

export async function withTelegramActivationDeployment<T>(
  root: string,
  configPath: string,
  environment: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (!configurations.has(configPath)) return operation();
  const source = await BunRuntime.file(resolve(root, configPath)).text();
  if (!telegramActivationBinding(source, environment, configPath.includes("http-worker")))
    return operation();
  const url = process.env.RUNTIME_POSTGRES_URL ?? process.env.CONTROL_PLANE_POSTGRES_RUNTIME_URL;
  if (!url) throw Error("Telegram activation requires the serving-role database URL");
  try {
    await runTelegramActivationPreflight(url);
  } catch {
    throw Error(
      "Telegram activation serving-role preflight refused; apply and verify scoped permissions",
    );
  }
  return operation();
}

if (import.meta.main) {
  const url = process.env.RUNTIME_POSTGRES_URL ?? process.env.CONTROL_PLANE_POSTGRES_RUNTIME_URL;
  if (!url) throw Error("Telegram activation requires the serving-role database URL");
  try {
    const role = await runTelegramActivationPreflight(url);
    process.stdout.write(`Telegram activation privilege admission ready for ${role}\n`);
  } catch {
    process.stderr.write("Telegram activation privilege admission refused\n");
    process.exitCode = 1;
  }
}
