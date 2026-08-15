import { describe, expect, test } from "bun:test";
import { ControlPlaneDb } from "@pirate/application";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import type { ClientConfig } from "pg";

import {
  CONTROL_PLANE_CONNECT_TIMEOUT_MS,
  CONTROL_PLANE_IDLE_TRANSACTION_TIMEOUT_MS,
  CONTROL_PLANE_SLOW_STATEMENT_MS,
  CONTROL_PLANE_STATEMENT_TIMEOUT_MS,
  type ControlPlaneLogFields,
  type ControlPlaneLogger,
  makeDirectPostgresControlPlaneLayer,
  type PostgresClientLike,
  type PostgresQueryConfig,
} from "./postgres";

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

  query(config: PostgresQueryConfig): Promise<{
    readonly rows: readonly Record<string, unknown>[];
    readonly rowCount: number;
  }> {
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
      { text: "SET LOCAL statement_timeout = $1", values: [CONTROL_PLANE_STATEMENT_TIMEOUT_MS] },
      {
        text: "SET LOCAL idle_in_transaction_session_timeout = $1",
        values: [CONTROL_PLANE_IDLE_TRANSACTION_TIMEOUT_MS],
      },
      { text: statement.text, values: statement.values },
      { text: "COMMIT", values: [] },
    ]);
    expect(client.events).toEqual(["connect", "end"]);
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
    expect(output.timeout).toMatchObject({
      _tag: "ControlPlaneOperationTimedOut",
      label: "community.stall",
      limitMs: CONTROL_PLANE_STATEMENT_TIMEOUT_MS,
      outcomeCertainty: "aborted",
    });
    expect(output.fenced).toMatchObject({
      _tag: "ControlPlaneOperationTimedOut",
      outcomeCertainty: "aborted",
    });
    expect(client.queries.filter(({ text }) => text === statement.text)).toHaveLength(0);
    expect(client.events.indexOf("destroy")).toBeGreaterThanOrEqual(0);
    expect(client.events.indexOf("destroy")).toBeLessThan(client.events.indexOf("end"));
  });
});
