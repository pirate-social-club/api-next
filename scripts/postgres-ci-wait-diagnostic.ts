import { createHash } from "node:crypto";
import { Client } from "pg";

export const postgresCiWaitDiagnosticsEnabled = (env: Readonly<typeof process.env>) =>
  env.CI === "true" && env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";

interface WaitRow {
  pid: number; state: string | null; wait_event_type: string | null; wait_event: string | null;
  blocking_pids: number[]; transaction_age_ms: number | null; query_age_ms: number | null;
  state_age_ms: number | null; query_digest: string | null;
}
const object = (value: unknown): value is object => typeof value === "object" && value !== null && !Array.isArray(value);
const pid = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647;
const age = (value: unknown): value is number | null => value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
const state = (value: unknown): value is string | null => value === null || value === "active" || value === "idle" || value === "idle in transaction"
  || value === "idle in transaction (aborted)" || value === "fastpath function call" || value === "disabled";
const wait = (value: unknown): value is string | null => value === null || (typeof value === "string" && /^[A-Za-z0-9_]{1,64}$/u.test(value));
/** Named-field projection ONLY: extra driver/row properties can never enter logs. */
export function safePostgresWaitRows(rows: readonly unknown[], ownPid: number): WaitRow[] {
  if (rows.length > 128) throw new Error("Diagnostic sample exceeded its finite row bound");
  return rows.flatMap(row => {
    if (!object(row) || !("pid" in row) || !pid(row.pid) || row.pid === 0
      || !("state" in row) || !state(row.state) || !("wait_event_type" in row) || !wait(row.wait_event_type)
      || !("wait_event" in row) || !wait(row.wait_event) || !("blocking_pids" in row) || !Array.isArray(row.blocking_pids)
      || row.blocking_pids.length > 128 || !row.blocking_pids.every(pid)
      || !("transaction_age_ms" in row) || !age(row.transaction_age_ms)
      || !("query_age_ms" in row) || !age(row.query_age_ms) || !("state_age_ms" in row) || !age(row.state_age_ms)
      || !("query_digest" in row) || (row.query_digest !== null && (typeof row.query_digest !== "string" || !/^[a-f0-9]{32}$/u.test(row.query_digest))))
      throw new Error("Diagnostic sample shape unavailable");
    if (row.pid === ownPid) return [];
    return [{ pid: row.pid, state: row.state, wait_event_type: row.wait_event_type, wait_event: row.wait_event,
      blocking_pids: row.blocking_pids.filter(value => value !== ownPid), transaction_age_ms: row.transaction_age_ms,
      query_age_ms: row.query_age_ms, state_age_ms: row.state_age_ms, query_digest: row.query_digest }];
  });
}
/** pg owns this native PID after BackendKeyData; never enumerate/log the Client or secretKey. */
const nativePid = (client: unknown): number | null => object(client) && "processID" in client && pid(client.processID) && client.processID > 0 ? client.processID : null;

const sampleSql = `SELECT pid,state,wait_event_type,wait_event,
  pg_catalog.pg_blocking_pids(pid) AS blocking_pids,
  CASE WHEN xact_start IS NULL THEN NULL ELSE GREATEST(0,EXTRACT(EPOCH FROM (clock_timestamp()-xact_start))*1000)::double precision END AS transaction_age_ms,
  CASE WHEN query_start IS NULL THEN NULL ELSE GREATEST(0,EXTRACT(EPOCH FROM (clock_timestamp()-query_start))*1000)::double precision END AS query_age_ms,
  CASE WHEN state_change IS NULL THEN NULL ELSE GREATEST(0,EXTRACT(EPOCH FROM (clock_timestamp()-state_change))*1000)::double precision END AS state_age_ms,
  CASE WHEN query IS NULL THEN NULL ELSE pg_catalog.md5(query) END AS query_digest
 FROM pg_catalog.pg_stat_activity
 WHERE datname=pg_catalog.current_database() AND backend_type='client backend' AND pid<>pg_catalog.pg_backend_pid()
 ORDER BY pid LIMIT 128`;

