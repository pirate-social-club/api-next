import {
  ControlPlaneAcquireFailed,
  ControlPlaneDb,
  type ControlPlaneError,
  ControlPlaneOperationTimedOut,
  type ControlPlaneResult,
  type ControlPlaneStatement,
  ControlPlaneStatementFailed,
  type ControlPlaneTransaction,
  ControlPlaneTransactionOutcomeUnknown,
} from "@pirate/application";
import { Effect, Exit, Layer } from "effect";
import type { ClientConfig } from "pg";

export { ControlPlaneDb } from "@pirate/application";

/**
 * The old API's runtime-deps.ts used these exact client-side bounds:
 * api/services/api/src/lib/runtime-deps.ts:30-46 and :518-551.
 * Keep the values in one place so a driver or adapter change cannot silently
 * widen the control-plane deadline.
 */
export const CONTROL_PLANE_CONNECT_TIMEOUT_MS = 5_000;
export const CONTROL_PLANE_STATEMENT_TIMEOUT_MS = 15_000;
export const CONTROL_PLANE_IDLE_TRANSACTION_TIMEOUT_MS = 30_000;

/**
 * Slow logging is inclusive at one second, matching the old request-scoped
 * client path in api/services/api/src/lib/runtime-deps.ts:603-685.
 */
export const CONTROL_PLANE_SLOW_STATEMENT_MS = 1_000;

/**
 * Hyperdrive pools origin connections in transaction mode and resets session
 * state when a transaction returns to the pool. Pin the accepted clean-break
 * schema inside every transaction rather than relying on startup/session state.
 */
export const CONTROL_PLANE_HYPERDRIVE_SEARCH_PATH = "api_next,pg_catalog";

export interface PostgresStreamLike {
  readonly destroy: (reason?: Error) => unknown;
}

export interface PostgresQueryResult {
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount: number | null;
}

export type PostgresQueryResponse = PostgresQueryResult | readonly PostgresQueryResult[];

/** The small driver surface makes abort ordering testable without a database. */
export interface PostgresClientLike {
  readonly connection?: { readonly stream?: PostgresStreamLike };
  readonly connect: () => Promise<void>;
  readonly query: (config: PostgresQueryConfig) => Promise<PostgresQueryResponse>;
  readonly end: () => Promise<void>;
}

export interface PostgresQueryConfig {
  readonly text: string;
  readonly values?: readonly unknown[];
}

export type PostgresClientFactory = (
  connectionString: string,
  config: ClientConfig,
) => PostgresClientLike | PromiseLike<PostgresClientLike>;

export interface HyperdriveConnection {
  readonly connectionString: string;
}

export type ControlPlaneLogValue = string | number | null;

export type ControlPlaneLogFields = Readonly<Record<string, ControlPlaneLogValue>>;

export interface ControlPlaneLogger {
  readonly info: (event: string, fields: ControlPlaneLogFields) => void;
  readonly error: (event: string, fields: ControlPlaneLogFields) => void;
}

export interface PostgresControlPlaneOptions {
  readonly clientFactory?: PostgresClientFactory;
  readonly logger?: ControlPlaneLogger;
  readonly now?: () => number;
  readonly connectTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
}

const DEFAULT_LOGGER: ControlPlaneLogger = {
  info: (event, fields) => {
    console.info(event, fields);
  },
  error: (event, fields) => {
    console.error(event, fields);
  },
};

const defaultClientFactory: PostgresClientFactory = async (_connectionString, config) => {
  const { Client } = await import("pg");
  const client = new Client(config);
  return {
    connection: client.connection,
    connect: () => client.connect(),
    query: ({ text, values }) =>
      client.query({
        text,
        values: values === undefined ? [] : [...values],
      }) as unknown as Promise<PostgresQueryResponse>,
    end: () => client.end(),
  };
};

/**
 * A simple-protocol multi-statement query returns results in statement order.
 * The platform port exposes one result shape, so the final driver result is
 * authoritative; a null rowCount falls back to that result's row count.
 */
function finalQueryResult(result: PostgresQueryResponse): PostgresQueryResult {
  if (!Array.isArray(result)) return result as PostgresQueryResult;
  const results = result as readonly PostgresQueryResult[];
  const final = results[results.length - 1];
  if (final === undefined) throw new Error("Postgres returned no query results");
  return final;
}

function elapsedSince(startedAt: number, now: () => number): number {
  return Math.max(0, now() - startedAt);
}

function isTimeoutError(error: unknown): error is { readonly _tag: "TimeoutError" } {
  return (
    typeof error === "object" && error !== null && "_tag" in error && error._tag === "TimeoutError"
  );
}

function safeSqlState(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = error.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

function safeConstraint(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("constraint" in error)) return null;
  return typeof error.constraint === "string" ? error.constraint : null;
}

