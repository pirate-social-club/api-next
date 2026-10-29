import { describe, expect, test } from "bun:test";
import { Client } from "pg";
import {
  decodeHnsDnsHealthDocumentV1,
  encodeHnsDnsHealthDocumentV1,
} from "../packages/application/src/hns-host-persistence.ts";
import { resolveActiveHnsHostAuthority } from "../packages/application/src/hns-host-serving.ts";
import { promoteHnsAuthoritySuccessorInTransaction } from "../packages/platform-cf/src/hns-authority-successor-promotion.ts";
import { readContinuityState } from "./hns-continuity/database.mjs";
import { transactionAuthoritySources } from "./hns-staging-gateway/authority.ts";
import {
  cookieCensusIdentity,
  lockCookieCensus,
  readCookieCensus,
} from "./hns-staging-gateway/census.mjs";
import {
  applyCookieProfileSuccessor,
  prepareCookieProfileSuccessor,
  readbackCookieProfileSuccessor,
} from "./hns-staging-gateway/cookie.mjs";
import { seedCookieProfileFixture } from "./hns-staging-gateway/cookie.pg-fixture.mjs";
import { NEXT_GATEWAY, PREVIOUS_GATEWAY } from "./hns-staging-gateway/cookie-plan.ts";
import { digest } from "./hns-staging-gateway/identity.mjs";
import { applyPostgresTestBaselineConnection } from "./postgres-test-baseline.ts";

const connection = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && connection === undefined)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = connection === undefined ? describe.skip : describe;

/** Redirect only the fixed production-schema SET to this test's isolated schema.
 * All authority reads, locks and writes remain actual PostgreSQL operations. */
function scopedClient(client: Client, schema: string): Client {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === "query")
        return (query: string | { text: string }, values?: unknown[]) => {
          if (query === "SET LOCAL search_path TO api_next, public")
            return target.query(`SET LOCAL search_path TO "${schema}", public`);
          return typeof query === "string" ? target.query(query, values) : target.query(query);
        };
      return Reflect.get(target, property, receiver);
    },
  });
}