interface DiagnosticClient {
  connect(): Promise<void>; query(text: string): Promise<{ rows: readonly unknown[] }>;
  end(): Promise<void>; destroy(): void; pid(): number | null;
  onError(listener: () => void): void;
}
interface Options {
  enabled: boolean; connectionString: string; label: string; maximumLifetimeMs: number;
  client?: DiagnosticClient; emit?: (event: object) => void;
  intervalMs?: number; closeTimeoutMs?: number;
}
function actualDiagnosticClient(connectionString: string): DiagnosticClient {
  const url = new URL(connectionString), priorOptions = url.searchParams.get("options")?.trim();
  // Startup session settings affect ONLY this separate observer connection.
  url.searchParams.set("options", [priorOptions, "-c search_path=pg_catalog -c default_transaction_read_only=on -c statement_timeout=1500 -c idle_session_timeout=5000"].filter(Boolean).join(" "));
  const client = new Client({ connectionString: url.toString(), application_name: "api-next-ci-wait-diagnostic", connectionTimeoutMillis: 2_000, query_timeout: 2_000 });
  return { connect: () => client.connect(), query: text => client.query(text), end: () => client.end(),
    destroy: () => client.connection.stream.destroy(), pid: () => nativePid(client), onError: listener => { client.on("error", listener); } };
}
/** One owned, read-only connection; no schema, grant, provider or runtime changes. */
export function startPostgresCiWaitDiagnostic(options: Options): { stop(): Promise<void> } {
  if (!options.enabled) return { stop: async () => {} };
  const interval = options.intervalMs ?? 500, closeTimeout = options.closeTimeoutMs ?? 2_000;
  if (!Number.isFinite(options.maximumLifetimeMs) || options.maximumLifetimeMs < 1 || options.maximumLifetimeMs > 900_000
    || !Number.isFinite(interval) || interval < 1 || interval > 5_000
    || !Number.isFinite(closeTimeout) || closeTimeout < 1 || closeTimeout > 5_000) throw new Error("Invalid finite PostgreSQL diagnostic bounds");
  const emit = options.emit ?? (event => console.log("postgres_ci_wait_diagnostic", JSON.stringify(event)));
  // Label is owned runner text; keep only its digest so callers cannot export arbitrary data.
  const childDigest = createHash("sha256").update(options.label).digest("hex"), began = Date.now();
  const client = options.client ?? actualDiagnosticClient(options.connectionString);
  let stopped = false, samples = 0, failures = 0, sequence = 0, stopPromise: Promise<void> | undefined;
  let sleepTimer: ReturnType<typeof setTimeout> | undefined, wake: (() => void) | undefined;
  const output = (event: object) => { try { emit({ sequence: ++sequence, elapsed_ms: Date.now()-began, child_digest: childDigest, ...event }); } catch { failures += 1; } };
  client.onError(() => { if (stopped) return; failures += 1; output({ event: "connection_failed" }); void stop().catch(() => {}); });
  const loop = Promise.resolve().then(async () => {
    try {
      if (stopped) return;
      await client.connect();
      if (stopped) { client.destroy(); return; }
      const ownPid = client.pid();
      if (ownPid === null) throw new Error("Observer native PID unavailable");
      output({ event: "started", pid: ownPid });
      while (!stopped) {
        try {
          const result = await client.query(sampleSql);
          if (stopped) break;
          output({ event: "sample", row_limit_reached: result.rows.length === 128, rows: safePostgresWaitRows(result.rows, ownPid) }); samples += 1;
        } catch { if (!stopped) { failures += 1; output({ event: "sample_failed" }); } }
        if (!stopped) await new Promise<void>(resolve => { wake = resolve; sleepTimer = setTimeout(resolve, interval); });
        wake = undefined; sleepTimer = undefined;
      }
    } catch { if (!stopped) { failures += 1; output({ event: "connect_failed" }); } }
  });
  const lifetime = setTimeout(() => { output({ event: "maximum_lifetime" }); void stop().catch(() => {}); }, options.maximumLifetimeMs);
  function stop(): Promise<void> {
    if (stopPromise !== undefined) return stopPromise;
    stopped = true; clearTimeout(lifetime);
    if (sleepTimer !== undefined) clearTimeout(sleepTimer); wake?.();
    // Read-only probe has nothing to commit. Destroy its own socket to cancel
    // connecting/in-flight work immediately, including error/termination paths.
    client.destroy();
    const closing = Promise.resolve().then(() => client.end());
    stopPromise = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = Promise.allSettled([loop, closing]);
      const result = await Promise.race([done, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), closeTimeout); })]);
      if (timer !== undefined) clearTimeout(timer);
      const complete = result !== null && result.every(item => item.status === "fulfilled");
      output({ event: "stopped", samples, failures, complete, capture_available: samples > 0 && failures === 0 });
      if (!complete) throw new Error("PostgreSQL diagnostics did not release its owned connection");
    })();
    return stopPromise;
  }
  return { stop };
}

let fixtureSequence = 0;
/** Transaction-order breadcrumbs with nativePID+schema digest only; zero extra SQL. */
export function emitPostgresCiFixturePhase(phase: "queued" | "connected" | "prepare_started" | "prepare_finished" | "use_started" | "use_finished" | "rollback_started" | "disconnected" | "released" | "cleanup_started" | "cleanup_finished", schema: string, client?: unknown): void {
  if (!postgresCiWaitDiagnosticsEnabled(process.env)) return;
  try { console.log("postgres_ci_fixture_phase", JSON.stringify({ sequence: ++fixtureSequence, elapsed_ms: performance.now(),
    phase, pid: nativePid(client), fixture_digest: createHash("sha256").update(schema).digest("hex") })); } catch { /* Diagnostic IO cannot replace the original fixture outcome. */ }
}
