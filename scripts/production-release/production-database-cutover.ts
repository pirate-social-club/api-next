import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  acceptedExecutor,
  evidenceDiagnostics,
  initializeOperation,
  OPERATION_DIR,
  record,
  recordDigest,
  resolution,
  save,
  validateGrantPhaseState,
  writeResolution,
} from "./production-operation-evidence.ts";
import {
  bound,
  checkBackup,
  facts,
  admitted as validateAdmission,
} from "./production-release-admission.ts";

export { bound, OPERATION_DIR, record, recordDigest, save };

import pg, { type ClientConfig } from "pg";
import { runDanceServingPermissionsPreflight } from "../dance-serving-permissions-preflight.ts";
import { normalizePostgresConnectionString } from "../postgres-connection-string.ts";
import { loadPostgresMigrations, runPostgresMigrations } from "../postgres-migrations.ts";
import { runServingFunctionPrivilegesPreflight } from "../serving-function-privileges-preflight.ts";

import {
  API_APP_SOURCE,
  API_APP_TREE,
  APP_REPO,
  QUALIFICATION,
  SOURCE_DIRECTORY,
} from "./production-release-paths.ts";
import { assertApplicationSource } from "./production-source-binding.ts";

export { QUALIFICATION };
export const REPO = APP_REPO;
const PACKAGE = SOURCE_DIRECTORY;
export const SOURCE = API_APP_SOURCE;
export const TREE = API_APP_TREE;
export const OWNER = "pscale_api_exl4hoyn673g";
export const RUNTIME = "pscale_api_4bxas7gq43a4";
export const BRANCH = "mqfaju65wdm3";
export const LEDGER275 = "1f49f7e3d7b3323fc84e15ce365d47d00337fa8047abad9c67458e0b0c40d04b";
export const LEDGER333 = "95cdd12cfef6dc5eaf89d0e7734b1d692477c12d621f2596d923ad3499a94280";
export const HELPER = "b0e9fd67fc2a6a4fdc1b4f8ae867153a38639844fb4ee195bebad2cba7f430a4";
export const DANCE_PLAN_FILE = "9b3f5406c5ea6782f14a5c1bd9ced045759b49f919ff6f2eb089d97fecbea0c9";
export const DANCE_PLAN = "016fb2701b3e2c90069652613ef358338e68572f3bf15d4ebb06611b1814db78";
export const BROWSER_PLAN_FILE = "deb332e0543461e0b5b90b4196de30a7f5779a32a7629ea7382ac892bed6af9e";
export const BROWSER_FUNCTIONS = [
  "create_browser_session_v1(jsonb)",
  "read_browser_session_access_v1(text,text,text)",
  "read_browser_session_renewal_v1(text,text,text,text)",
  "renew_browser_session_v1(text,text,text,text)",
  "revoke_browser_session_v1(text,text,text,text,text)",
] as const;
const consumers = [
  "http-worker",
  "jobs-worker",
  "media-processor-worker",
  "video-source-gateway",
] as const;
const bytes = (name: string) => readFileSync(PACKAGE + name);
const read = (name: string) => JSON.parse(bytes(name).toString("utf8"));
export const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const ledgerHash = (rows: readonly { version: string; checksum: string }[]) =>
  hash(rows.map((row) => row.version + ":" + row.checksum).join("\n"));
const self = () => hash(readFileSync(new URL(import.meta.url)));

const realDeps = {
  git: (args: string[]) => execFileSync("/usr/bin/git", args, { cwd: REPO, encoding: "utf8" }),
  live: facts,

  now: () => Date.now(),
  loadMigrations: loadPostgresMigrations,
  runMigrations: runPostgresMigrations,
  managedUrls,
  client: (options: ClientConfig) => new pg.Client(options),
  servingPreflight: (url: string) => runServingFunctionPrivilegesPreflight(url),
  dancePreflight: (url: string, consumer: (typeof consumers)[number]) =>
    runDanceServingPermissionsPreflight(url, `apps/${consumer}/wrangler.jsonc`),
};
// Live execution always uses these maintained dependencies; there is no alternate runtime adapter.
const deps = realDeps;

export const liveFacts = () => deps.live();
export const executorSha256 = () => self();

