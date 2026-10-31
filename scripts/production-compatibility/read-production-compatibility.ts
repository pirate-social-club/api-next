import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import pg from "pg";
import { injectedReadOnlyOwnerUrl } from "../production-release/production-managed-environment.ts";
import {
  aggregateObservation,
  type Observation,
  validateComplete,
  validateObservation,
  validateServingReceipt,
} from "./compatibility-contract.ts";
import { APP_REPO, APP_SOURCE, PREFIX_LEDGER, sha256, sourceInputs } from "./source-inputs.ts";

const OWNER = "pscale_api_exl4hoyn673g";
const SELECTOR = "HNS_PRODUCTION_POSTGRES_ADMIN_URL";
function outside(path: string, root: string) {
  const rel = relative(root, path);
  return rel.startsWith("../") || rel === ".." || isAbsolute(rel);
}
function managedOwnerUrl() {
  return injectedReadOnlyOwnerUrl();
}

/** Two path arguments only; every identifier and SQL statement is source-bound. */
export async function main(args = Bun.argv.slice(2)) {
  assert.equal(args.length, 2);
  const [servingPath, output] = args;
  assert.ok(
    servingPath &&
      output &&
      isAbsolute(servingPath) &&
      isAbsolute(output) &&
      servingPath !== output,
  );
  assert.equal(join(realpathSync(dirname(output)), basename(output)), output);
  assert.ok(!existsSync(output));
  let phase = "source_manifest",
    fd: number | undefined,
    db: pg.Client | undefined,
    success = false;
  const observations: Observation[] = [];
  const result: Record<string, unknown> = {
    kind: "production275-333-data-compatibility-v1",
    api_source: APP_SOURCE,
    environment: "production",
    branch: "mqfaju65wdm3",
    read_only: true,
    success: false,
    existing_managed_selector: SELECTOR,
    credentials_logged: false,
  };
  try {
    const inputs = await sourceInputs();
    assert.ok(
      outside(output, inputs.toolingRoot) && outside(output, APP_REPO),
      "Receipt must be outside source checkouts",
    );
    fd = openSync(output, "wx", 0o600);
    result.tooling_source = inputs.toolingSource;
    result.source_manifest_sha256 = inputs.manifestSha256;
    result.environment_helper_sha256 = inputs.environmentHelperSha256;
    phase = "fresh_serving_origin";
    const servingBytes = readFileSync(servingPath);
    const serving = JSON.parse(servingBytes.toString("utf8"));
    result.serving_target = validateServingReceipt(serving, Date.now());
    result.serving_receipt_sha256 = sha256(servingBytes);
    phase = "managed_existing_owner_selector";
    const connectionString = await managedOwnerUrl();
    validateServingReceipt(serving, Date.now());
    db = new pg.Client({
      connectionString,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 7_000,
      query_timeout: 10_000,
      options:
        "-c search_path=api_next,pg_catalog -c default_transaction_read_only=on -c timezone=UTC -c transaction_timeout=170000",
    });
    phase = "owner_read_only_identity";
    await db.connect();
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const identity = (
      await db.query(
        "SELECT current_user::text role,session_user::text session_role,current_database() database,current_schema() schema,current_schemas(false)::text[] schemas,current_setting('transaction_read_only') read_only,current_setting('TimeZone') timezone,current_setting('server_version_num') server_version_num,(extract(epoch FROM current_setting('transaction_timeout')::interval)*1000)::bigint::text transaction_timeout_ms",
      )
    ).rows[0];
    assert.equal(identity?.role, OWNER);
    assert.equal(identity.session_role, OWNER);
    assert.equal(identity.database, "postgres");
    assert.equal(identity.schema, "api_next");
    assert.equal(identity.read_only, "on");
    assert.equal(identity.timezone, "UTC");
    assert.deepEqual(identity.schemas, ["api_next", "pg_catalog"]);
    assert.equal(identity.transaction_timeout_ms, "170000");
    assert.ok(Number(identity.server_version_num) >= 180000);
    const ownership = (
      await db.query(
        "SELECT pg_get_userbyid(n.nspowner) schema_owner,pg_get_userbyid(c.relowner) users_owner FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname='users' WHERE n.nspname='api_next'",
      )
    ).rows[0];
    assert.deepEqual(ownership, { schema_owner: OWNER, users_owner: OWNER });
    phase = "exact275_ledger_and_paused_rewards";
    const ledger = (
      await db.query("SELECT version,checksum FROM api_next.schema_migrations ORDER BY version")
    ).rows;
    assert.deepEqual(ledger, inputs.prefix);
    assert.equal(ledger.length, 275);
    assert.equal(
      sha256(ledger.map((row) => row.version + ":" + row.checksum).join("\n")),
      PREFIX_LEDGER,
    );
    assert.deepEqual(
      (
        await db.query(
          "SELECT paused,revision::text FROM api_next.reward_operations_control WHERE singleton",
        )
      ).rows,
      [{ paused: true, revision: "0" }],
    );
    result.identity = {
      role: OWNER,
      database: "postgres",
      schema: "api_next",
      read_only: true,
      timezone: "UTC",
    };
    result.ledger = { count: 275, sha256: PREFIX_LEDGER, exact_source_prefix: true, pending: 58 };
    for (const query of inputs.queries) {
      phase = query.id;
      const observed = await db.query(query.sql);
      const aggregate = aggregateObservation({ id: query.id, rows: observed.rows });
      observations.push(aggregate);
      validateObservation(aggregate);
    }
    phase = "complete_inventory";
    validateComplete(observations);
    phase = "rollback";
    await db.query("ROLLBACK");
    await db.end();
    db = undefined;
    phase = "source_and_receipt_recheck";
    const after = await sourceInputs();
    assert.equal(after.toolingSource, inputs.toolingSource);
    assert.equal(after.manifestSha256, inputs.manifestSha256);
    assert.equal(sha256(readFileSync(servingPath)), result.serving_receipt_sha256);
    validateServingReceipt(serving, Date.now());
    success = true;
  } catch (error: unknown) {
    const item = error !== null && typeof error === "object" ? (error as { code?: unknown }) : {};
    result.failure = {
      phase,
      sqlstate:
        typeof item.code === "string" && /^[A-Z0-9]{5}$/u.test(item.code) ? item.code : null,
      message: "Read-only compatibility check refused; no application data or credentials emitted.",
    };
    process.exitCode = 1;
  } finally {
    if (db) {
      await db.query("ROLLBACK").catch(() => undefined);
      await db.end().catch(() => undefined);
    }
    result.at = new Date().toISOString();
    result.success = success;
    result.completed_query_count = observations.length;
    result.required_query_count = 14;
    result.observations = observations;
    if (fd !== undefined) {
      try {
        writeFileSync(fd, JSON.stringify(result, null, 2) + "\n");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      const directory = openSync(dirname(output), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
    console.log(
      JSON.stringify({
        success,
        phase,
        completed_query_count: observations.length,
        required_query_count: 14,
        credentials_logged: false,
      }),
    );
  }
}
if (import.meta.main)
  main().catch(() => {
    console.error("Read-only compatibility reader initialization refused.");
    process.exitCode = 1;
  });
