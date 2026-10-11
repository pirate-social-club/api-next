import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  type GatewayPostgresPool,
  makeGatewayPooledPostgresClientFactory,
} from "./hns-gateway-postgres-pool.ts";

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe("gateway read-only PostgreSQL pool scopes", () => {
  test("reuses a backend connection while executing every query", async () => {
    let acquisitions = 0;
    let queries = 0;
    const releases: boolean[] = [];
    const backend = Object.assign(new EventEmitter(), {
      connection: { stream: { destroyed: false, destroy: () => undefined } },
      query: async () => {
        queries += 1;
        return { rows: [], rowCount: 0 };
      },
      release: (destroy = false) => releases.push(destroy),
    });
    const pool: GatewayPostgresPool = {
      connect: async () => {
        acquisitions += 1;
        return backend;
      },
    };
    const factory = makeGatewayPooledPostgresClientFactory(pool);
    for (let index = 0; index < 2; index += 1) {
      const scope = await factory("postgresql://unused", {});
      await scope.connect();
      await scope.query({ text: "SELECT 1" });
      await scope.end();
    }
    expect({ acquisitions, queries, releases }).toEqual({
      acquisitions: 2,
      queries: 2,
      releases: [false, false],
    });
    expect(backend.listenerCount("error")).toBe(0);
  });

  test("discards a connection acquired after its scope is canceled", async () => {
    const pending = deferred<Awaited<ReturnType<GatewayPostgresPool["connect"]>>>();
    const releases: boolean[] = [];
    const pool: GatewayPostgresPool = { connect: () => pending.promise };
    const scope = await makeGatewayPooledPostgresClientFactory(pool)("postgresql://unused", {});
    const connecting = scope.connect();
    await scope.end();
    pending.resolve(
      Object.assign(new EventEmitter(), {
        query: async () => ({ rows: [], rowCount: 0 }),
        release: (destroy = false) => releases.push(destroy),
      }),
    );
    await expect(connecting).rejects.toThrow("closed during acquisition");
    expect(releases).toEqual([true]);
  });

  test("discards a scope whose socket was destroyed on timeout", async () => {
    const releases: boolean[] = [];
    const stream = {
      destroyed: false,
      destroy: () => {
        stream.destroyed = true;
      },
    };
    const pool: GatewayPostgresPool = {
      connect: async () =>
        Object.assign(new EventEmitter(), {
          connection: { stream },
          query: async () => ({ rows: [], rowCount: 0 }),
          release: (destroy = false) => releases.push(destroy),
        }),
    };
    const scope = await makeGatewayPooledPostgresClientFactory(pool)("postgresql://unused", {});
    await scope.connect();
    scope.connection?.stream?.destroy();
    await scope.end();
    expect(releases).toEqual([true]);
  });

  test("contains a borrowed-client disconnect and discards that client", async () => {
    const releases: boolean[] = [];
    const client = Object.assign(new EventEmitter(), {
      connection: { stream: { destroyed: false, destroy: () => undefined } },
      query: async () => ({ rows: [], rowCount: 0 }),
      release: (destroy = false) => releases.push(destroy),
    });
    const pool: GatewayPostgresPool = { connect: async () => client };
    const scope = await makeGatewayPooledPostgresClientFactory(pool)("postgresql://unused", {});
    await scope.connect();
    expect(client.listenerCount("error")).toBe(1);
    expect(() =>
      client.emit("error", new Error("connection terminated unexpectedly")),
    ).not.toThrow();
    await scope.end();
    expect(releases).toEqual([true]);
    expect(client.listenerCount("error")).toBe(0);
  });
});
