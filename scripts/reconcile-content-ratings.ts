import { Schema } from "effect";
import { Client } from "pg";
import { normalizePostgresConnectionString } from "./postgres-connection-string.ts";

const hash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const plan = Schema.Struct({
  version: Schema.Literal("content-rating-reconciliation-v1"),
  plan_hash: hash,
  limit: Schema.Number,
  items: Schema.Array(
    Schema.Struct({
      target_kind: Schema.Literals(["post", "comment", "text_submission", "media_submission"]),
      community_id: Schema.String,
      target_id: Schema.String,
      depth: Schema.Number,
      outcome: Schema.Literals(["held", "general", "adult_18"]),
      source_hash: hash,
    }),
  ),
});
const result = Schema.Struct({
  status: Schema.Literals(["applied", "replayed"]),
  plan_hash: hash,
  resources: Schema.Number,
});

async function main(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "reconcile-content-ratings --database-url-env NAME [--limit 1..100] [--apply --plan-hash SHA256]",
    );
    console.log(
      "Defaults to a read-only plan. Apply requires its exact hash and never republishes held content.",
    );
    return;
  }
  const options = new Map<string, string>();
  let apply = false;
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--apply" && !apply) {
      apply = true;
      continue;
    }
    if (key !== "--database-url-env" && key !== "--limit" && key !== "--plan-hash")
      throw new Error("Unknown or duplicate argument; use --help");
    const value = args[++index];
    if (value === undefined || value.startsWith("--") || options.has(key))
      throw new Error("Missing or duplicate argument; use --help");
    options.set(key, value);
  }
  const variable = options.get("--database-url-env");
  const limitText = options.get("--limit") ?? "100";
  const limit = Number(limitText);
  const expected = options.get("--plan-hash");
  if (variable === undefined || !/^[A-Z][A-Z0-9_]*$/u.test(variable))
    throw new Error("An explicit database URL environment variable name is required");
  if (!/^[1-9][0-9]*$/u.test(limitText) || !Number.isSafeInteger(limit) || limit > 100)
    throw new Error("Limit must be between 1 and 100");
  if (apply ? expected === undefined || !/^[0-9a-f]{64}$/u.test(expected) : expected !== undefined)
    throw new Error("Apply requires an exact plan hash; dry runs do not accept one");
  const raw = process.env[variable];
  if (raw === undefined || raw === "")
    throw new Error("The selected database URL is not configured");
  let connectionString: string;
  try {
    connectionString = normalizePostgresConnectionString(raw);
    if (!["postgres:", "postgresql:"].includes(new URL(connectionString).protocol))
      throw new Error();
  } catch {
    throw new Error("The selected database URL is invalid");
  }
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,
    application_name: "content-rating-reconciliation-v1",
  });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    await client.query(apply ? "BEGIN ISOLATION LEVEL SERIALIZABLE" : "BEGIN READ ONLY");
    try {
      const rows = apply
        ? await client.query<{ report: unknown }>(
            "SELECT apply_content_rating_reconciliation_v1($1,$2) AS report",
            [expected, limit],
          )
        : await client.query<{ report: unknown }>(
            "SELECT content_rating_reconciliation_plan_v1($1) AS report",
            [limit],
          );
      const report = apply
        ? Schema.decodeUnknownSync(result)(rows.rows[0]?.report)
        : Schema.decodeUnknownSync(plan)(rows.rows[0]?.report);
      await client.query("COMMIT");
      console.log(JSON.stringify(report));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    if (connected) await client.end();
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    // Never echo a connection string or database values from a driver error.
    const failure = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }))(error);
    if (failure._tag === "Some")
      console.error(
        `Rating reconciliation failed (SQLSTATE ${failure.value.code}); no automatic retry was attempted.`,
      );
    else
      console.error(
        error instanceof Error && !error.message.includes("://")
          ? error.message
          : "Rating reconciliation failed",
      );
    process.exitCode = 1;
  });
}
