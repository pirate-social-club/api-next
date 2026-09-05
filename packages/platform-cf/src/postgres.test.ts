import { describe, expect, test } from "bun:test";
import { ControlPlaneDb } from "@pirate/application";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import type { ClientConfig } from "pg";
import { HnsAuthorityDiagnostic, withHnsAuthoritySpan } from "./hns-authority-diagnostics.ts";
import {
  CONTROL_PLANE_CONNECT_TIMEOUT_MS,
  CONTROL_PLANE_HYPERDRIVE_SEARCH_PATH,
  CONTROL_PLANE_IDLE_TRANSACTION_TIMEOUT_MS,
  CONTROL_PLANE_SLOW_STATEMENT_MS,
  CONTROL_PLANE_STATEMENT_TIMEOUT_MS,
  type ControlPlaneLogFields,
  type ControlPlaneLogger,
  makeDirectPostgresControlPlaneLayer,
  makeHyperdriveControlPlaneLayer,
  makeReadOnlyPostgresControlPlaneLayer,
  type PostgresClientLike,
  type PostgresQueryConfig,
  type PostgresQueryResult,
} from "./postgres";
import type { WorkerDiagnosticFields } from "./worker-request-diagnostics.ts";

const statement = {
  label: "community.lookup",
  text: "SELECT id FROM communities WHERE id = $1",
  values: ["community_9"],
  readonly: true,
} as const;

class FakePostgresClient implements PostgresClientLike {
  readonly events: string[] = [];
  readonly queries: PostgresQueryConfig[] = [];
  readonly connection = {
    stream: {
      destroy: (_reason?: Error) => {
        this.events.push("destroy");
        const reject = this.pendingReject;
        this.pendingReject = undefined;
        reject?.(new Error("fake socket destroyed"));
      },
    },
  };
  private pendingReject: ((reason: unknown) => void) | undefined;
  private readonly currentTime: { value: number } | undefined;

  constructor(currentTime?: { value: number }) {
    this.currentTime = currentTime;
  }

  connect(): Promise<void> {
    this.events.push("connect");
    return Promise.resolve();
  }

  query(
    config: PostgresQueryConfig,
  ): Promise<PostgresQueryResult | readonly PostgresQueryResult[]> {
    this.queries.push(config);
    if (config.text === "SELECT stall") {
      return new Promise((_, reject) => {
        this.pendingReject = reject;
      });
    }
    if (config.text === "SELECT slow" && this.currentTime !== undefined) {
      this.currentTime.value += CONTROL_PLANE_SLOW_STATEMENT_MS;
    }
    if (config.text === "SELECT fail") {
      const failure = Object.assign(new Error("not exposed"), {
        code: "23505",
        constraint: "communities_pkey",
      });
      return Promise.reject(failure);
    }
    if (config.text === "SELECT multi") {
      return Promise.resolve([
        { rows: [{ id: "first" }], rowCount: 1 },
        { rows: [{ id: "last" }], rowCount: null },
      ]);
    }
    const rows = config.text.startsWith("SELECT") ? [{ id: "community_9" }] : [];
    return Promise.resolve({ rows, rowCount: rows.length });
  }

  end(): Promise<void> {
    this.events.push("end");
    return Promise.resolve();
  }
}

const silentLogger: ControlPlaneLogger = {
  info: () => undefined,
  error: () => undefined,
};