function errorCertainty(error: unknown, fenced: boolean): "completed" | "aborted" | "unknown" {
  if (fenced) return "aborted";
  return safeSqlState(error) === null ? "unknown" : "completed";
}

function outcomeUnknown(
  phase: "commit" | "rollback",
  startedAt: number,
  now: () => number,
): ControlPlaneTransactionOutcomeUnknown {
  return new ControlPlaneTransactionOutcomeUnknown({
    phase,
    label: `control-plane.transaction.${phase}`,
    limitMs: CONTROL_PLANE_STATEMENT_TIMEOUT_MS,
    elapsedMs: elapsedSince(startedAt, now),
  });
}

class PostgresSession {
  private connected = false;
  private fenced = false;
  // True only between a successful BEGIN and the moment COMMIT is handed to the
  // driver. Socket destruction proves rollback ONLY inside that window: a bare
  // autocommit statement (or an in-flight COMMIT) can complete server-side
  // after the client destroys its socket, so its outcome stays "unknown".
  private inTransaction = false;
  private terminationState: "not-requested" | "aborted" | "unknown" = "not-requested";
  private terminationPromise: Promise<void> | undefined;

  constructor(
    private readonly client: PostgresClientLike,
    private readonly logger: ControlPlaneLogger,
    private readonly now: () => number,
    private readonly transactionSearchPath?: string,
    private readonly readOnly = false,
    private readonly connectTimeoutMs = CONTROL_PLANE_CONNECT_TIMEOUT_MS,
    private readonly statementTimeoutMs = CONTROL_PLANE_STATEMENT_TIMEOUT_MS,
  ) {}

  get isFenced(): boolean {
    return this.fenced;
  }

  get isAborted(): boolean {
    return this.terminationState === "aborted";
  }