export function localInputs() {
  assertApplicationSource();
  assert.equal(deps.git(["rev-parse", "HEAD"]).trim(), SOURCE);
  assert.equal(deps.git(["rev-parse", "HEAD^{tree}"]).trim(), TREE);
  assert.equal(deps.git(["status", "--porcelain"]), "");
  assert.equal(hash(readFileSync(REPO + "/scripts/dance-serving-grant-plan.ts")), HELPER);
  assert.equal(hash(bytes("production-dance-grant-plan-333.json")), DANCE_PLAN_FILE);
  const grant = read("production-dance-grant-plan-333.json");
  assert.equal(grant.source, SOURCE);
  assert.equal(grant.runtime_principal, RUNTIME);
  assert.equal(grant.branch, BRANCH);
  assert.equal(grant.plan.ledgerSha256, LEDGER333);
  assert.equal(grant.plan.sha256, DANCE_PLAN);
  assert.equal(grant.plan.statements[0], "BEGIN");
  assert.equal(grant.plan.statements.at(-1), "COMMIT");
  assert.equal(grant.plan.statements.length, 16);
  const browserBytes = readFileSync(PACKAGE + "browser-grant-plan-333.json");
  assert.equal(hash(browserBytes), BROWSER_PLAN_FILE);
  const browser = JSON.parse(browserBytes.toString("utf8"));
  assert.equal(browser.source_commit, SOURCE);
  assert.equal(browser.runtime_role, RUNTIME);
  assert.equal(browser.required_owner_session, OWNER);
  assert.equal(browser.branch, BRANCH);
  assert.equal(browser.ledger_count, 333);
  assert.equal(browser.ledger_sha256, LEDGER333);
  assert.deepEqual(browser.functions, [...BROWSER_FUNCTIONS]);
  assert.deepEqual(
    browserPlanGrants(browser.statements),
    BROWSER_FUNCTIONS.map((name) => `GRANT EXECUTE ON FUNCTION "api_next".${name} TO "${RUNTIME}"`),
  );
  return { grant, browser };
}

/** Accepts only the pinned shape: one transaction, session settings, two guards and the five grants. */
export function browserPlanGrants(statements: readonly string[]) {
  assert.equal(statements.length, 12);
  assert.equal(statements[0], "BEGIN");
  assert.equal(statements.at(-1), "COMMIT");
  assert.ok(statements.slice(1, 4).every((statement) => statement.startsWith("SET LOCAL ")));
  assert.ok(
    statements[4]?.startsWith("DO $browser_release$") &&
      statements[10]?.startsWith("DO $browser_release$"),
  );
  const grants = statements.slice(5, 10);
  assert.ok(
    grants.every((statement) =>
      /^GRANT EXECUTE ON FUNCTION "api_next"\.[a-z_0-9]+\([a-z,]*\) TO "pscale_api_4bxas7gq43a4"$/u.test(
        statement,
      ),
    ),
  );
  return grants;
}

export function admitted(minimumRemainingMs = 190_000, mode = "verify", requireOuter = false) {
  const result = validateAdmission(mode, self(), requireOuter, minimumRemainingMs);
  assert.equal(result.review.backend_executor_sha256, self());
  assert.equal(result.review.dance_plan_file_sha256, DANCE_PLAN_FILE);
  return result;
}

