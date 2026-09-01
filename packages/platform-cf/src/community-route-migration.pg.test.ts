import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "pg";
import {
  loadPostgresMigrations,
  runPostgresMigrations,
} from "../../../scripts/postgres-migrations.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_CANONICAL_ROUTE_MIGRATION_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-canonical-route-migration-suite-complete";
const sentinelContents =
  "api-next-control-plane-postgres-canonical-route-migration-suite-complete\n";
let completedTestCount = 0;

function schemaIdentifier(): string {
  return `api_next_canonical_route_migration_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function connectionForSchema(raw: string, schema: string): string {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

async function withSchema<A>(use: (connection: string, admin: Client) => Promise<A>): Promise<A> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  const schema = schemaIdentifier();
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
  try {
    return await use(connectionForSchema(connectionString, schema), admin);
  } finally {
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

suite("canonical community route PostgreSQL migrations", () => {
  test("refuses the route-v2 migration when retained history contains the platform root", async () => {
    await withSchema(async (connection, admin) => {
      const migrations = await loadPostgresMigrations();
      const routeV2Index = migrations.findIndex(
        (migration) => migration.version === "0049_bare_hns_community_route_v2.sql",
      );
      expect(routeV2Index).toBeGreaterThan(0);
      await runPostgresMigrations({
        connectionString: connection,
        migrations: migrations.slice(0, routeV2Index),
      });
      await admin.query("INSERT INTO users (user_id) VALUES ('reserved-route-owner')");
      await admin.query(
        `INSERT INTO communities (
           community_id, display_name, status, created_by_user_id,
           created_at, updated_at, route_slug, route_authority_version
         ) VALUES ('community_123e4567-e89b-42d3-a456-426614174049',
           'Reserved platform route', 'active',
           'reserved-route-owner', clock_timestamp(), clock_timestamp(), NULL,
           'optional_route_v2')`,
      );
      await admin.query("BEGIN");
      await admin.query(
        `INSERT INTO community_canonical_route_bindings (
           route_binding_id, community_id, family, root_label, root_label_display,
           ownership_status, route_lifecycle_status, binding_generation,
           verified_evidence_ref
         ) VALUES ('reserved-platform-binding',
           'community_123e4567-e89b-42d3-a456-426614174049', 'hns',
           'pirate', 'pirate', 'pending', 'suspended', 1, NULL)`,
      );
      await admin.query(
        `UPDATE communities
            SET canonical_route_binding_id = 'reserved-platform-binding'
          WHERE community_id = 'community_123e4567-e89b-42d3-a456-426614174049'`,
      );
      await admin.query("COMMIT");

      await expect(
        runPostgresMigrations({ connectionString: connection, migrations }),
      ).rejects.toBeDefined();
      await expect(
        admin.query(
          "SELECT count(*)::integer AS count FROM schema_migrations WHERE version = '0049_bare_hns_community_route_v2.sql'",
        ),
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
      await expect(
        admin.query(
          "SELECT root_label FROM community_canonical_route_bindings WHERE route_binding_id = 'reserved-platform-binding'",
        ),
      ).resolves.toMatchObject({ rows: [{ root_label: "pirate" }] });
      completedTestCount += 1;
    });
  }, 30_000);
});

afterAll(async () => {
  if (connectionString === undefined || completedTestCount !== 1) return;
  await Bun.write(sentinelPath, sentinelContents);
});
