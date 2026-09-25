import { expect, test } from "bun:test";
import { Client } from "pg";
import {
  applyStagingHnsGatewayGrantPlan,
  STAGING_HNS_GATEWAY_READ_TABLES,
  stagingHnsGatewayGrantPlan,
} from "./staging-hns-gateway-role.ts";

const raw = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (!raw && process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1") {
  throw new Error("local test URL required");
}
const postgresTest = raw ? test : test.skip;

postgresTest("staging gateway grants are exact, read-only and independently checked", async () => {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const database = `hns_gateway_grants_${suffix}`;
  const role = `hns_gateway_role_${suffix}`;
  const driftRole = `hns_gateway_drift_${suffix}`;
  const root = new Client({ connectionString: raw });
  await root.connect();
  let databaseCreated = false;
  let roleCreated = false;
  let driftRoleCreated = false;
  let fixture: Client | undefined;
  try {
    await root.query(`CREATE DATABASE "${database}"`);
    databaseCreated = true;
    await root.query(`CREATE ROLE "${role}" LOGIN`);
    roleCreated = true;
    await root.query(`CREATE ROLE "${driftRole}" LOGIN`);
    driftRoleCreated = true;
    const url = new URL(raw ?? "");
    url.pathname = `/${database}`;
    fixture = new Client({ connectionString: url.toString() });
    await fixture.connect();
    await fixture.query("CREATE SCHEMA api_next");
    for (const table of STAGING_HNS_GATEWAY_READ_TABLES) {
      await fixture.query(`CREATE TABLE api_next.${table} (id integer)`);
    }
    await fixture.query("CREATE TABLE api_next.unrelated (id integer)");
    for (const name of [
      "effective_active_route",
      "effective_route_authority_v2",
      "resolve_hns_community_app_host_authority_v1",
    ]) {
      await fixture.query(
        `CREATE FUNCTION api_next.${name}(text,timestamptz) RETURNS integer LANGUAGE sql AS 'SELECT 1'`,
      );
    }
    const plan = stagingHnsGatewayGrantPlan(role, database);
    const receipt = await applyStagingHnsGatewayGrantPlan(fixture, plan, plan.sha256);
    expect(receipt).toEqual({
      outcome: "staging_gateway_grants_verified",
      role,
      plan_sha256: plan.sha256,
      table_count: 10,
      function_count: 3,
    });
    const checks = await fixture.query<{
      readonly allowed_read: boolean;
      readonly denied_write: boolean;
      readonly denied_unrelated_read: boolean;
    }>(
      `SELECT has_table_privilege($1, 'api_next.communities', 'SELECT') AS allowed_read,
              NOT has_table_privilege($1, 'api_next.communities', 'INSERT') AS denied_write,
              NOT has_table_privilege($1, 'api_next.unrelated', 'SELECT') AS denied_unrelated_read`,
      [role],
    );
    expect(checks.rows[0]).toEqual({
      allowed_read: true,
      denied_write: true,
      denied_unrelated_read: true,
    });
    await fixture.query(`GRANT USAGE ON SCHEMA api_next TO "${driftRole}"`);
    await fixture.query(`GRANT SELECT ON api_next.unrelated TO "${driftRole}"`);
    const driftPlan = stagingHnsGatewayGrantPlan(driftRole, database);
    await expect(
      applyStagingHnsGatewayGrantPlan(fixture, driftPlan, driftPlan.sha256),
    ).rejects.toThrow("staging_gateway_table_privilege_mismatch");
    const rollback = await fixture.query<{ readonly expected_read_rolled_back: boolean }>(
      `SELECT NOT has_table_privilege($1, 'api_next.communities', 'SELECT')
         AS expected_read_rolled_back`,
      [driftRole],
    );
    expect(rollback.rows[0]?.expected_read_rolled_back).toBe(true);
  } finally {
    await fixture?.end().catch(() => undefined);
    if (databaseCreated) await root.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    if (driftRoleCreated) await root.query(`DROP ROLE "${driftRole}"`);
    if (roleCreated) await root.query(`DROP ROLE "${role}"`);
    await root.end();
  }
});
