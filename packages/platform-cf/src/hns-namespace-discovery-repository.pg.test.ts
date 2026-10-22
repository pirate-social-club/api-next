import { afterAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { listHnsNamespaces } from "@pirate/application/use-cases/hns-namespace-discovery";
import { HnsNamespaceDiscoveryV1, InternalError } from "@pirate/contracts";
import { Effect, Schema } from "effect";
import type { Client } from "pg";
import {
  applyPostgresTestBaselineConnection,
  createReusablePostgresTestSchemaOwner,
} from "../../../scripts/postgres-test-baseline.ts";
import {
  type HnsDiscoveryZoneFixture,
  insertHnsDiscoveryZone,
  seedHnsDiscoveryZones,
} from "./hns-namespace-discovery.pg-fixture.ts";
import {
  HNS_SERVED_ROOTS_SQL,
  makeControlPlaneHnsNamespaceDiscoveryStore,
} from "./hns-namespace-discovery-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

const reusableSchema = createReusablePostgresTestSchemaOwner();

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LDH = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function scopedConnection(raw: string, schema: string): string {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

const iso = (milliseconds: number) => new Date(milliseconds).toISOString();
const otherDigest = (label: string) => createHash("sha256").update(`other:${label}`).digest("hex");

type SchemaContext = Readonly<{ admin: Client; connection: string; schema: string; now: number }>;

async function withSchema<A>(use: (context: SchemaContext) => Promise<A>): Promise<A> {
  if (connectionString === undefined) throw new Error("Postgres test configuration is unavailable");
  return reusableSchema.run({
    baseConnectionString: connectionString,
    schemaName: "packages_platform_cf_src_hns_namespace_discovery_repository_pg_test_ts",
    use: async ({ admin, schema }) => {
      const connection = scopedConnection(connectionString, schema);
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      const clock = await admin.query<{ now: Date }>("SELECT clock_timestamp() AS now");
      const now = clock.rows[0]?.now.getTime();
      if (now === undefined) throw new Error("database clock was not read");
      return await use({ admin, connection, schema, now });
    },
  });
}

const storeFor = (connection: string) =>
  makeControlPlaneHnsNamespaceDiscoveryStore(makeDirectPostgresControlPlaneLayer(connection));
const servedRoots = (connection: string) => Effect.runPromise(storeFor(connection).servedRoots());
const discover = (connection: string) => Effect.runPromise(listHnsNamespaces(storeFor(connection)));
const rootsOf = (list: { readonly roots: readonly { readonly root: string }[] }) =>
  list.roots.map((entry) => entry.root);

/** Far from every boundary: published a day ago, five days of health, six of inventory. */
function served(
  root: string,
  now: number,
  overrides: Partial<HnsDiscoveryZoneFixture> = {},
): HnsDiscoveryZoneFixture {
  return {
    root,
    published_at: iso(now - DAY),
    inventory_expires_at: iso(now + 6 * DAY),
    checked_at: iso(now - HOUR),
    valid_until: iso(now + 5 * DAY),
    ...overrides,
  };
}

/** Listed zones first; every other zone fails exactly one condition. */
function conditionMatrix(now: number): readonly HnsDiscoveryZoneFixture[] {
  const withHost = (root: string, overrides: Partial<HnsDiscoveryZoneFixture> = {}) =>
    served(root, now, { app_host_generation: overrides.current_generation ?? 1, ...overrides });
  return [
    withHost("8s28"),
    served("a18n", now),
    withHost("older-app-host", { current_generation: 2, app_host_generation: 1 }),
    withHost("latest-health-healthy", { health: [{ gateway_healthy: false }, {}] }),
    withHost("zone-suspended", { status: "suspended" }),
    withHost("zone-revoked", { status: "revoked" }),
    withHost("inventory-reference", { inventory_mismatch: "reference" }),
    withHost("inventory-version", { inventory_mismatch: "version" }),
    withHost("inventory-digest", { inventory_mismatch: "digest" }),
    withHost("inventory-unpublished", { published_at: iso(now + DAY) }),
    withHost("inventory-expired", {
      published_at: iso(now - 2 * DAY),
      inventory_expires_at: iso(now - HOUR),
    }),
    withHost("health-expired", { checked_at: iso(now - 2 * HOUR), valid_until: iso(now - HOUR) }),
    withHost("delegation-false", { health: [{ delegation_matches: false }] }),
    withHost("ds-false", { health: [{ ds_authenticates_zone: false }] }),
    withHost("zone-digest-false", { health: [{ retained_zone_digest_matches: false }] }),
    withHost("gateway-false", { health: [{ gateway_healthy: false }] }),
    withHost("delegation-reference", {
      health: [{ stable_chain_delegation_snapshot_reference: "hns-root-chain:other" }],
    }),
    withHost("delegation-digest", {
      health: [{ stable_chain_delegation_snapshot_digest: otherDigest("delegation") }],
    }),
    withHost("keyset-reference", {
      health: [{ observed_dnssec_keyset_reference: "pdns-keyset:x" }],
    }),
    withHost("keyset-version", { health: [{ observed_dnssec_keyset_version: otherDigest("ks") }] }),
    withHost("zone-bytes-digest", {
      health: [{ observed_zone_bytes_digest: otherDigest("zone") }],
    }),
    withHost("gateway-reference", {
      health: [{ observed_gateway_deployment_reference: "hns-platform-gateway:other" }],
    }),
    withHost("gateway-spki", {
      health: [{ observed_gateway_certificate_spki_sha256: otherDigest("spki") }],
    }),
    withHost("health-other-generation", {
      current_generation: 2,
      health: [{ activation_generation: 1 }],
    }),
    withHost("latest-health-unhealthy", { health: [{}, { gateway_healthy: false }] }),
    withHost("no-health", { health: [] }),
    withHost("malformed-zone-id", { dns_zone_activation_id: "hns-dns zone" }),
    withHost("malformed-gateway", { gateway_deployment_reference: ".gateway-v1" }),
    withHost("under_score"),
  ];
}

const listedByMatrix = ["8s28", "a18n", "latest-health-healthy", "older-app-host"];

/** The resolver's zone-derived columns plus the zone part of `dnsZoneHealthy`. */
async function resolverServesZone(admin: Client, root: string, at: string): Promise<boolean> {
  const result = await admin.query<Record<string, unknown>>(
    "SELECT * FROM resolve_hns_community_app_host_authority_v1($1, $2::timestamptz)",
    [`app.${root}`, at],
  );
  expect(result.rows.length).toBeLessThanOrEqual(1);
  const row = result.rows[0];
  if (row === undefined) return false;
  return (
    row.dns_zone_status === "active" &&
    row.stable_chain_delegation_matches === true &&
    row.dnssec_ds_authenticates_zone === true &&
    row.retained_zone_digest_matches === true &&
    row.gateway_health === "healthy" &&
    IDENTIFIER.test(String(row.dns_zone_activation_id)) &&
    IDENTIFIER.test(String(row.gateway_deployment_reference)) &&
    /^[0-9a-f]{64}$/u.test(String(row.gateway_certificate_spki_sha256)) &&
    LDH.test(root)
  );
}

suite("HNS namespace discovery served-roots query (Postgres 17)", () => {
  test("lists exactly the zones that pass every zone condition", async () => {
    await withSchema(async ({ admin, connection, schema, now }) => {
      const zones = conditionMatrix(now);
      await seedHnsDiscoveryZones(admin, schema, zones);
      const roots = await servedRoots(connection);
      expect(rootsOf(roots)).toEqual(listedByMatrix);
      for (const entry of roots.roots) {
        expect(entry.expires_at > roots.generated_at).toBe(true);
        expect(entry.expires_at).toBe(iso(now + 5 * DAY));
      }
      const response = await discover(connection);
      expect(Schema.decodeUnknownSync(HnsNamespaceDiscoveryV1)(response)).toEqual(response);
      expect(response.version).toBe(1);
      expect(response.roots).toEqual([...roots.roots]);
    });
  }, 30_000);

  test("agrees with the resolver's zone-derived columns for every zone with an app host", async () => {
    await withSchema(async ({ admin, connection, schema, now }) => {
      const zones = conditionMatrix(now);
      await seedHnsDiscoveryZones(admin, schema, zones);
      const roots = await servedRoots(connection);
      const listed = new Set(rootsOf(roots));
      const resolverServed: string[] = [];
      for (const zone of zones) {
        if (zone.app_host_generation === undefined) continue;
        const resolverVerdict = await resolverServesZone(admin, zone.root, roots.generated_at);
        expect({ root: zone.root, listed: listed.has(zone.root) }).toEqual({
          root: zone.root,
          listed: resolverVerdict,
        });
        if (resolverVerdict) resolverServed.push(zone.root);
      }
      expect(resolverServed.sort()).toEqual(["8s28", "latest-health-healthy", "older-app-host"]);
      // The app host still binds generation 1, so the whole of dnsZoneHealthy would
      // refuse it while the zone itself is served.
      const olderHost = await admin.query<Record<string, unknown>>(
        "SELECT * FROM resolve_hns_community_app_host_authority_v1('app.older-app-host', $1)",
        [roots.generated_at],
      );
      expect(olderHost.rows[0]).toMatchObject({
        activation_dns_zone_generation: "1",
        dns_zone_activation_generation: "2",
      });
    });
  }, 30_000);

  test("lists healthy hermetic a18n- and 8s28-shaped zones, including one with no app host", async () => {
    await withSchema(async ({ admin, connection, schema, now }) => {
      await seedHnsDiscoveryZones(admin, schema, [
        served("a18n", now),
        served("8s28", now, { app_host_generation: 1 }),
      ]);
      expect(rootsOf(await discover(connection))).toEqual(["8s28", "a18n"]);
      // Parity cannot cover the zone-only root: the resolver needs a host.
      const resolved = await admin.query(
        "SELECT * FROM resolve_hns_community_app_host_authority_v1('app.a18n', clock_timestamp())",
      );
      expect(resolved.rows).toEqual([]);
    });
  }, 30_000);

  test("takes expires_at as the earlier of health validity and inventory expiry", async () => {
    await withSchema(async ({ admin, connection, schema, now }) => {
      await seedHnsDiscoveryZones(admin, schema, [
        served("health-first", now, { valid_until: iso(now + 3 * DAY) }),
        served("inventory-first", now, { inventory_expires_at: iso(now + 2 * DAY) }),
      ]);
      expect((await discover(connection)).roots).toEqual([
        { root: "health-first", expires_at: iso(now + 3 * DAY) },
        { root: "inventory-first", expires_at: iso(now + 2 * DAY) },
      ]);
    });
  }, 30_000);

  test("lists only LDH roots and never a reserved root", async () => {
    await withSchema(async ({ admin, connection, schema, now }) => {
      const roots = ["8s28", "xn--pokmon-dva", "com", "box", "eth", "onion", "alt", "corp", "lan"];
      await seedHnsDiscoveryZones(admin, schema, [
        ...roots.map((root) => served(root, now)),
        served("under_score", now),
      ]);
      expect(rootsOf(await servedRoots(connection))).toEqual([...roots].sort());
      expect(rootsOf(await discover(connection))).toEqual(["8s28", "xn--pokmon-dva"]);
    });
  }, 30_000);

  test("answers more than 256 qualifying roots with InternalError instead of truncating", async () => {
    await withSchema(async ({ admin, connection, schema, now }) => {
      const root = (index: number) => `bound-${index.toString().padStart(3, "0")}`;
      await seedHnsDiscoveryZones(admin, schema, [
        ...Array.from({ length: 256 }, (_, index) => served(root(index), now)),
        served("com", now),
      ]);
      expect((await discover(connection)).roots).toHaveLength(256);
      await seedHnsDiscoveryZones(admin, schema, [served(root(256), now)]);
      expect((await servedRoots(connection)).roots).toHaveLength(258);
      const failure = await Effect.runPromise(Effect.flip(listHnsNamespaces(storeFor(connection))));
      expect(failure).toBeInstanceOf(InternalError);
    });
  }, 60_000);

  test("answers a database failure with InternalError", async () => {
    await withSchema(async () => {
      if (connectionString === undefined) throw new Error("Postgres test URL is unavailable");
      const missing = scopedConnection(connectionString, `hns_discovery_missing_${randomUUID()}`);
      const failure = await Effect.runPromise(Effect.flip(listHnsNamespaces(storeFor(missing))));
      expect(failure).toBeInstanceOf(InternalError);
    });
  }, 30_000);

  test("reads the clock once and judges every condition at its millisecond truncation", async () => {
    await withSchema(async ({ admin, schema }) => {
      const clock = quoteIdentifier(`hns_discovery_clock_${randomUUID().replaceAll("-", "")}`);
      const at = (time: string) => `2026-10-22T07:00:${time}Z`;
      const zone = (root: string, overrides: Partial<HnsDiscoveryZoneFixture> = {}) => ({
        root,
        published_at: "2026-10-21T07:00:00.000Z",
        inventory_expires_at: "2026-10-28T07:00:00.000Z",
        checked_at: "2026-10-21T07:00:00.000Z",
        valid_until: "2026-10-27T07:00:00.000Z",
        ...overrides,
      });
      await admin.query("BEGIN");
      try {
        await admin.query("SET LOCAL session_replication_role = replica");
        for (const fixture of [
          zone("next-millisecond", { valid_until: at("00.001000") }),
          zone("same-millisecond", { valid_until: at("00.000900") }),
          zone("at-database-clock", { valid_until: at("00.000500") }),
          zone("at-generated-at", { valid_until: at("00.000000") }),
          zone("inventory-same-millisecond", { inventory_expires_at: at("00.000700") }),
          zone("published-at-generated-at", { published_at: at("00.000000") }),
          zone("published-within-millisecond", { published_at: at("00.000400") }),
        ]) {
          await insertHnsDiscoveryZone(admin, fixture);
        }
        // A volatile stand-in that resolves ahead of pg_catalog counts every
        // clock reading the exact production statement makes.
        await admin.query(`CREATE SCHEMA ${clock}`);
        await admin.query(`CREATE SEQUENCE ${clock}.readings`);
        await admin.query(
          `CREATE FUNCTION ${clock}.clock_timestamp() RETURNS timestamptz
             LANGUAGE plpgsql VOLATILE AS $$
           BEGIN
             PERFORM nextval('${clock}.readings');
             RETURN '${at("00.000500")}'::timestamptz;
           END
           $$`,
        );
        await admin.query(
          `SET LOCAL search_path TO ${quoteIdentifier(schema)}, ${clock}, pg_catalog`,
        );
        const result = await admin.query(HNS_SERVED_ROOTS_SQL);
        expect(result.rows).toEqual([
          {
            generated_at: at("00.000"),
            roots: [
              { root: "next-millisecond", expires_at: at("00.001") },
              { root: "published-at-generated-at", expires_at: "2026-10-27T07:00:00.000Z" },
            ],
          },
        ]);
        const readings = await admin.query(`SELECT last_value, is_called FROM ${clock}.readings`);
        expect(readings.rows).toEqual([{ last_value: "1", is_called: true }]);
      } finally {
        await admin.query("ROLLBACK");
      }
    });
  }, 30_000);
});

afterAll(async () => {
  await reusableSchema.dispose();
});
