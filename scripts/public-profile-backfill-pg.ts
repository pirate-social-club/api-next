import type {
  PublicProfileBackfillDatabase,
  PublicProfileBackfillTransaction,
} from "./public-profile-backfill-types";

export type PublicProfileBackfillPgClient = Readonly<{
  readonly query: <Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ readonly rows: readonly Row[] }>;
  readonly connect: () => Promise<void>;
  readonly end: () => Promise<void>;
}>;

export type PublicProfileBackfillPgAdapter = Readonly<{
  readonly client: PublicProfileBackfillPgClient;
  readonly database: PublicProfileBackfillDatabase;
}>;

type PgModule = Readonly<{
  readonly Client: new (input: {
    readonly connectionString: string;
  }) => PublicProfileBackfillPgClient;
}>;

/** Resolve the driver from the package that owns the Postgres dependency. */
export async function loadPublicProfileBackfillPgDriver(): Promise<PgModule> {
  return (await import("../packages/platform-cf/node_modules/pg")) as unknown as PgModule;
}

export async function createPublicProfileBackfillPgAdapter(
  connectionString: string,
): Promise<PublicProfileBackfillPgAdapter> {
  const { Client } = await loadPublicProfileBackfillPgDriver();
  const client = new Client({ connectionString });
  const database: PublicProfileBackfillDatabase = {
    withTransaction: async <A>(
      run: (transaction: PublicProfileBackfillTransaction) => Promise<A>,
    ): Promise<A> => {
      await client.query("BEGIN");
      try {
        const result = await run({
          query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
            text: string,
            values: readonly unknown[] | undefined,
          ): Promise<{ readonly rows: readonly Row[] }> => {
            const response = await client.query<Record<string, unknown>>(
              text,
              values === undefined ? undefined : [...values],
            );
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
  return { client, database };
}
