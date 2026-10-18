/** Test instrumentation only. No SQL/server work at import. */
import { Client } from "pg";
import { makeDirectPostgresControlPlaneLayer, type PostgresQueryConfig } from "./postgres.ts";
import { READ_VIDEO_DETAIL_SNAPSHOT_V1 } from "./video-detail-repository.ts";

export const MATRIX_RESOLVER_SQL = "SELECT resolve_comment_navigation_v1($1,$2) AS result";

/** Outer statement creates its MVCC snapshot BEFORE waiting on this advisory
 * lock. Original SQL/parameters stay in that SAME statement, never a preceding
 * authorizer or separate repeatable-read wrapper hiding multiple statements. */
export function matrixSnapshotQuery(query: PostgresQueryConfig, key: string): PostgresQueryConfig {
  if (query.text !== READ_VIDEO_DETAIL_SNAPSHOT_V1 && query.text !== MATRIX_RESOLVER_SQL)
    throw new Error("Only the actual owned detail/resolver read may be snapshot-gated");
  const values = [...(query.values ?? []), key];
  return {
    text: `WITH matrix_snapshot_barrier AS MATERIALIZED (
    SELECT pg_advisory_xact_lock_shared($${values.length}::bigint) AS held,1 AS token
  ) SELECT matrix_read.* FROM matrix_snapshot_barrier
  CROSS JOIN LATERAL (${query.text} OFFSET (matrix_snapshot_barrier.token-1)) AS matrix_read`,
    values,
  };
}

export function matrixSnapshotRuntime(url: string, key: string) {
  const backend = Promise.withResolvers<number>();
  let statements = 0;
  const runtime = makeDirectPostgresControlPlaneLayer(url, {
    clientFactory: (connection, config) => {
      const client = new Client({ ...config, connectionString: connection });
      return {
        connect: async () => {
          try {
            await client.connect();
            backend.resolve((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
          } catch (error) {
            backend.reject(error);
            throw error;
          }
        },
        end: () => client.end(),
        query: async (query) => {
          const owned =
            query.text === READ_VIDEO_DETAIL_SNAPSHOT_V1 || query.text === MATRIX_RESOLVER_SQL;
          if (owned) statements++;
          const actual = owned ? matrixSnapshotQuery(query, key) : query;
          return client.query({ ...actual, values: [...(actual.values ?? [])] });
        },
      };
    },
  });
  return { runtime, backend: backend.promise, statements: () => statements };
}

/** Bounded server-observed wait: callers must not commit the competing change
 * just because a JS promise was started. Verify each statement is actually
 * waiting INSIDE PostgreSQL after its statement snapshot exists. */
export async function waitForMatrixSnapshots(observer: Client, pids: readonly number[]) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const result = await observer.query<{ n: number }>(
      "SELECT count(DISTINCT pid)::int AS n FROM pg_locks WHERE pid=ANY($1::int[]) AND locktype='advisory' AND NOT granted",
      [pids],
    );
    if (result.rows[0]?.n === pids.length) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Readers never reached their real statement-snapshot barriers");
}

/** Dispatch barrier runs BEFORE sending selected commands, with native
 * transactions already open. It never returns fake SQL results. */
export function matrixDispatchBarrier(count: number) {
  if (!Number.isInteger(count) || count < 1) throw new Error("Positive participant count required");
  const ready = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const participants = new Set<number>();
  return {
    ready: ready.promise,
    pids: () => [...participants],
    arrive: async (pid: number) => {
      if (participants.has(pid) || participants.size >= count)
        throw new Error("Unexpected duplicate barrier participant");
      participants.add(pid);
      if (participants.size === count) ready.resolve();
      await released.promise;
    },
    release: () => released.resolve(),
  };
}

export function matrixCommitLoss(needle: string) {
  let touched = false;
  let lost = false;
  let mutations = 0;
  return {
    after: async (query: PostgresQueryConfig) => {
      if (query.text.includes(needle)) {
        touched = true;
        mutations++;
      }
      if (touched && query.text === "COMMIT" && !lost) {
        lost = true;
        throw new Error("Fixture lost acknowledgement AFTER actual native COMMIT");
      }
    },
    lost: () => lost,
    mutations: () => mutations,
  };
}

export async function matrixDeadline<A>(promise: Promise<A>): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Matrix coordination did not reach the native boundary")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
