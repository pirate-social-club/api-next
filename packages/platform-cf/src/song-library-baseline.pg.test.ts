import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import {
  makeControlPlaneSongLibraryStore,
  songLibraryStatements,
} from "./song-library-repository.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const connectionForSchema = (raw: string, schema: string): string => {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
};

// The query fixture in song-library-repository.pg.test.ts builds simplified
// tables, so it cannot notice a renamed session column on main. This suite
// prepares the exact statements against the migrated baseline instead.
suite("persona song library statements against the migrated schema", () => {
  test("every statement prepares and trending runs on an empty baseline", async () => {
    if (connectionString === undefined) throw new Error("test URL was not configured");
    const schema = `api_next_song_library_${crypto.randomUUID().replaceAll("-", "")}`;
    const admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    try {
      const connection = connectionForSchema(connectionString, schema);
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      const client = new Client({ connectionString: connection });
      await client.connect();
      try {
        for (const [name, text] of Object.entries(songLibraryStatements)) {
          await client.query(`PREPARE song_library_${name} AS ${text}`);
        }
        const plan = await client.query(
          `EXPLAIN EXECUTE song_library_list('account', 'persona', NULL, NULL, NULL, 26)`,
        );
        expect(plan.rows.length).toBeGreaterThan(0);
      } finally {
        await client.end();
      }
      const store = makeControlPlaneSongLibraryStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      expect(await Effect.runPromise(store.trending())).toEqual([]);
    } finally {
      await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
      await admin.end();
    }
  });
});
