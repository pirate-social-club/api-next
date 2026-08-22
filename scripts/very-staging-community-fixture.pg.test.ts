import { describe, expect, test } from "bun:test";

import { runPostgresMigrations } from "./postgres-migrations.ts";
import {
  loadPublicProfileBackfillPgDriver,
  type PublicProfileBackfillPgClient,
} from "./public-profile-backfill-pg.ts";
import { runVeryStagingCommunityFixture } from "./very-staging-community-fixture.ts";
import type { VeryStagingFixtureOptions } from "./very-staging-community-fixture-options.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const pgModule =
  connectionString === undefined
    ? undefined
    : await loadPublicProfileBackfillPgDriver().catch((error: unknown) => {
        if (required) throw error;
        return undefined;
      });
const PgClientConstructor = pgModule?.Client;
const suite =
  connectionString === undefined || PgClientConstructor === undefined ? describe.skip : describe;

const COMMUNITY_ID = "community-very-staging-fixture-lifecycle-test";
const OPERATOR_USER_ID = "operator-very-staging-fixture";

function schemaIdentifier(): string {
  return `api_next_very_staging_fixture_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function connectionForSchema(raw: string, schema: string): string {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

async function withSchema<A>(
  use: (
    input: Readonly<{ readonly admin: PublicProfileBackfillPgClient; readonly scopedUrl: string }>,
  ) => Promise<A>,
): Promise<A> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  if (PgClientConstructor === undefined) throw new Error("package-local pg driver unavailable");
  const schema = schemaIdentifier();
  const scopedUrl = connectionForSchema(connectionString, schema);
  const admin = new PgClientConstructor({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  try {
    await runPostgresMigrations({ connectionString: scopedUrl });
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    await admin.query("INSERT INTO users (user_id, status) VALUES ($1, 'active')", [
      OPERATOR_USER_ID,
    ]);
    return await use({ admin, scopedUrl });
  } finally {
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

function options(
  connection: string,
  action: VeryStagingFixtureOptions["action"],
  mode: VeryStagingFixtureOptions["mode"],
): VeryStagingFixtureOptions {
  return {
    action,
    mode,
    communityId: COMMUNITY_ID,
    operatorUserId: OPERATOR_USER_ID,
    connectionString: connection,
  };
}

async function rowCounts(
  admin: PublicProfileBackfillPgClient,
): Promise<Readonly<Record<string, number>>> {
  const result = await admin.query<{ readonly relation: string; readonly rows: string }>(
    `SELECT 'communities' AS relation, count(*)::text AS rows
       FROM communities WHERE community_id = $1
     UNION ALL
     SELECT 'policy_versions', count(*)::text
       FROM policy_versions WHERE community_id = $1
     UNION ALL
     SELECT 'community_policy_provider_bindings', count(*)::text
       FROM community_policy_provider_bindings WHERE community_id = $1
     UNION ALL
     SELECT 'community_policy_current', count(*)::text
       FROM community_policy_current WHERE community_id = $1`,
    [COMMUNITY_ID],
  );
  return Object.fromEntries(result.rows.map((row) => [row.relation, Number(row.rows)]));
}

suite("Very staging community fixture against Postgres 17", () => {
  test("seeds four exact records and deactivates without deleting append-only history", async () => {
    await withSchema(async ({ admin, scopedUrl }) => {
      expect(
        await runVeryStagingCommunityFixture(options(scopedUrl, "seed", "dry-run")),
      ).toMatchObject({ status: "would_seed" });
      expect(
        await runVeryStagingCommunityFixture(options(scopedUrl, "seed", "apply")),
      ).toMatchObject({ status: "seeded" });
      expect(await rowCounts(admin)).toEqual({
        communities: 1,
        policy_versions: 1,
        community_policy_provider_bindings: 1,
        community_policy_current: 1,
      });
      expect(
        await runVeryStagingCommunityFixture(options(scopedUrl, "seed", "apply")),
      ).toMatchObject({ status: "already_seeded" });

      expect(
        await runVeryStagingCommunityFixture(options(scopedUrl, "deactivate", "dry-run")),
      ).toMatchObject({ status: "would_deactivate" });
      expect(
        await runVeryStagingCommunityFixture(options(scopedUrl, "deactivate", "apply")),
      ).toMatchObject({
        status: "deactivated",
        append_only_policy_rows_retained: true,
      });
      expect(
        (
          await admin.query<{ readonly status: string }>(
            "SELECT status FROM communities WHERE community_id = $1",
            [COMMUNITY_ID],
          )
        ).rows,
      ).toEqual([{ status: "hidden" }]);
      expect(await rowCounts(admin)).toEqual({
        communities: 1,
        policy_versions: 1,
        community_policy_provider_bindings: 1,
        community_policy_current: 1,
      });
      expect(
        await runVeryStagingCommunityFixture(options(scopedUrl, "deactivate", "apply")),
      ).toMatchObject({ status: "already_deactivated" });
    });
  });
});
