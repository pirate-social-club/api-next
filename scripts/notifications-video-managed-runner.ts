import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { open, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ControlPlaneDb } from "@pirate/application";
import { Effect, Schema } from "effect";
import { NotificationsVideoAdmissionPlan } from "../packages/platform-cf/src/notifications-video-admission.ts";
import {
  CONTROL_PLANE_CONNECT_TIMEOUT_MS,
  makeDirectPostgresControlPlaneLayer,
  type PostgresClientFactory,
} from "../packages/platform-cf/src/postgres.ts";
import {
  NotificationsVideoAction,
  runNotificationsVideoAdmissionAction,
} from "./notifications-video-control-plane.ts";
import { normalizePostgresConnectionString } from "./postgres-connection-string.ts";
import { loadPostgresMigrations } from "./postgres-migrations.ts";

const Hash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u),
);
const Request = Schema.Struct({
  version: Schema.Literal(1),
  operation_id: Schema.String.check(
    Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
  ),
  action: NotificationsVideoAction,
  not_before: Timestamp,
  expires_at: Timestamp,
  source_commit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u)),
  target: Schema.Struct({
    hostname: Identifier,
    login: Identifier,
    principal: Identifier,
    database: Identifier,
  }),
  plan: NotificationsVideoAdmissionPlan,
});
type ManagedRequest = typeof Request.Type;
const root = fileURLToPath(new URL("../", import.meta.url));
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function requireCurrent(request: ManagedRequest, now: number) {
  const start = Date.parse(request.not_before);
  const end = Date.parse(request.expires_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || now < start || now >= end)
    throw new Error("video_admission_window_refused");
}

export function parseManagedVideoAdmissionRequest(value: unknown, now = Date.now()) {
  const request = Schema.decodeUnknownSync(Request, { onExcessProperty: "error" })(value);
  requireCurrent(request, now);
  return request;
}

/** The caller supplies an existing managed credential; it is never serialized. */
export function bindManagedVideoConnection(request: ManagedRequest, connection: string) {
  const url = new URL(connection);
  const allowed = new Set([
    "sslmode",
    "sslrootcert",
    "sslnegotiation",
    "application_name",
    "options",
  ]);
  const seen = new Set<string>();
  for (const [name] of url.searchParams) {
    if (!allowed.has(name) || seen.has(name)) throw new Error("video_admission_connection_refused");
    seen.add(name);
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname.endsWith(".psdb.cloud") ||
    url.hostname !== request.target.hostname ||
    url.port !== "5432" ||
    decodeURIComponent(url.username) !== request.target.login ||
    decodeURIComponent(url.pathname.slice(1)) !== request.target.database ||
    !url.password ||
    url.searchParams.get("sslmode") !== "verify-full" ||
    (seen.has("sslnegotiation") && url.searchParams.get("sslnegotiation") !== "direct")
  )
    throw new Error("video_admission_connection_refused");
  url.searchParams.set("options", "-c search_path=api_next,pg_catalog");
  return normalizePostgresConnectionString(url.toString());
}

export const preflightManagedVideoAdmission = Effect.fn("VideoAdmission.managedPreflight")(
  function* (
    db: ControlPlaneDb["Service"],
    request: ManagedRequest,
    migrations: readonly { version: string; checksum: string }[],
  ) {
    const identity = yield* db.execute<Record<string, unknown>>({
      label: "notifications.video.managed.identity",
      text: `SELECT session_user::text AS principal,current_user::text AS current_principal,
        current_database() AS database,current_schema() AS schema,
        pg_has_role(current_user,n.nspowner,'USAGE') AS schema_owner
        FROM pg_namespace n WHERE n.nspname='api_next'`,
      values: [],
      readonly: true,
    });
    const row = identity.rows[0];
    if (
      identity.rows.length !== 1 ||
      row?.principal !== request.target.principal ||
      row.current_principal !== request.target.principal ||
      row.database !== request.target.database ||
      row.schema !== "api_next" ||
      row.schema_owner !== true
    )
      throw new Error("video_admission_principal_refused");
    const ledger = yield* db.execute<{ version: string; checksum: string }>({
      label: "notifications.video.managed.ledger",
      text: "SELECT version,checksum FROM api_next.schema_migrations ORDER BY version",
      values: [],
      readonly: true,
    });
    if (
      ledger.rows.length !== migrations.length ||
      ledger.rows.some(
        (item, i) =>
          item.version !== migrations[i]?.version || item.checksum !== migrations[i]?.checksum,
      )
    )
      throw new Error("video_admission_ledger_refused");
    // Recheck after the connection and reads, immediately before dispatch.
    requireCurrent(request, Date.now());
    return { principal: row.principal, migrations: ledger.rows.length };
  },
);