function layerFor(
  client: FakePostgresClient,
  options: {
    readonly logger?: ControlPlaneLogger;
    readonly now?: () => number;
  } = {},
) {
  return makeDirectPostgresControlPlaneLayer("postgres://test.invalid/control", {
    clientFactory: () => client,
    logger: options.logger ?? silentLogger,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

describe("Postgres control-plane adapter", () => {
  test("request cancellation fences an in-flight query and retains only redacted correlated spans", async () => {
    const client = new FakePostgresClient();
    const queryStarted = Promise.withResolvers<void>();
    const originalQuery = client.query.bind(client);
    client.query = (config) => {
      const result = originalQuery(config);
      if (config.text === "SELECT stall") queryStarted.resolve();
      return result;
    };
    const records: WorkerDiagnosticFields[] = [];
    const controller = new AbortController();
    const program = withHnsAuthoritySpan(
      "authority",
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.execute({ ...statement, text: "SELECT stall" });
      }).pipe(Effect.provide(layerFor(client))),
    ).pipe(
      Effect.provideService(HnsAuthorityDiagnostic, {
        correlation_id: "12345678-1234-4234-8234-123456789abc",
        emit: (record) => {
          records.push(record);
        },
      }),
    );
    const result = Effect.runPromiseExit(program, { signal: controller.signal });
    await queryStarted.promise;
    controller.abort();
    expect((await result)._tag).toBe("Failure");
    expect(client.events).toContain("destroy");
    expect(client.events.indexOf("destroy")).toBeLessThan(client.events.indexOf("end"));
    expect(records.map(({ phase, outcome }) => [phase, outcome])).toEqual([
      ["authority", "started"],
      ["client_initialization", "started"],
      ["client_initialization", "success"],
      ["connection_acquisition", "started"],
      ["connection_acquisition", "success"],
      ["query", "started"],
      ["query", "canceled"],
      ["authority", "canceled"],
    ]);
    for (const record of records) {
      expect(record.correlation_id).toBe("12345678-1234-4234-8234-123456789abc");
      expect(
        Object.keys(record).every((key) =>
          ["phase", "outcome", "correlation_id", "elapsed_ms"].includes(key),
        ),
      ).toBe(true);
    }
    expect(JSON.stringify(records)).not.toContain("SELECT");
    expect(JSON.stringify(records)).not.toContain("community_9");
  });

  test("passes exact deadlines, preserves native SQL, and scopes a client", async () => {
    const client = new FakePostgresClient();
    let receivedConfig: ClientConfig | undefined;
    const layer = makeDirectPostgresControlPlaneLayer("postgres://test.invalid/control", {
      clientFactory: (_url, config) => {
        receivedConfig = config;
        return client;
      },
      logger: silentLogger,
    });

    const output = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const direct = yield* db.execute(statement);
          const transactional = yield* db.withTransaction((transaction) =>
            transaction.execute(statement),
          );
          return { direct, transactional };
        }).pipe(Effect.provide(layer)),
      ),
    );

    expect(receivedConfig).toMatchObject({
      connectionTimeoutMillis: CONTROL_PLANE_CONNECT_TIMEOUT_MS,
      statement_timeout: CONTROL_PLANE_STATEMENT_TIMEOUT_MS,
      idle_in_transaction_session_timeout: CONTROL_PLANE_IDLE_TRANSACTION_TIMEOUT_MS,
    });
    expect(output.direct).toEqual({ rows: [{ id: "community_9" }], rowCount: 1 });
    expect(output.transactional).toEqual({ rows: [{ id: "community_9" }], rowCount: 1 });
    expect(client.queries.map(({ text, values }) => ({ text, values }))).toEqual([
      { text: statement.text, values: statement.values },
      { text: "BEGIN", values: [] },
      {
        text: "SELECT set_config('statement_timeout', $1, true)",
        values: [`${CONTROL_PLANE_STATEMENT_TIMEOUT_MS}ms`],
      },
      {
        text: "SELECT set_config('idle_in_transaction_session_timeout', $1, true)",
        values: [`${CONTROL_PLANE_IDLE_TRANSACTION_TIMEOUT_MS}ms`],
      },
      { text: statement.text, values: statement.values },
      { text: "COMMIT", values: [] },
    ]);
    expect(client.events).toEqual(["connect", "end"]);
  });

  test("selects the clean-break schema transactionally only for Hyperdrive", async () => {
    const hyperdriveClient = new FakePostgresClient();
    const directClient = new FakePostgresClient();
    let hyperdriveConfig: ClientConfig | undefined;
    let directConfig: ClientConfig | undefined;
    const run = (layer: ReturnType<typeof makeDirectPostgresControlPlaneLayer>) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const db = yield* ControlPlaneDb;
            return yield* db.execute(statement);
          }).pipe(Effect.provide(layer)),
        ),
      );

    await run(
      makeHyperdriveControlPlaneLayer(
        { connectionString: "postgres://hyperdrive.invalid/control" },
        {
          clientFactory: (_url, config) => {
            hyperdriveConfig = config;
            return hyperdriveClient;
          },
          logger: silentLogger,
        },
      ),
    );
    await run(
      makeDirectPostgresControlPlaneLayer("postgres://direct.invalid/control", {
        clientFactory: (_url, config) => {
          directConfig = config;
          return directClient;
        },
        logger: silentLogger,
      }),
    );

    expect(hyperdriveConfig?.options).toBeUndefined();
    expect(directConfig?.options).toBeUndefined();
    expect(hyperdriveClient.queries.map(({ text, values }) => ({ text, values }))).toEqual([
      { text: "BEGIN", values: [] },
      {
        text: "SELECT set_config('statement_timeout', $1, true)",
        values: [`${CONTROL_PLANE_STATEMENT_TIMEOUT_MS}ms`],
      },
      {
        text: "SELECT set_config('idle_in_transaction_session_timeout', $1, true)",
        values: [`${CONTROL_PLANE_IDLE_TRANSACTION_TIMEOUT_MS}ms`],
      },
      {
        text: "SELECT set_config('search_path', $1, true)",
        values: [CONTROL_PLANE_HYPERDRIVE_SEARCH_PATH],
      },
      { text: statement.text, values: statement.values },
      { text: "COMMIT", values: [] },
    ]);
    expect(directClient.queries).toEqual([{ text: statement.text, values: [...statement.values] }]);
    expect(hyperdriveClient.events).toEqual(["connect", "end"]);
    expect(directClient.events).toEqual(["connect", "end"]);
  });

  test("sets the Hyperdrive schema once for an explicit transaction", async () => {
    const client = new FakePostgresClient();
    const layer = makeHyperdriveControlPlaneLayer(
      { connectionString: "postgres://hyperdrive.invalid/control" },
      { clientFactory: () => client, logger: silentLogger },
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              yield* transaction.execute(statement);
              yield* transaction.execute(statement);
            }),
          );
        }).pipe(Effect.provide(layer)),
      ),
    );

    expect(client.queries.filter(({ text }) => text.includes("set_config('search_path'"))).toEqual([
      {
        text: "SELECT set_config('search_path', $1, true)",
        values: [CONTROL_PLANE_HYPERDRIVE_SEARCH_PATH],
      },
    ]);
    expect(client.queries.at(-1)).toEqual({ text: "COMMIT", values: [] });
  });

  test("fences the gateway authority layer to read-only transactions", async () => {
    const client = new FakePostgresClient();
    let receivedConfig: ClientConfig | undefined;
    const layer = makeReadOnlyPostgresControlPlaneLayer(
      "postgresql://gateway.invalid/control?sslmode=verify-full",
      {
        clientFactory: (_url, config) => {
          receivedConfig = config;
          return client;
        },
        logger: silentLogger,
        connectTimeoutMs: 2_000,
        statementTimeoutMs: 2_000,
      },
    );

    const read = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.execute(statement);
        }).pipe(Effect.provide(layer)),
      ),
    );
    expect(read.rows).toEqual([{ id: "community_9" }]);
    expect(receivedConfig?.connectionTimeoutMillis).toBe(2_000);
    expect(receivedConfig?.statement_timeout).toBe(2_000);
    expect(client.queries).toContainEqual({
      text: "SELECT set_config('statement_timeout', $1, true)",
      values: ["2000ms"],
    });
    expect(receivedConfig?.options).toBe("-c default_transaction_read_only=on");
    expect(client.queries.at(-2)).toEqual({ text: statement.text, values: statement.values });

    await expect(
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const db = yield* ControlPlaneDb;
            return yield* db.execute({
              label: "gateway.forbidden-write",
              text: "DELETE FROM communities",
              values: [],
              readonly: false,
            });
          }).pipe(Effect.provide(layer)),
        ),
      ),
    ).rejects.toMatchObject({
      _tag: "ControlPlaneStatementFailed",
      label: "gateway.forbidden-write",
      outcomeCertainty: "not-started",
    });
    expect(client.queries.some(({ text }) => text.startsWith("DELETE"))).toBe(false);
  });

  test("rolls back a failing standalone Hyperdrive statement", async () => {
    const client = new FakePostgresClient();
    const layer = makeHyperdriveControlPlaneLayer(
      { connectionString: "postgres://hyperdrive.invalid/control" },
      { clientFactory: () => client, logger: silentLogger },
    );

    const error = await Effect.runPromise(
      Effect.flip(
        Effect.scoped(
          Effect.gen(function* () {
            const db = yield* ControlPlaneDb;
            yield* db.execute({ ...statement, text: "SELECT fail" });
          }).pipe(Effect.provide(layer)),
        ),
      ),
    );

    expect(error).toMatchObject({
      _tag: "ControlPlaneStatementFailed",
      label: statement.label,
      sqlState: "23505",
      outcomeCertainty: "completed",
    });
    expect(client.queries.at(-1)).toEqual({ text: "ROLLBACK", values: [] });
  });

  test("uses the single result or final result for multi-statement queries", async () => {
    const client = new FakePostgresClient();
    const output = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.execute({ ...statement, text: "SELECT multi" });
        }).pipe(Effect.provide(layerFor(client))),
      ),
    );

    expect(output).toEqual({ rows: [{ id: "last" }], rowCount: 1 });
  });

  test("exposes safe SQLSTATE classification and inclusive slow logging", async () => {
    const slowTime = { value: 0 };
    const logged: Array<{ event: string; fields: ControlPlaneLogFields }> = [];
    const logger: ControlPlaneLogger = {
      info: (event, fields) => logged.push({ event, fields }),
      error: () => undefined,
    };
    const slowClient = new FakePostgresClient(slowTime);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          yield* db.execute({ ...statement, label: "community.slow", text: "SELECT slow" });
        }).pipe(Effect.provide(layerFor(slowClient, { logger, now: () => slowTime.value }))),
      ),
    );
    expect(logged).toEqual([
      {
        event: "control-plane statement slow",
        fields: {
          label: "community.slow",
          elapsedMs: CONTROL_PLANE_SLOW_STATEMENT_MS,
          limitMs: CONTROL_PLANE_STATEMENT_TIMEOUT_MS,
        },
      },
    ]);

    const failureClient = new FakePostgresClient();
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.scoped(
          Effect.gen(function* () {
            const db = yield* ControlPlaneDb;
            yield* db.execute({ ...statement, text: "SELECT fail" });
          }).pipe(Effect.provide(layerFor(failureClient))),
        ),
      ),
    );
    expect(error).toMatchObject({
      _tag: "ControlPlaneStatementFailed",
      label: "community.lookup",
      sqlState: "23505",
      constraint: "communities_pkey",
      outcomeCertainty: "completed",
    });
    expect(Object.keys(error)).not.toContain("cause");
  });

  test("destroys the socket before lease-facing scope release after timeout", async () => {
    const client = new FakePostgresClient();
    const program = Effect.scoped(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const fiber = yield* Effect.flip(
          db.execute({ ...statement, label: "community.stall", text: "SELECT stall" }),
        ).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(CONTROL_PLANE_STATEMENT_TIMEOUT_MS + 1);
        const timeout = yield* Fiber.join(fiber);
        const fenced = yield* Effect.flip(db.execute(statement));
        return { timeout, fenced };
      }).pipe(Effect.provide(layerFor(client))),
    ).pipe(Effect.provide(TestClock.layer()));

    const output = await Effect.runPromise(program);
    // A bare autocommit statement can complete server-side after the socket
    // is destroyed, so its timeout must NOT claim a proven abort.
    expect(output.timeout).toMatchObject({
      _tag: "ControlPlaneOperationTimedOut",
      label: "community.stall",
      limitMs: CONTROL_PLANE_STATEMENT_TIMEOUT_MS,
      outcomeCertainty: "unknown",
    });
    expect(output.fenced).toMatchObject({
      _tag: "ControlPlaneOperationTimedOut",
      outcomeCertainty: "aborted",
    });
    expect(client.queries.filter(({ text }) => text === statement.text)).toHaveLength(0);
    expect(client.events.indexOf("destroy")).toBeGreaterThanOrEqual(0);
    expect(client.events.indexOf("destroy")).toBeLessThan(client.events.indexOf("end"));
  });

  test("reports a proven abort for a statement timed out inside a transaction", async () => {
    const client = new FakePostgresClient();
    const program = Effect.scoped(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const fiber = yield* Effect.flip(
          db.withTransaction((tx) =>
            tx.execute({ ...statement, label: "community.tx-stall", text: "SELECT stall" }),
          ),
        ).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(CONTROL_PLANE_STATEMENT_TIMEOUT_MS + 1);
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(layerFor(client))),
    ).pipe(Effect.provide(TestClock.layer()));

    // Inside an open transaction COMMIT was never sent, so socket destruction
    // proves the server rolls back: this timeout MAY claim a proven abort.
    const timeout = await Effect.runPromise(program);
    expect(timeout).toMatchObject({
      _tag: "ControlPlaneOperationTimedOut",
      label: "community.tx-stall",
      outcomeCertainty: "aborted",
    });
    expect(client.events.indexOf("destroy")).toBeGreaterThanOrEqual(0);
  });
});
