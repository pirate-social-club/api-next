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

export interface PostgresStreamLike {
  readonly destroy: (reason?: Error) => unknown;
}

/** The small driver surface makes abort ordering testable without a database. */
export interface PostgresClientLike {
  readonly connection?: { readonly stream?: PostgresStreamLike };
  readonly connect: () => Promise<void>;
  readonly query: (config: PostgresQueryConfig) => Promise<{
    readonly rows: readonly Record<string, unknown>[];
    readonly rowCount: number | null;
  }>;
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
      client.query({ text, values: values === undefined ? [] : [...values] }).then((result) => ({
        rows: result.rows as readonly Record<string, unknown>[],
        rowCount: result.rowCount,
      })),
    end: () => client.end(),
  };
};

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
  private terminationState: "not-requested" | "aborted" | "unknown" = "not-requested";
  private terminationPromise: Promise<void> | undefined;

  constructor(
    private readonly client: PostgresClientLike,
    private readonly logger: ControlPlaneLogger,
    private readonly now: () => number,
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
          limitMs: CONTROL_PLANE_CONNECT_TIMEOUT_MS,
          elapsedMs: elapsedSince(startedAt, this.now),
        }),
    });
    const interrupted = connection.pipe(Effect.onInterrupt(() => this.terminateEffect()));
    return Effect.timeout(interrupted, CONTROL_PLANE_CONNECT_TIMEOUT_MS).pipe(
      Effect.catchIf(
        isTimeoutError,
        () =>
          Effect.fail(
            new ControlPlaneOperationTimedOut({
              label: "control-plane.connect",
              limitMs: CONTROL_PLANE_CONNECT_TIMEOUT_MS,
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
              limitMs: CONTROL_PLANE_CONNECT_TIMEOUT_MS,
            });
          }
        }),
      ),
    );
  }

  execute<Row = unknown>(
    statement: ControlPlaneStatement,
  ): Effect.Effect<ControlPlaneResult<Row>, ControlPlaneError> {
    if (!this.connected || this.fenced) {
      return Effect.fail(
        new ControlPlaneOperationTimedOut({
          label: statement.label,
          limitMs: CONTROL_PLANE_STATEMENT_TIMEOUT_MS,
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
    return Effect.timeout(interrupted, CONTROL_PLANE_STATEMENT_TIMEOUT_MS).pipe(
      Effect.catchIf(
        isTimeoutError,
        () =>
          Effect.fail(
            new ControlPlaneOperationTimedOut({
              label: statement.label,
              limitMs: CONTROL_PLANE_STATEMENT_TIMEOUT_MS,
              elapsedMs: elapsedSince(startedAt, this.now),
              outcomeCertainty: this.isAborted ? "aborted" : "unknown",
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
              limitMs: CONTROL_PLANE_STATEMENT_TIMEOUT_MS,
            });
          }
        }),
      ),
      Effect.map((result) => ({
        rows: result.rows as readonly Row[],
        rowCount: result.rowCount ?? result.rows.length,
      })),
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
      yield* session.executeInternal({
        label: "control-plane.transaction.statement-timeout",
        text: "SELECT set_config('statement_timeout', $1, true)",
        values: [`${CONTROL_PLANE_STATEMENT_TIMEOUT_MS}ms`],
        readonly: false,
      });
      yield* session.executeInternal({
        label: "control-plane.transaction.idle-timeout",
        text: "SELECT set_config('idle_in_transaction_session_timeout', $1, true)",
        values: [`${CONTROL_PLANE_IDLE_TRANSACTION_TIMEOUT_MS}ms`],
        readonly: false,
      });
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
    const startedAt = this.now();
    return this.executeInternal({
      label: `control-plane.transaction.${phase}`,
      text: phase === "commit" ? "COMMIT" : "ROLLBACK",
      values: [],
      readonly: false,
    }).pipe(
      Effect.mapError(() => outcomeUnknown(phase, startedAt, this.now)),
      Effect.asVoid,
    );
  }

  private executeInternal<Row = unknown>(
    statement: ControlPlaneStatement,
  ): Effect.Effect<ControlPlaneResult<Row>, ControlPlaneError> {
    return this.execute(statement);
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

function makeClientConfig(connectionString: string): ClientConfig {
  return {
    connectionString,
    connectionTimeoutMillis: CONTROL_PLANE_CONNECT_TIMEOUT_MS,
    statement_timeout: CONTROL_PLANE_STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: CONTROL_PLANE_IDLE_TRANSACTION_TIMEOUT_MS,
  };
}

function makeControlPlaneLayer(
  connectionString: string,
  options: PostgresControlPlaneOptions = {},
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
              clientFactory(connectionString, makeClientConfig(connectionString)),
            ).then((client) => new PostgresSession(client, logger, now)),
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
  return makeControlPlaneLayer(hyperdrive.connectionString, options);
}

/** Test constructor: accepts a direct Postgres URL and an injectable client. */
export function makeDirectPostgresControlPlaneLayer(
  connectionString: string,
  options?: PostgresControlPlaneOptions,
) {
  return makeControlPlaneLayer(connectionString, options);
}