async function durableJson(path: string, value: unknown) {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function receiptDirectoryPath(path: string) {
  const directory = await realpath(resolve(path));
  const canonicalRoot = await realpath(root);
  const within = relative(canonicalRoot, directory);
  if (within === "" || (!isAbsolute(within) && within !== ".." && !within.startsWith(`..${sep}`)))
    throw new Error("video_admission_receipts_must_be_outside_source");
  const info = await stat(directory);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
    throw new Error("video_admission_private_receipt_directory_required");
  // Persist the caller-created private directory's entire existing ancestor
  // chain before an intent can authorize any effect.
  for (let current = directory; ; current = dirname(current)) {
    const handle = await open(current, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (dirname(current) === current) break;
  }
  return directory;
}

class VideoAdmissionCloseFailed extends Error {
  constructor(readonly result: unknown) {
    super("video_admission_connection_close_failed");
  }
}

/** Uses the actual platform session/finalizer, including its logged close failures. */
export async function executeManagedVideoAdmission(
  request: ManagedRequest,
  connection: string,
  source: string,
  migrations: readonly { version: string; checksum: string }[],
  started: () => void,
  clientFactory?: PostgresClientFactory,
) {
  let connectionFailed = false;
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        yield* preflightManagedVideoAdmission(db, request, migrations);
        started();
        return yield* runNotificationsVideoAdmissionAction(
          db,
          request.action,
          request.plan,
          source,
        );
      }).pipe(
        Effect.provide(
          makeDirectPostgresControlPlaneLayer(connection, {
            ...(clientFactory ? { clientFactory } : {}),
            closeTimeoutMs: CONTROL_PLANE_CONNECT_TIMEOUT_MS,
            logger: {
              info: () => undefined,
              error: () => {
                connectionFailed = true;
              },
            },
          }),
        ),
      ),
    ),
  );
  if (connectionFailed) throw new VideoAdmissionCloseFailed(result);
  return result;
}

/** An existing intent always refuses replay, even when its result is absent. */
export async function recordManagedVideoAdmission(
  request: ManagedRequest,
  packetSha256: string,
  receiptDirectory: string,
  work: (started: () => void) => Promise<unknown>,
) {
  const directory = await receiptDirectoryPath(receiptDirectory);
  const prefix = resolve(directory, request.operation_id);
  requireCurrent(request, Date.now());
  await durableJson(`${prefix}.intent.json`, {
    operation_id: request.operation_id,
    packet_sha256: packetSha256,
    action: request.action,
    plan_sha256: request.plan.plan_sha256,
    at: new Date().toISOString(),
  });
  let effectStarted = false;
  try {
    const result = await work(() => {
      effectStarted = request.action !== "status";
    });
    const outcome = { acknowledged: true, unknown_effect: false, result };
    await durableJson(`${prefix}.result.json`, outcome);
    return outcome;
  } catch (error) {
    if (error instanceof VideoAdmissionCloseFailed) {
      const outcome = {
        acknowledged: false,
        sql_acknowledged: true,
        connection_closed: false,
        unknown_effect: false,
        code: "video_admission_connection_close_failed",
        result: error.result,
      };
      await durableJson(`${prefix}.failure.json`, outcome);
      return outcome;
    }
    // Do not expose driver causes or infer rollback from a failed observation.
    const outcome = {
      acknowledged: false,
      unknown_effect: effectStarted,
      code: effectStarted
        ? "video_admission_reconciliation_required"
        : "video_admission_not_started",
    };
    await durableJson(`${prefix}.failure.json`, outcome);
    return outcome;
  }
}

export async function runManagedVideoAdmission(args: readonly string[], connection?: string) {
  if (
    args[0] !== "--request" ||
    !args[1] ||
    (args.length !== 2 &&
      !(args.length === 6 && args[2] === "--execute" && args[4] === "--receipts"))
  )
    throw new Error(
      "usage: --request <json-file> [--execute <reviewed-packet-sha256> --receipts <directory>]",
    );
  const bytes = await readFile(args[1]);
  const request = parseManagedVideoAdmissionRequest(JSON.parse(bytes.toString("utf8")));
  const packetSha256 = sha256(bytes);
  const source = await readFile(
    new URL("../db/postgres/candidates/notifications-video-cutover.sql", import.meta.url),
    "utf8",
  );
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
  });
  if (
    commit !== request.source_commit ||
    dirty.trim() ||
    sha256(source) !== request.plan.cutover_source_sha256
  )
    throw new Error("video_admission_source_refused");
  if (args.length === 2)
    return {
      execute: false,
      packet_sha256: packetSha256,
      action: request.action,
      source_commit: commit,
    };
  if (!Schema.is(Hash)(args[3]) || args[3] !== packetSha256)
    throw new Error("video_admission_packet_digest_refused");
  if (!connection) throw new Error("CONTROL_PLANE_POSTGRES_ADMIN_URL_required");
  const boundConnection = bindManagedVideoConnection(request, connection);
  const migrations = await loadPostgresMigrations();
  return recordManagedVideoAdmission(request, packetSha256, args[5] as string, (started) =>
    executeManagedVideoAdmission(request, boundConnection, source, migrations, started),
  );
}

if (import.meta.main) {
  try {
    const result = await runManagedVideoAdmission(
      Bun.argv.slice(2),
      process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL,
    );
    console.log(JSON.stringify(result));
    if ("acknowledged" in result && !result.acknowledged) process.exitCode = 1;
  } catch {
    console.error(JSON.stringify({ code: "video_admission_runner_refused", acknowledged: false }));
    process.exitCode = 1;
  }
}