export async function managedUrls() {
  const login = Bun.spawnSync(["infisical", "user", "get", "token", "--plain", "--silent"], {
    cwd: "/tmp",
    stdout: "pipe",
    stderr: "pipe",
  });
  assert.equal(login.exitCode, 0);
  async function get(key: string, role: string) {
    const endpoint = new URL("https://app.infisical.com/api/v4/secrets/" + key);
    for (const [name, value] of Object.entries({
      projectId: "fac45f92-9450-42fb-8c2f-f20d043fdfab",
      environment: "prod",
      secretPath: "/services/api-next/operator",
      type: "shared",
      expandSecretReferences: "false",
      includeImports: "false",
    }))
      endpoint.searchParams.set(name, value);
    const response = await fetch(endpoint, {
      headers: { Authorization: "Bearer " + login.stdout.toString().trim() },
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200);
    const payload: unknown = await response.json();
    assert.ok(payload !== null && typeof payload === "object" && !Array.isArray(payload));
    const secret = (payload as Record<string, unknown>).secret;
    assert.ok(secret !== null && typeof secret === "object" && !Array.isArray(secret));
    const fields = secret as Record<string, unknown>;
    assert.equal(fields.secretKey, key);
    assert.equal(fields.environment, "prod");
    assert.ok(typeof fields.secretValue === "string");
    const url = new URL(fields.secretValue);
    assert.equal(url.hostname, "aws-us-east-1-4.pg.psdb.cloud");
    assert.equal(url.port || "5432", "5432");
    assert.equal(url.pathname, "/postgres");
    assert.equal(decodeURIComponent(url.username), role + "." + BRANCH);
    assert.equal(url.searchParams.get("sslmode"), "verify-full");
    // Pin the writer's startup settings too; the Direct migration layer does
    // not choose a schema. These are in-memory connection options only.
    if (role === OWNER)
      url.searchParams.set(
        "options",
        "-c search_path=api_next,pg_catalog -c transaction_timeout=170000",
      );
    return normalizePostgresConnectionString(url.toString());
  }
  return {
    owner: await get("HNS_PRODUCTION_POSTGRES_ADMIN_URL", OWNER),
    runtime: await get("HNS_PRODUCTION_POSTGRES_RUNTIME_URL", RUNTIME),
  };
}

export async function ownerRead(url: string, expectedCount?: 275 | 333) {
  const db = deps.client({
    connectionString: url,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 7_000,
    query_timeout: 10_000,
  });
  try {
    await db.connect();
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    assert.deepEqual((await db.query("SELECT current_schemas(false) schemas")).rows[0].schemas, [
      "api_next",
      "pg_catalog",
    ]);
    assert.equal(
      (
        await db.query(
          "SELECT (extract(epoch FROM current_setting('transaction_timeout')::interval)*1000)::bigint::text timeout_ms",
        )
      ).rows[0].timeout_ms,
      "170000",
    );
    assert.ok(
      Number((await db.query("SHOW server_version_num")).rows[0].server_version_num) >= 170000,
    );
    const identity = (
      await db.query(
        "SELECT current_user::text role,session_user::text session_role,current_database() database,current_schema() schema,current_setting('transaction_read_only') read_only",
      )
    ).rows[0];
    assert.deepEqual(identity, {
      role: OWNER,
      session_role: OWNER,
      database: "postgres",
      schema: "api_next",
      read_only: "on",
    });
    const owner = (
      await db.query(
        "SELECT pg_get_userbyid(n.nspowner) schema_owner,pg_get_userbyid(c.relowner) users_owner FROM pg_namespace n JOIN pg_class c ON c.relnamespace=n.oid AND c.relname='users' WHERE n.nspname='api_next'",
      )
    ).rows[0];
    assert.deepEqual(owner, { schema_owner: OWNER, users_owner: OWNER });
    const ledger = (
      await db.query("SELECT version,checksum FROM schema_migrations ORDER BY version")
    ).rows;
    assert.ok(ledger.length === 275 || ledger.length === 333);
    if (expectedCount !== undefined) assert.equal(ledger.length, expectedCount);
    const migrations = await deps.loadMigrations();
    assert.deepEqual(
      ledger,
      migrations.slice(0, ledger.length).map(({ version, checksum }) => ({ version, checksum })),
    );
    assert.equal(ledgerHash(ledger), ledger.length === 275 ? LEDGER275 : LEDGER333);
    const rewards = (
      await db.query("SELECT paused,revision::text FROM reward_operations_control WHERE singleton")
    ).rows;
    assert.deepEqual(rewards, [{ paused: true, revision: "0" }]);
    return { identity, ledger: { count: ledger.length, sha256: ledgerHash(ledger) }, rewards };
  } finally {
    await db.query("ROLLBACK").catch(() => undefined);
    await db.end().catch(() => undefined);
  }
}

const phases = {
  dance: {
    attempt: "database-dance-grants-attempt.json",
    committed: "database-dance-grants-committed.json",
    file: DANCE_PLAN_FILE,
    timeouts: { statement_timeout: 10_000, query_timeout: 15_000 },
  },
  browser: {
    attempt: "database-browser-grants-attempt.json",
    committed: "database-browser-grants-committed.json",
    file: BROWSER_PLAN_FILE,
    timeouts: { statement_timeout: 15_000, query_timeout: 20_000 },
  },
} as const;

const MIGRATE_ATTEMPT = "database-migrate-attempt.json";
export function matches(row: any, expected: Record<string, unknown>, name: string) {
  for (const [key, value] of Object.entries(expected))
    assert.deepEqual(row[key], value, "Foreign record: " + name + "." + key);
}
function selectedPhase(phase: keyof typeof phases, review: any) {
  let selected: {
    attempt: string;
    committed: string;
    file: string;
    key: string;
    sent: string;
    timeouts: { statement_timeout: number; query_timeout: number };
  } = {
    ...phases[phase],
    key: "database-" + phase,
    sent: "database-" + phase + "-commit-sent.json",
  };
  const continuations = review.plan_continuations?.[phase] ?? [];
  assert.ok(
    Array.isArray(continuations) && continuations.length <= 4,
    "Unbounded plan continuation",
  );
  for (const continuation of continuations) {
    assert.ok(record(selected.attempt), "Continuation lacks predecessor attempt");
    assert.equal(continuation.predecessor_attempt_sha256, recordDigest(selected.attempt));
    assert.equal(
      resolution(selected.key, selected.attempt, review)?.conclusion,
      "not_committed",
      "Continuation requires reviewed proof of no commit",
    );
    assert.equal(continuation.accepted, true);
    assert.equal(continuation.reviewer_role, "independent_reviewer");
    assert.deepEqual(continuation.findings, []);
    const key = "database-" + phase + "-" + continuation.predecessor_attempt_sha256;
    selected = {
      ...selected,
      key,
      attempt: key + "-attempt.json",
      committed: key + "-committed.json",
      sent: key + "-commit-sent.json",
    };
  }
  return selected;
}

function planState(
  phase: keyof typeof phases,
  review: any,
): "none" | "unresolved" | "committed" | "resolved_not_committed" {
  const { attempt, committed, file, key, sent: sentName } = selectedPhase(phase, review);
  const expected = { source: SOURCE, role: RUNTIME, phase, plan_file_sha256: file };
  const started = record(attempt),
    done = record(committed),
    sent = record(sentName);
  assert.ok(started || !record(key + "-resolution.json"), "Downstream plan evidence lacks attempt");
  const resolved = started ? resolution(key, attempt, review) : undefined;
  return validateGrantPhaseState(
    { started, done, sent, resolved, attemptSha256: started ? recordDigest(attempt) : "" },
    expected,
    self(),
    review,
    phase,
  );
}
export function assertDatabasePlansCommitted(review: any) {
  for (const phase of ["dance", "browser"] as const)
    assert.equal(planState(phase, review), "committed", "Database plan is not committed");
}
function migrateAttempted(review: any) {
  const row = record(MIGRATE_ATTEMPT),
    readback = record("database-migrate-readback.json");
  assert.ok(row || !readback, "Migration readback lacks attempt");
  if (row) {
    matches(row, { source: SOURCE, from: 275, to: 333 }, MIGRATE_ATTEMPT);
    acceptedExecutor(row, self(), review, MIGRATE_ATTEMPT);
  }
  if (readback) assert.equal(readback.attempt_sha256, recordDigest(MIGRATE_ATTEMPT));
  return row !== undefined;
}

/** Pre-guards run read-only before consuming any attempt. COMMIT-sent precedes the wire call. */
async function runPlan(
  phase: keyof typeof phases,
  statements: readonly string[],
  ownerUrl: string,
) {
  const { review, admissionSha } = admitted(190_000, "grants", true);
  checkBackup(review);
  const { attempt, committed, file, timeouts, key, sent } = selectedPhase(phase, review);
  const db = deps.client({
    connectionString: ownerUrl,
    connectionTimeoutMillis: 5_000,
    ...timeouts,
  });
  let commitSent = false,
    attempted = false;
  const fields = {
    source: SOURCE,
    role: RUNTIME,
    phase,
    plan_file_sha256: file,
    executor_sha256: self(),
  };
  try {
    await db.connect();
    const mutation = statements.findIndex((statement) => /^(GRANT|REVOKE) /u.test(statement));
    assert.ok(mutation > 1);
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    for (const statement of statements.slice(1, mutation)) await db.query(statement);
    await db.query("ROLLBACK");
    admitted(190_000, "grants", true);
    checkBackup(review);
    save(attempt, {
      at: new Date(deps.now()).toISOString(),
      ...fields,
      admission_sha256: admissionSha,
    });
    attempted = true;
    for (const statement of statements) {
      admitted(20_000, "grants", true);
      if (statement === "COMMIT") {
        save(sent, {
          at: new Date(deps.now()).toISOString(),
          ...fields,
          attempt_sha256: recordDigest(attempt),
        });
        commitSent = true;
      }
      await db.query(statement);
    }
    save(committed, {
      at: new Date(deps.now()).toISOString(),
      ...fields,
      attempt_sha256: recordDigest(attempt),
    });
  } catch (error) {
    if (attempted && !commitSent) {
      try {
        await db.query("ROLLBACK");
        save(key + "-rollback-acknowledged.json", {
          at: new Date(deps.now()).toISOString(),
          ...fields,
          attempt_sha256: recordDigest(attempt),
          commit_sent: false,
        });
      } catch {
        /* Unknown rollback remains unresolved. */
      }
    }
    throw error;
  } finally {
    await db.query("ROLLBACK").catch(() => undefined);
    await db.end().catch(() => undefined);
  }
}

export async function main(mode = "preview", resolutionPath?: string) {
  assert.ok(["preview", "read", "init", "resolve", "migrate", "grants", "verify"].includes(mode));
  if (mode === "init") {
    assert.ok(resolutionPath);
    return initializeOperation(resolutionPath);
  }
  const { grant, browser } = localInputs();
  const migrations = await deps.loadMigrations();
  assert.equal(migrations.length, 333);
  assert.equal(ledgerHash(migrations.slice(0, 275)), LEDGER275);
  assert.equal(ledgerHash(migrations), LEDGER333);
  if (mode === "preview")
    return { preview: true, local_only: true, source: SOURCE, pending: 58, target: 333, writes: 0 };
  if (mode === "read") {
    const urls = await deps.managedUrls();
    return { read_only: true, evidence: evidenceDiagnostics(), ...(await ownerRead(urls.owner)) };
  }
  const authorization = admitted(190_000, mode, ["migrate", "grants", "resolve"].includes(mode));
  const { review, admissionSha } = authorization;
  if (mode === "resolve") {
    assert.ok(resolutionPath);
    writeResolution(resolutionPath, review);
    return { resolution_recorded: true, new_sql_write: false };
  }
  const migrated = migrateAttempted(review);
  const first = { dance: planState("dance", review), browser: planState("browser", review) };
  if (
    readdirSync(OPERATION_DIR).some((name) => name.startsWith("database-runtime-verification-"))
  ) {
    for (const phase of ["dance", "browser"] as const)
      assert.ok(record(phases[phase].attempt), "Verification evidence lacks upstream plan attempt");
  }
  assert.ok(first.dance !== "none" || first.browser === "none", "Browser plan precedes Dance plan");
  // A reviewed not-committed resolution supplies an honest abort route, never automatic replay.
  assert.ok(
    !Object.values(first).includes("resolved_not_committed"),
    "Reviewed release abort; any continuation requires a successor operation explicitly accepting all preserved predecessor evidence",
  );
  const blocked = Object.values(first).includes("unresolved");
  const urls = await deps.managedUrls();
  if (mode === "migrate") {
    if (migrated)
      return { reconcile_only: true, new_write: false, ...(await ownerRead(urls.owner)) };
    await ownerRead(urls.owner, 275);
    checkBackup(review);
    save(MIGRATE_ATTEMPT, {
      at: new Date(deps.now()).toISOString(),
      source: SOURCE,
      from: 275,
      to: 333,
      admission_sha256: admissionSha,
      executor_sha256: self(),
    });
    await deps.runMigrations({
      connectionString: urls.owner,
      migrations,
      expectedLedger: migrations
        .slice(0, 275)
        .map(({ version, checksum }) => ({ version, checksum })),
    });
    const after = await ownerRead(urls.owner, 333);
    save("database-migrate-readback.json", {
      at: new Date(deps.now()).toISOString(),
      attempt_sha256: recordDigest(MIGRATE_ATTEMPT),
      ...after,
    });
    return { accepted: true, new_write: true, ...after };
  }
  await ownerRead(urls.owner, 333);
  let wrote = false;
  if (mode === "grants" && !blocked) {
    checkBackup(review);
    if (first.dance === "none") {
      wrote = true;
      await runPlan("dance", grant.plan.statements, urls.owner);
    }
    if (first.browser === "none") {
      wrote = true;
      await runPlan("browser", browser.statements, urls.owner);
    }
  }
  assert.equal(await deps.servingPreflight(urls.runtime), RUNTIME);
  for (const consumer of consumers)
    assert.equal(await deps.dancePreflight(urls.runtime, consumer), RUNTIME);
  const final = [planState("dance", review), planState("browser", review)];
  const accepted = final.every((state) => state === "committed");
  const result = {
    at: new Date(deps.now()).toISOString(),
    admission_sha256: admissionSha,
    accepted,
    unresolved: final.includes("unresolved"),
    new_write: wrote,
    read_only_verification: !wrote,
    source: SOURCE,
    runtime: RUNTIME,
    consumers: 4,
    ledger: 333,
    executor_sha256: self(),
    dance_plan_file_sha256: DANCE_PLAN_FILE,
    browser_plan_file_sha256: BROWSER_PLAN_FILE,
  };
  save(
    (accepted ? "database-runtime-verification-" : "database-reconciliation-") +
      deps.now() +
      ".json",
    result,
  );
  return result;
}

if (import.meta.main)
  main(Bun.argv[2], Bun.argv[3])
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(
        JSON.stringify({
          success: false,
          name: error?.name,
          message:
            "Production database operation refused or unresolved. Preserve evidence; read mode remains available. Credentials and SQL diagnostics withheld.",
        }),
      );
      process.exitCode = 1;
    });
