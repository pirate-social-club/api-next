import type { Pool } from "pg";
import type {
  PostgresClientFactory,
  PostgresClientLike,
  PostgresQueryConfig,
  PostgresQueryResponse,
} from "./postgres.ts";

type BorrowedClient = Readonly<{
  connection?: { readonly stream?: { readonly destroyed?: boolean; destroy: () => unknown } };
  query: (config: { text: string; values: unknown[] }) => Promise<PostgresQueryResponse>;
  release: (destroy?: boolean) => void;
}>;

export type GatewayPostgresPool = Readonly<{
  connect: () => Promise<BorrowedClient>;
}>;

/**
 * A gateway request still owns a short read-only database scope. Returning
 * its client to this pool preserves the scope and query boundaries while
 * avoiding TCP/TLS/authentication on every host lookup.
 */
export function makeGatewayPooledPostgresClientFactory(
  pool: GatewayPostgresPool,
): PostgresClientFactory {
  return () => {
    let borrowed: BorrowedClient | null = null;
    let closed = false;
    return {
      get connection() {
        return borrowed?.connection ?? {};
      },
      connect: async () => {
        if (closed || borrowed !== null) throw new Error("gateway pool scope is closed");
        const client = await pool.connect();
        if (closed) {
          client.release(true);
          throw new Error("gateway pool scope closed during acquisition");
        }
        borrowed = client;
      },
      query: (config: PostgresQueryConfig) => {
        if (closed || borrowed === null) throw new Error("gateway pool scope is closed");
        return borrowed.query({
          text: config.text,
          values: config.values === undefined ? [] : [...config.values],
        });
      },
      end: async () => {
        if (closed) return;
        closed = true;
        const client = borrowed;
        borrowed = null;
        if (client !== null) {
          client.release(client.connection?.stream?.destroyed === true);
        }
      },
    } satisfies PostgresClientLike;
  };
}

/** One process-local pool per gateway authority. Idle sockets retire after 30s. */
export function makeGatewayPostgresPoolClientFactory(): PostgresClientFactory {
  let poolPromise: Promise<GatewayPostgresPool> | undefined;
  return async (_connectionString, config) => {
    poolPromise ??= import("pg").then(({ Pool: PostgresPool }) => {
      const pool = new PostgresPool({
        ...config,
        max: 2,
        idleTimeoutMillis: 30_000,
      });
      pool.on("error", () => {
        console.error("hns gateway authority idle connection failed");
      });
      return pool as unknown as Pool & GatewayPostgresPool;
    });
    return makeGatewayPooledPostgresClientFactory(await poolPromise)(_connectionString, config);
  };
}