suite("staging cookie profile PostgreSQL authority boundary", () => {
  test("readback refuses a healthy payload-divergent result written through the maintained promotion", async () => {
    if (connection === undefined) throw new Error("Fixture connection unavailable");
    const schema = `hns_cookie_divergent_${crypto.randomUUID().replaceAll("-", "")}`;
    const admin = new Client({ connectionString: connection });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    try {
      await applyPostgresTestBaselineConnection({
        connectionString: `${connection}${connection.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`,
      });
      await admin.query(`SET search_path TO "${schema}"`);
      const client = scopedClient(admin, schema);
      const manifests = await seedCookieProfileFixture(admin);
      const state = await readContinuityState(admin, "8s28");
      const census = await readCookieCensus(admin);
      const manifest = JSON.parse(manifests.nextManifest);
      const plan = await prepareCookieProfileSuccessor({
        ...manifests,
        states: [state],
        census,
        executeBy: new Date(Date.parse(census.database_time) + 600000).toISOString(),
        readiness: {
          version: "hns-reviewed-gateway-rotation-v1",
          previous_gateway_reference: PREVIOUS_GATEWAY,
          gateway_reference: NEXT_GATEWAY,
          profile_sha256: manifest.profile_sha256,
          handle_profile_sha256: manifest.handle_profile_sha256,
          manifest_json: manifests.nextManifest,
          observed_at: census.database_time,
          readiness: "operator_attested_shadow_ready",
        },
      });
      const entry = plan.entries[0];
      if (!entry) throw new Error("Expected selected entry");
      const health = decodeHnsDnsHealthDocumentV1(Buffer.from(entry.health_hex, "hex"));
      await admin.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await lockCookieCensus(admin);
      await admin.query(
        "SELECT 1 FROM hns_dns_zone_activation_current WHERE canonical_root='8s28' FOR UPDATE",
      );
      await admin.query(
        "SELECT 1 FROM hns_community_app_host_activation_current WHERE normalized_host='app.8s28' FOR UPDATE",
      );
      await admin.query(
        "SELECT 1 FROM community_handle_sale_namespace_activation_current WHERE canonical_root='8s28' FOR UPDATE",
      );
      // The supplied intent hash and all operation IDs/generations stay equal.
      // The real generic writer permits this different still-live lifetime.
      await promoteHnsAuthoritySuccessorInTransaction({
        client: admin,
        inventoryRegistryReference: state.inventory.registry_reference,
        authorityInventoryBytes: Buffer.from(state.inventory.bytes_hex, "hex"),
        dnsActivationBytes: Buffer.from(entry.dns_hex, "hex"),
        appActivationBytes: Buffer.from(entry.app_hex, "hex"),
        healthObservationBytes: encodeHnsDnsHealthDocumentV1({
          ...health,
          valid_for_seconds: health.valid_for_seconds - 1,
        }),
        successorId: entry.successor_id,
        gatewayRotation: {
          reviewed: plan.readiness,
          previousHealthGeneration: Number(state.health.health_generation),
        },
        rootLabel: "8s28",
        generations: entry.generations,
        sale: state.sale,
      });
      await admin.query("COMMIT");
      const actual = await readContinuityState(admin, "8s28");
      expect(
        new Date(actual.health.valid_until).getTime() -
          new Date(actual.health.checked_at).getTime(),
      ).toBe((health.valid_for_seconds - 1) * 1000);
      expect(
        resolveActiveHnsHostAuthority(await transactionAuthoritySources(admin).app("app.8s28")),
      ).not.toBeNull();
      expect(
        await readbackCookieProfileSuccessor({ client, plan, confirmedSha256: digest(plan) }),
      ).toMatchObject({ outcome: "unknown", automatic_retry: false });
    } finally {
      await admin.query("ROLLBACK").catch(() => undefined);
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  }, 120000);

  test("executes real 8-only rollback/promotion, fences co-tenants and never retries an uncertain commit", async () => {
    if (connection === undefined) throw new Error("Fixture connection unavailable");
    const schema = `hns_cookie_${crypto.randomUUID().replaceAll("-", "")}`;
    const admin = new Client({ connectionString: connection });
    const rival = new Client({ connectionString: connection });
    await admin.connect();
    await rival.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const separator = connection.includes("?") ? "&" : "?";
    try {
      await applyPostgresTestBaselineConnection({
        connectionString: `${connection}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`,
      });
      await admin.query(`SET search_path TO "${schema}"`);
      await rival.query(`SET search_path TO "${schema}"`);
      const client = scopedClient(admin, schema);
      const manifests = await seedCookieProfileFixture(admin);
      const prepare = async () => {
        const state = await readContinuityState(admin, "8s28");
        const census = await readCookieCensus(admin);
        return prepareCookieProfileSuccessor({
          ...manifests,
          states: [state],
          census,
          executeBy: new Date(Date.parse(census.database_time) + 600000).toISOString(),
          readiness: {
            version: "hns-reviewed-gateway-rotation-v1",
            previous_gateway_reference: PREVIOUS_GATEWAY,
            gateway_reference: NEXT_GATEWAY,
            profile_sha256: JSON.parse(manifests.nextManifest).profile_sha256,
            handle_profile_sha256: JSON.parse(manifests.nextManifest).handle_profile_sha256,
            manifest_json: manifests.nextManifest,
            observed_at: census.database_time,
            readiness: "operator_attested_shadow_ready",
          },
        });
      };
      let plan = await prepare();
      const before = plan.census;
      const args = () => ({ client, plan, confirmedSha256: digest(plan) });
      expect((await readbackCookieProfileSuccessor(args())).outcome).toBe("not_committed");
      const sources = transactionAuthoritySources(admin);
      expect(resolveActiveHnsHostAuthority(await sources.app("app.8s28"))).not.toBeNull();
      expect(
        resolveActiveHnsHostAuthority(await sources.handle("participant.8s28")),
      ).not.toBeNull();
      expect(resolveActiveHnsHostAuthority(await sources.app("app.a18n"))).toBeNull();
      expect(resolveActiveHnsHostAuthority(await sources.handle("participant.a18n"))).toBeNull();
      expect((await applyCookieProfileSuccessor({ ...args(), mode: "preflight" })).committed).toBe(
        false,
      );
      expect(cookieCensusIdentity(await readCookieCensus(admin))).toBe(
        cookieCensusIdentity(before),
      );
      expect(
        (await applyCookieProfileSuccessor({ ...args(), mode: "rehearse" })).results,
      ).toHaveLength(1);
      expect(cookieCensusIdentity(await readCookieCensus(admin))).toBe(
        cookieCensusIdentity(before),
      );

      await admin.query("CREATE SEQUENCE cookie_late_failure");
      await admin.query(`CREATE FUNCTION reject_cookie_sale() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        PERFORM nextval('cookie_late_failure'); RAISE EXCEPTION 'cookie late sale fixture'; END $$`);
      await admin.query(
        "CREATE TRIGGER reject_cookie_sale BEFORE INSERT ON community_handle_sale_namespace_activation_revisions FOR EACH ROW EXECUTE FUNCTION reject_cookie_sale()",
      );
      await expect(applyCookieProfileSuccessor({ ...args(), mode: "commit" })).rejects.toThrow();
      expect(
        (await admin.query("SELECT is_called FROM cookie_late_failure")).rows[0]?.is_called,
      ).toBe(true);
      expect(cookieCensusIdentity(await readCookieCensus(admin))).toBe(
        cookieCensusIdentity(before),
      );
      await admin.query(
        "DROP TRIGGER reject_cookie_sale ON community_handle_sale_namespace_activation_revisions",
      );

      // An unselected field changes without making that expired tenant live.
      // The old reviewed census must still refuse before any selected write.
      await rival.query("UPDATE personas SET status='suspended' WHERE persona_id='persona-a18n'");
      await expect(applyCookieProfileSuccessor({ ...args(), mode: "rehearse" })).rejects.toThrow(
        "census changed",
      );
      expect((await readContinuityState(admin, "8s28")).dns.gateway_deployment_reference).toBe(
        PREVIOUS_GATEWAY,
      );
      await rival.query("UPDATE personas SET status='active' WHERE persona_id='persona-a18n'");
      plan = await prepare();

      // Real concurrent selector writer holds its table/row lock. The rotation
      // waits, then sees the committed changed selector and refuses stale bytes.
      await rival.query("BEGIN");
      await rival.query(
        "UPDATE hns_dns_zone_activation_current SET updated_at=clock_timestamp() WHERE canonical_root='a18n'",
      );
      const pid = (await admin.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
      const pending = applyCookieProfileSuccessor({ ...args(), mode: "rehearse" }).then(
        () => ({ rejected: false, error: null as unknown }),
        (error: unknown) => ({ rejected: true, error }),
      );
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        waiting =
          (
            await rival.query(
              "SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",
              [pid],
            )
          ).rows[0]?.waiting === true;
        if (waiting) break;
        await Bun.sleep(20);
      }
      expect(waiting).toBe(true);
      await rival.query("COMMIT");
      const refused = await pending;
      expect(refused.rejected).toBe(true);
      expect(String(refused.error)).toContain("census changed");
      expect((await readContinuityState(admin, "8s28")).dns.gateway_deployment_reference).toBe(
        PREVIOUS_GATEWAY,
      );
      plan = await prepare();

      // A real added current root cannot be omitted from a reviewed census,
      // even though its remaining serving dependencies are unavailable.
      await rival.query("SET session_replication_role=replica");
      try {
        await rival.query(`INSERT INTO hns_dns_zone_activation_revisions
          SELECT (jsonb_populate_record(NULL::hns_dns_zone_activation_revisions,
            to_jsonb(r)||jsonb_build_object('canonical_root','cookie-added','dns_zone_activation_id','cookie-added-dns'))).*
          FROM hns_dns_zone_activation_revisions r JOIN hns_dns_zone_activation_current c
          ON c.dns_zone_activation_id=r.dns_zone_activation_id AND c.current_generation=r.dns_zone_activation_generation
          WHERE c.canonical_root='a18n'`);
        await rival.query(`INSERT INTO hns_dns_zone_activation_current
          SELECT (jsonb_populate_record(NULL::hns_dns_zone_activation_current,
            to_jsonb(c)||jsonb_build_object('canonical_root','cookie-added','dns_zone_activation_id','cookie-added-dns'))).*
          FROM hns_dns_zone_activation_current c WHERE c.canonical_root='a18n'`);
      } finally {
        await rival.query("SET session_replication_role=origin");
      }
      await expect(applyCookieProfileSuccessor({ ...args(), mode: "rehearse" })).rejects.toThrow(
        "root set changed",
      );
      expect((await readContinuityState(admin, "8s28")).dns.gateway_deployment_reference).toBe(
        PREVIOUS_GATEWAY,
      );
      await rival.query("SET session_replication_role=replica");
      try {
        await rival.query(
          "DELETE FROM hns_dns_zone_activation_current WHERE canonical_root='cookie-added'",
        );
        await rival.query(
          "DELETE FROM hns_dns_zone_activation_revisions WHERE canonical_root='cookie-added'",
        );
      } finally {
        await rival.query("SET session_replication_role=origin");
      }
      plan = await prepare();

      // Force expiry after the transaction enters, before its first census read.
      const elapsed = structuredClone(plan);
      elapsed.execute_by = new Date(Date.parse(elapsed.census.database_time) + 1000).toISOString();
      const rebuilt = await prepareCookieProfileSuccessor({
        ...manifests,
        states: elapsed.entries.map((entry) => entry.predecessor),
        census: elapsed.census,
        executeBy: elapsed.execute_by,
        readiness: elapsed.readiness,
      });
      let enteredBeforeDeadline = false;
      const delayed = new Proxy(client, {
        get(target, property, receiver) {
          if (property === "query")
            return async (query: string | { text: string }, values?: unknown[]) => {
              const result =
                typeof query === "string"
                  ? await target.query(query, values)
                  : await target.query(query);
              if (typeof query === "string" && query.startsWith("LOCK TABLE ")) {
                enteredBeforeDeadline = Date.now() < Date.parse(rebuilt.execute_by);
                await Bun.sleep(Math.max(1, Date.parse(rebuilt.execute_by) - Date.now() + 20));
              }
              return result;
            };
          return Reflect.get(target, property, receiver);
        },
      });
      await expect(
        applyCookieProfileSuccessor({
          client: delayed,
          plan: rebuilt,
          confirmedSha256: digest(rebuilt),
          mode: "rehearse",
        }),
      ).rejects.toThrow("window elapsed");
      expect(enteredBeforeDeadline).toBe(true);
      expect((await readContinuityState(admin, "8s28")).dns.gateway_deployment_reference).toBe(
        PREVIOUS_GATEWAY,
      );

      plan = await prepare();
      const original = await readContinuityState(admin, "8s28");
      const unselected = plan.census.roots.find((tenant) => tenant.root === "a18n");
      let commits = 0;
      const uncertain = new Proxy(client, {
        get(target, property, receiver) {
          if (property === "query")
            return async (query: string | { text: string }, values?: unknown[]) => {
              if (query === "COMMIT") {
                commits++;
                await target.query(query);
                throw new Error("fixture lost COMMIT acknowledgement");
              }
              return typeof query === "string" ? target.query(query, values) : target.query(query);
            };
          return Reflect.get(target, property, receiver);
        },
      });
      await expect(
        applyCookieProfileSuccessor({ ...args(), client: uncertain, mode: "commit" }),
      ).rejects.toThrow("lost COMMIT acknowledgement");
      expect(commits).toBe(1);
      expect(await readbackCookieProfileSuccessor(args())).toMatchObject({
        outcome: "committed",
        automatic_retry: false,
      });
      const after = await readCookieCensus(admin);
      expect(after.roots.find((tenant) => tenant.root === "a18n")).toEqual(unselected);
      const advanced = await readContinuityState(admin, "8s28");
      expect(Number(advanced.dns.dns_zone_activation_generation)).toBe(
        Number(original.dns.dns_zone_activation_generation) + 1,
      );
      expect(Number(advanced.app.app_host_activation_generation)).toBe(
        Number(original.app.app_host_activation_generation) + 1,
      );
      expect(Number(advanced.sale.sale_namespace_activation_generation)).toBe(
        Number(original.sale.sale_namespace_activation_generation) + 1,
      );
      expect(advanced.dns.gateway_deployment_reference).toBe(NEXT_GATEWAY);
      for (const key of [
        "zone_hex",
        "dnssec_keyset_reference",
        "dnssec_keyset_version",
        "stable_chain_delegation_snapshot_reference",
        "stable_chain_delegation_snapshot_digest",
        "gateway_certificate_spki_sha256",
      ])
        expect(advanced.dns[key]).toEqual(original.dns[key]);
      expect(new Date(advanced.health.valid_until).getTime()).toBeLessThanOrEqual(
        Date.parse(plan.entries[0]!.health_deadline),
      );
      expect(resolveActiveHnsHostAuthority(await sources.app("app.8s28"))).not.toBeNull();
      const handle = await sources.handle("participant.8s28");
      expect(resolveActiveHnsHostAuthority(handle)).not.toBeNull();
      if (handle?.variant !== "handle_persona_v1")
        throw new Error("Expected actual handle authority");
      expect(handle.sale_namespace_gateway_deployment_reference).toBe(NEXT_GATEWAY);
      expect(handle.dns_zone.gateway_deployment_reference).toBe(NEXT_GATEWAY);
      expect(resolveActiveHnsHostAuthority(await sources.app("app.a18n"))).toBeNull();
      expect(resolveActiveHnsHostAuthority(await sources.handle("participant.a18n"))).toBeNull();
      await expect(applyCookieProfileSuccessor({ ...args(), mode: "commit" })).rejects.toThrow();
      expect(commits).toBe(1);
    } finally {
      await rival.query("ROLLBACK").catch(() => undefined);
      await admin.query("ROLLBACK").catch(() => undefined);
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await rival.end();
      await admin.end();
    }
  }, 120000);
});
