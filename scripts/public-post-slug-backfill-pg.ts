import { Effect } from "effect";
import {
  ControlPlaneStatementFailed,
  type ControlPlaneTransaction,
} from "../packages/application/src/ports.ts";
import {
  ensurePostSlugAliasInTransaction,
  PublicPostSlugRepositoryError,
} from "../packages/platform-cf/src/public-post-slug-repository.ts";
import type {
  PostSlugBackfillAllocator,
  PostSlugBackfillDatabase,
  PostSlugBackfillTransaction,
} from "./public-post-slug-backfill-transaction.ts";

export type PostSlugBackfillPgClient = Readonly<{
  readonly query: <Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ readonly rows: readonly Row[] }>;
  readonly connect: () => Promise<void>;
  readonly end: () => Promise<void>;
}>;

type PgModule = Readonly<{
  readonly Client: new (input: { readonly connectionString: string }) => PostSlugBackfillPgClient;
}>;

export type PostSlugBackfillPgAdapter = Readonly<{
  readonly client: PostSlugBackfillPgClient;
  readonly database: PostSlugBackfillDatabase;
  readonly allocator: PostSlugBackfillAllocator;
}>;

export async function loadPostSlugBackfillPgDriver(): Promise<PgModule> {
  return (await import("../packages/platform-cf/node_modules/pg")) as unknown as PgModule;
}

const safeSqlState = (error: unknown): string | null => {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" && code.length <= 16 ? code : null;
};

const safeConstraint = (error: unknown): string | null => {
  if (typeof error !== "object" || error === null) return null;
  const constraint = (error as Record<string, unknown>).constraint;
  return typeof constraint === "string" && constraint.length <= 256 ? constraint : null;
};

const allocatorTransaction = (
  transaction: PostSlugBackfillTransaction,
): ControlPlaneTransaction => ({
  execute: <Row = unknown>(statement: Parameters<ControlPlaneTransaction["execute"]>[0]) =>
    Effect.tryPromise({
      try: async () => {
        const result = await transaction.query<Record<string, unknown>>(
          statement.text,
          statement.values,
        );
        return {
          rows: result.rows as readonly Row[],
          rowCount: result.rows.length,
        };
      },
      catch: (error) =>
        new ControlPlaneStatementFailed({
          label: statement.label,
          sqlState: safeSqlState(error),
          constraint: safeConstraint(error),
          outcomeCertainty: "aborted",
        }),
    }),
});

export async function createPostSlugBackfillPgAdapter(
  connectionString: string,
  databaseEnvironment: string,
): Promise<PostSlugBackfillPgAdapter> {
  const { Client } = await loadPostSlugBackfillPgDriver();
  const client = new Client({ connectionString });
  const database: PostSlugBackfillDatabase = {
    databaseEnvironment,
    withTransaction: async <A>(
      run: (transaction: PostSlugBackfillTransaction) => Promise<A>,
    ): Promise<A> => {
      await client.query("BEGIN");
      try {
        const result = await run({
          query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
            text: string,
            values?: readonly unknown[],
          ) => {
            const response = await client.query<Record<string, unknown>>(text, values);
            return { rows: response.rows as readonly Row[] };
          },
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    },
  };
  const allocator: PostSlugBackfillAllocator = async (transaction, input) => {
    try {
      return await Effect.runPromise(
        ensurePostSlugAliasInTransaction(allocatorTransaction(transaction), input),
      );
    } catch (error) {
      if (error instanceof PublicPostSlugRepositoryError) {
        throw new Error(`public-post-slug-backfill-allocation-${error.reason}`);
      }
      throw error;
    }
  };
  return { client, database, allocator };
}