  connect(): Effect.Effect<void, ControlPlaneError> {
    const startedAt = this.now();
    const connection = Effect.tryPromise({
      try: () => this.client.connect(),
      catch: () =>
        new ControlPlaneAcquireFailed({
          phase: "connection",
          limitMs: this.connectTimeoutMs,
          elapsedMs: elapsedSince(startedAt, this.now),
        }),
    });
    const interrupted = connection.pipe(Effect.onInterrupt(() => this.terminateEffect()));
    return Effect.timeout(interrupted, this.connectTimeoutMs).pipe(
      Effect.catchIf(
        isTimeoutError,
        () =>
          Effect.fail(
            new ControlPlaneOperationTimedOut({
              label: "control-plane.connect",
              limitMs: this.connectTimeoutMs,
              elapsedMs: elapsedSince(startedAt, this.now),
              outcomeCertainty: this.isAborted ? "aborted" : "unknown",
            }),
          ),
        (error) => Effect.fail(error as ControlPlaneError),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          this.connected = true;
          const elapsedMs = elapsedSince(startedAt, this.now);
          if (elapsedMs >= CONTROL_PLANE_SLOW_STATEMENT_MS) {
            this.logger.info("control-plane connection slow", {
              phase: "connection",
              elapsedMs,
              limitMs: this.connectTimeoutMs,
            });
          }
        }),
      ),
    );
  }

  execute<Row = unknown>(
    statement: ControlPlaneStatement,
  ): Effect.Effect<ControlPlaneResult<Row>, ControlPlaneError> {
    if (this.readOnly && !statement.readonly) {
      return Effect.fail(
        new ControlPlaneStatementFailed({
          label: statement.label,
          sqlState: null,
          constraint: null,
          outcomeCertainty: "not-started",
        }),
      );
    }
    if (this.transactionSearchPath !== undefined && !this.inTransaction) {
      return this.withTransaction((transaction) => transaction.execute<Row>(statement));
    }
    return this.executeStatement<Row>(statement);
  }

  private executeStatement<Row = unknown>(
    statement: ControlPlaneStatement,
  ): Effect.Effect<ControlPlaneResult<Row>, ControlPlaneError> {
    if (!this.connected || this.fenced) {
      return Effect.fail(
        new ControlPlaneOperationTimedOut({
          label: statement.label,
          limitMs: this.statementTimeoutMs,
          elapsedMs: 0,
          outcomeCertainty: this.fenced ? "aborted" : "not-started",
        }),
      );
    }

    const startedAt = this.now();
    const query = Effect.tryPromise({
      try: () =>
        this.client.query({
          text: statement.text,
          values: [...statement.values],
        }),
      catch: (error) =>
        new ControlPlaneStatementFailed({
          label: statement.label,
          sqlState: safeSqlState(error),
          constraint: safeConstraint(error),
          outcomeCertainty: errorCertainty(error, this.fenced),
        }),
    });
    const interrupted = query.pipe(Effect.onInterrupt(() => this.terminateEffect()));
    return Effect.timeout(interrupted, this.statementTimeoutMs).pipe(
      Effect.catchIf(
        isTimeoutError,
        () =>
          Effect.fail(
            new ControlPlaneOperationTimedOut({
              label: statement.label,
              limitMs: this.statementTimeoutMs,
              elapsedMs: elapsedSince(startedAt, this.now),
              outcomeCertainty: this.isAborted && this.inTransaction ? "aborted" : "unknown",
            }),
          ),
        (error) => Effect.fail(error as ControlPlaneError),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          const elapsedMs = elapsedSince(startedAt, this.now);
          if (elapsedMs >= CONTROL_PLANE_SLOW_STATEMENT_MS) {
            this.logger.info("control-plane statement slow", {
              label: statement.label,
              elapsedMs,
              limitMs: this.statementTimeoutMs,
            });
          }
        }),
      ),
      Effect.map((result) => {
        const final = finalQueryResult(result);
        return {
          rows: final.rows as readonly Row[],
          rowCount: final.rowCount ?? final.rows.length,
        };
      }),
    );
  }

  withTransaction<A, E, R>(
    use: (transaction: ControlPlaneTransaction) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | ControlPlaneError, R> {
    return Effect.acquireUseRelease(this.beginTransaction(), use, (transaction, exit) =>
      this.finishTransaction(transaction, exit),
    );
  }

  closeEffect(): Effect.Effect<void, never> {
    return Effect.tryPromise({
      try: () => this.close(),
      catch: () => undefined,
    }).pipe(Effect.ignore);
  }

  private beginTransaction(): Effect.Effect<PostgresTransaction, ControlPlaneError> {
    const session = this;
    return Effect.gen(function* () {
      yield* session.executeInternal({
        label: "control-plane.transaction.begin",
        text: "BEGIN",
        values: [],
        readonly: false,
      });
      yield* Effect.sync(() => {
        session.inTransaction = true;
      });
      yield* session.executeInternal({
        label: "control-plane.transaction.statement-timeout",
        text: "SELECT set_config('statement_timeout', $1, true)",
        values: [`${session.statementTimeoutMs}ms`],
        readonly: false,
      });
      yield* session.executeInternal({
        label: "control-plane.transaction.idle-timeout",
        text: "SELECT set_config('idle_in_transaction_session_timeout', $1, true)",
        values: [`${CONTROL_PLANE_IDLE_TRANSACTION_TIMEOUT_MS}ms`],
        readonly: false,
      });
      if (session.transactionSearchPath !== undefined) {
        yield* session.executeInternal({
          label: "control-plane.transaction.search-path",
          text: "SELECT set_config('search_path', $1, true)",
          values: [session.transactionSearchPath],
          readonly: false,
        });
      }
      return new PostgresTransaction(session);
    });
  }

  private finishTransaction<A, E>(
    transaction: PostgresTransaction,
    exit: Exit.Exit<A, E>,
  ): Effect.Effect<void, ControlPlaneError> {
    if (transaction.closed) return Effect.void;
    transaction.closed = true;
    if (this.fenced) return Effect.void;

    const phase = Exit.isSuccess(exit) ? "commit" : "rollback";
    // COMMIT leaves the provable-rollback window BEFORE it is handed to the
    // driver: once sent, destroying the socket cannot prove the commit did not
    // apply. ROLLBACK stays inside the window - disconnect mid-rollback still
    // rolls back server-side.
    if (phase === "commit") this.inTransaction = false;
    const startedAt = this.now();
    return this.executeInternal({
      label: `control-plane.transaction.${phase}`,
      text: phase === "commit" ? "COMMIT" : "ROLLBACK",
      values: [],
      readonly: false,
    }).pipe(
      Effect.mapError(() => outcomeUnknown(phase, startedAt, this.now)),
      Effect.ensuring(
        Effect.sync(() => {
          this.inTransaction = false;
        }),
      ),
      Effect.asVoid,
    );
  }

  private executeInternal<Row = unknown>(
    statement: ControlPlaneStatement,
  ): Effect.Effect<ControlPlaneResult<Row>, ControlPlaneError> {
    return this.executeStatement(statement);
  }

  private terminateEffect(): Effect.Effect<void, never> {
    return Effect.tryPromise({
      try: () => this.terminate(),
      catch: () => undefined,
    }).pipe(Effect.ignore);
  }

  private async terminate(): Promise<void> {
    if (this.terminationPromise !== undefined) return this.terminationPromise;
    this.fenced = true;
    this.terminationState = "unknown";
    this.terminationPromise = (async () => {
      let streamDestroyed = false;
      try {
        const stream = this.client.connection?.stream;
        if (stream !== undefined) {
          stream.destroy();
          streamDestroyed = true;
        }
      } catch {
        this.logger.error("control-plane connection termination failed", {
          phase: "stream-destroy",
        });
      }
      if (streamDestroyed) {
        this.terminationState = "aborted";
        try {
          void this.client.end().catch(() => {
            this.logger.error("control-plane connection termination failed", {
              phase: "client-end",
            });
          });
        } catch {
          this.logger.error("control-plane connection termination failed", {
            phase: "client-end",
          });
        }
        return;
      }
      try {
        await this.client.end();
      } catch {
        this.logger.error("control-plane connection termination failed", {
          phase: "client-end",
        });
      }
    })();
    return this.terminationPromise;
  }

  private async close(): Promise<void> {
    if (this.terminationPromise !== undefined) {
      await this.terminationPromise;
      return;
    }
    try {
      await this.client.end();
    } catch {
      this.logger.error("control-plane connection close failed", { phase: "scope-release" });
    }
  }
}

