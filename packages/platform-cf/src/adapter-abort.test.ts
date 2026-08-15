import { describe, expect, test } from "bun:test";
import { ControlPlaneDb } from "@pirate/application";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import {
  type AdapterTraceEvent,
  assertLeaseReleaseSafety,
} from "../../../tests/scaffolds/adapter-abort-cases";
import {
  makeDirectPostgresControlPlaneLayer,
  type PostgresClientLike,
  type PostgresQueryConfig,
} from "./postgres";

type FencingToken = {
  readonly laneOwner: string;
  readonly jobAttemptId: string;
  readonly leaseGeneration: number;
};

class GuardedLease {
  private safetyAcknowledged = false;

  constructor(private readonly trace: AdapterTraceEvent[]) {}

  acknowledgeSafety(): void {
    this.safetyAcknowledged = true;
  }

  release(): void {
    if (!this.safetyAcknowledged) {
      throw new Error("lease release was attempted without adapter safety evidence");
    }
    this.trace.push("lease_released");
  }
}

class PostgresAbortClient implements PostgresClientLike {
  readonly connection = {
    stream: {
      destroy: (_reason?: Error) => {
        this.trace.push("connection_terminated");
      },
    },
  };
  private resolveLate: (() => void) | undefined;

  constructor(private readonly trace: AdapterTraceEvent[]) {}

  connect(): Promise<void> {
    return Promise.resolve();
  }

  query(_config: PostgresQueryConfig): Promise<{
    readonly rows: readonly Record<string, unknown>[];
    readonly rowCount: number;
  }> {
    this.trace.push("started");
    return new Promise((resolve) => {
      this.resolveLate = () => {
        this.trace.push("late_resolution");
        resolve({ rows: [{ late: true }], rowCount: 1 });
      };
    });
  }

  end(): Promise<void> {
    return Promise.resolve();
  }

  resolveUnderlyingPromise(): void {
    this.resolveLate?.();
  }
}

class FencedWriteStore {
  private activeToken: FencingToken | null;
  private writes = 0;

  constructor(
    private readonly trace: AdapterTraceEvent[],
    token: FencingToken,
  ) {
    this.activeToken = token;
  }

  revoke(token: FencingToken): void {
    if (this.activeToken === token) {
      this.activeToken = null;
      this.trace.push("fence_committed");
    }
  }

  writeAtFinalBoundary(token: FencingToken): boolean {
    if (this.activeToken !== token) return false;
    this.writes += 1;
    return true;
  }

  writeCount(): number {
    return this.writes;
  }
}

function stalledFencedCall(
  store: FencedWriteStore,
  token: FencingToken,
  trace: AdapterTraceEvent[],
  lateResolution: (write: () => boolean) => void,
): Effect.Effect<never, unknown> {
  return Effect.onInterrupt(
    Effect.tryPromise(
      () =>
        new Promise<never>((resolve) => {
          trace.push("started");
          lateResolution(() => {
            trace.push("late_resolution");
            const published = store.writeAtFinalBoundary(token);
            if (published) trace.push("late_publish");
            return published;
          });
          void resolve;
        }),
    ),
    () => Effect.sync(() => store.revoke(token)),
  );
}

function expectStartedBeforeTimeout(trace: readonly AdapterTraceEvent[]): void {
  expect(trace.indexOf("started")).toBeGreaterThanOrEqual(0);
  expect(trace.indexOf("started")).toBeLessThan(trace.indexOf("timeout"));
}

describe("adapter abort and fencing contract", () => {
  test("Postgres terminates the session before a lease is released", async () => {
    const trace: AdapterTraceEvent[] = [];
    const lease = new GuardedLease(trace);
    const client = new PostgresAbortClient(trace);
    const program = Effect.scoped(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const fiber = yield* Effect.flip(
          db.execute({
            label: "abort.postgres",
            text: "SELECT pg_sleep(10)",
            values: [],
            readonly: true,
          }),
        ).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        trace.push("timeout");
        yield* TestClock.adjust(15_001);
        return yield* Fiber.join(fiber);
      }).pipe(
        Effect.provide(
          makeDirectPostgresControlPlaneLayer("postgres://test.invalid/control", {
            clientFactory: () => client,
            logger: { info: () => undefined, error: () => undefined },
          }),
        ),
      ),
    ).pipe(Effect.provide(TestClock.layer()));

    // This test is intentionally kept in the same source package as the
    // adapter, but the Effect service is loaded explicitly to avoid a root
    // package import in the Workerd bundle.
    await Effect.runPromise(program);
    lease.acknowledgeSafety();
    lease.release();
    client.resolveUnderlyingPromise();

    expectStartedBeforeTimeout(trace);
    assertLeaseReleaseSafety(trace, "aborted");
    expect(trace).toContain("late_resolution");
    expect(trace).not.toContain("late_publish");
  });

  test("D1 shard RPC fences the token at the final write boundary", async () => {
    const trace: AdapterTraceEvent[] = [];
    const lease = new GuardedLease(trace);
    const token: FencingToken = {
      laneOwner: "lane-c",
      jobAttemptId: "attempt-1",
      leaseGeneration: 7,
    };
    const store = new FencedWriteStore(trace, token);
    let resolveLate: (() => void) | undefined;
    const program = Effect.gen(function* () {
      const fiber = yield* Effect.flip(
        Effect.timeout(
          stalledFencedCall(store, token, trace, (write) => {
            resolveLate = () => {
              write();
            };
          }),
          100,
        ),
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      trace.push("timeout");
      return yield* Fiber.join(fiber);
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(program);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(101);
        yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    lease.acknowledgeSafety();
    lease.release();
    resolveLate?.();

    expectStartedBeforeTimeout(trace);
    assertLeaseReleaseSafety(trace, "fenced");
    expect(store.writeCount()).toBe(0);
    expect(trace).not.toContain("late_publish");
  });

  test("queue send fences an accepted-or-ambiguous message before release", async () => {
    const trace: AdapterTraceEvent[] = [];
    const lease = new GuardedLease(trace);
    const token: FencingToken = {
      laneOwner: "lane-c",
      jobAttemptId: "attempt-queue-1",
      leaseGeneration: 8,
    };
    const store = new FencedWriteStore(trace, token);
    let providerAccepted = false;
    let resolveLate: (() => void) | undefined;
    const send = Effect.onInterrupt(
      Effect.tryPromise(
        () =>
          new Promise<never>((resolve) => {
            resolveLate = () => {
              providerAccepted = true;
              trace.push("late_resolution");
              if (store.writeAtFinalBoundary(token)) trace.push("late_publish");
            };
            void resolve;
          }),
      ),
      () => Effect.sync(() => store.revoke(token)),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.flip(Effect.timeout(send, 100)).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        trace.push("started");
        trace.push("timeout");
        yield* TestClock.adjust(101);
        yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    lease.acknowledgeSafety();
    lease.release();
    resolveLate?.();

    expectStartedBeforeTimeout(trace);
    assertLeaseReleaseSafety(trace, "fenced");
    expect(providerAccepted).toBe(true);
    expect(store.writeCount()).toBe(0);
    expect(trace).not.toContain("late_publish");
  });
});
