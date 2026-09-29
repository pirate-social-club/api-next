import { describe, expect, test } from "bun:test";
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
    const backend = {
      connection: { stream: { destroyed: false, destroy: () => undefined } },
      query: async () => {
        queries += 1;
        return { rows: [], rowCount: 0 };
      },
      release: (destroy = false) => releases.push(destroy),
    };
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
  });

  test("discards a connection acquired after its scope is canceled", async () => {
    const pending = deferred<Awaited<ReturnType<GatewayPostgresPool["connect"]>>>();
    const releases: boolean[] = [];
    const pool: GatewayPostgresPool = { connect: () => pending.promise };
    const scope = await makeGatewayPooledPostgresClientFactory(pool)("postgresql://unused", {});
    const connecting = scope.connect();
    await scope.end();
    pending.resolve({
      query: async () => ({ rows: [], rowCount: 0 }),
      release: (destroy = false) => releases.push(destroy),
    });
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
      connect: async () => ({
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
});