class PostgresTransaction implements ControlPlaneTransaction {
  closed = false;

  constructor(private readonly session: PostgresSession) {}

  execute<Row = unknown>(
    statement: ControlPlaneStatement,
  ): Effect.Effect<ControlPlaneResult<Row>, ControlPlaneError> {
    if (this.closed) {
      return Effect.fail(
        new ControlPlaneStatementFailed({
          label: statement.label,
          sqlState: null,
          constraint: null,
          outcomeCertainty: "not-started",
        }),
      );
    }
    return this.session.execute(statement);
  }
}

function makeClientConfig(
  connectionString: string,
  readOnly: boolean,
  options: PostgresControlPlaneOptions,
): ClientConfig {
  return {
    connectionString,
    connectionTimeoutMillis: options.connectTimeoutMs ?? CONTROL_PLANE_CONNECT_TIMEOUT_MS,
    statement_timeout: options.statementTimeoutMs ?? CONTROL_PLANE_STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: CONTROL_PLANE_IDLE_TRANSACTION_TIMEOUT_MS,
    ...(readOnly ? { options: "-c default_transaction_read_only=on" } : {}),
  };
}

function makeControlPlaneLayer(
  connectionString: string,
  options: PostgresControlPlaneOptions = {},
  transactionSearchPath?: string,
  readOnly = false,
) {
  const clientFactory = options.clientFactory ?? defaultClientFactory;
  const logger = options.logger ?? DEFAULT_LOGGER;
  const now = options.now ?? Date.now;

  return Layer.effect(
    ControlPlaneDb,
    Effect.gen(function* () {
      const session = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            Promise.resolve(
              clientFactory(
                connectionString,
                makeClientConfig(connectionString, readOnly, options),
              ),
            ).then(
              (client) =>
                new PostgresSession(
                  client,
                  logger,
                  now,
                  transactionSearchPath,
                  readOnly,
                  options.connectTimeoutMs,
                  options.statementTimeoutMs,
                ),
            ),
          catch: () =>
            new ControlPlaneAcquireFailed({
              phase: "acquisition",
              limitMs: CONTROL_PLANE_CONNECT_TIMEOUT_MS,
              elapsedMs: 0,
            }),
        }),
        (resource) => resource.closeEffect(),
        { interruptible: true },
      );
      yield* session.connect();
      return {
        execute: <Row = unknown>(statement: ControlPlaneStatement) =>
          session.execute<Row>(statement),
        withTransaction: <A, E, R>(
          use: (transaction: ControlPlaneTransaction) => Effect.Effect<A, E, R>,
        ) => session.withTransaction(use),
      } satisfies ControlPlaneDb["Service"];
    }),
  );
}

/** Production constructor: Hyperdrive supplies the pooled connection string. */
export function makeHyperdriveControlPlaneLayer(
  hyperdrive: HyperdriveConnection,
  options?: PostgresControlPlaneOptions,
) {
  return makeControlPlaneLayer(
    hyperdrive.connectionString,
    options,
    CONTROL_PLANE_HYPERDRIVE_SEARCH_PATH,
  );
}

/** Test constructor: accepts a direct Postgres URL and an injectable client. */
export function makeDirectPostgresControlPlaneLayer(
  connectionString: string,
  options?: PostgresControlPlaneOptions,
) {
  return makeControlPlaneLayer(connectionString, options);
}

/**
 * Source-closed VPS constructor for a separately credentialed read-only
 * authority resolver. It selects the clean-break schema transactionally,
 * requests server-side read-only transactions, and rejects any statement not
 * declared read-only before it reaches the driver.
 */
export function makeReadOnlyPostgresControlPlaneLayer(
  connectionString: string,
  options?: PostgresControlPlaneOptions,
) {
  return makeControlPlaneLayer(
    connectionString,
    options,
    CONTROL_PLANE_HYPERDRIVE_SEARCH_PATH,
    true,
  );
}
