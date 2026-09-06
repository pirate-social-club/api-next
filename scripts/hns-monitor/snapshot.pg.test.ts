import { describe, expect, test } from "bun:test";
import { Client } from "pg";
import { seedContinuityFixture } from "../hns-continuity/promotion.pg-fixture.mjs";
import { applyPostgresTestBaselineConnection } from "../postgres-test-baseline.ts";
import { readMonitorSnapshot } from "./snapshot.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && connectionString === undefined)
  throw new Error("PostgreSQL monitor test connection required");
const suite = connectionString === undefined ? describe.skip : describe;

suite("HNS monitor database projection", () => {
  test("discovers retained roots, pinned inventory and absent latest health without writes", async () => {
    if (connectionString === undefined) throw new Error();
    const schema = `hns_monitor_${crypto.randomUUID().replaceAll("-", "")}`;
    const client = new Client({ connectionString });
    await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    try {
      const separator = connectionString.includes("?") ? "&" : "?";
      await applyPostgresTestBaselineConnection({
        connectionString: `${connectionString}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`,
      });
      await client.query(`SET search_path TO "${schema}"`);
      expect((await readMonitorSnapshot(client)).roots).toEqual([]);
      const fixture = await seedContinuityFixture(client);
      const snapshot = await readMonitorSnapshot(client);
      expect(snapshot.roots).toHaveLength(1);
      expect(snapshot.roots[0]?.imported).toBe(false);
      expect(snapshot.roots[0]?.inventory_remaining).toBeGreaterThan(86000);
      expect(snapshot.heartbeat_remaining).toBeNull();
      expect(snapshot.roots[0]?.pin).toBe(fixture.state.dns.gateway_certificate_spki_sha256);
      expect(snapshot.roots[0]?.inventory_hex).toBe(fixture.state.inventory.bytes_hex);
      // Deliberately incomplete evidence is constructed only in this isolated fixture.
      await client.query("SET session_replication_role=replica");
      await client.query(
        `INSERT INTO hns_root_health_renewal_jobs
        (renewal_job_id,root_import_session_id,dns_zone_activation_id,activation_generation,
         expected_health_generation,state,failure_code,next_attempt_at,created_at)
        VALUES('monitor-job','monitor-session',$1,$2,$3,'delayed','authority_unavailable',
          clock_timestamp()+interval '1 hour',clock_timestamp()-interval '4 hours')`,
        [
          fixture.state.dns.dns_zone_activation_id,
          fixture.state.dns.dns_zone_activation_generation,
          fixture.state.health.health_generation,
        ],
      );
      await client.query("SET session_replication_role=origin");
      expect((await readMonitorSnapshot(client)).roots[0]?.delayed_age).toBeGreaterThan(14390);
      await client.query(
        "UPDATE hns_root_health_renewal_jobs SET state='terminal',next_attempt_at=NULL,completed_at=clock_timestamp() WHERE renewal_job_id='monitor-job'",
      );
      expect((await readMonitorSnapshot(client)).roots[0]?.terminal).toBe(true);
      await client.query(
        "UPDATE hns_root_health_renewal_jobs SET expected_health_generation=expected_health_generation+1 WHERE renewal_job_id='monitor-job'",
      );
      expect((await readMonitorSnapshot(client)).roots[0]?.terminal).toBe(false);
      await client.query("SET session_replication_role=replica");
      await client.query("DELETE FROM hns_dns_zone_health_observations");
      await client.query("SET session_replication_role=origin");
      const missing = await readMonitorSnapshot(client);
      expect(missing.roots).toHaveLength(1);
      expect(missing.roots[0]?.health_remaining).toBeNull();
      expect(missing.roots[0]?.healthy).toBe(false);
      expect(
        (
          await client.query(
            "SELECT count(*)::integer AS n FROM hns_root_health_renewal_scheduler_heartbeat",
          )
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      await client.end();
    }
  }, 120000);
});
