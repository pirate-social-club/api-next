import { expect, test } from "bun:test";
import type { Client } from "pg";
import {
  applyStagingHnsGatewayGrantPlan,
  STAGING_HNS_GATEWAY_READ_FUNCTIONS,
  STAGING_HNS_GATEWAY_READ_TABLES,
  stagingHnsGatewayGrantPlan,
} from "./staging-hns-gateway-role.ts";
import {
  parseStagingHnsGatewayRoleCommand,
  runStagingHnsGatewayRoleCommand,
} from "./staging-hns-gateway-role-cli.ts";

test("staging gateway plan grants only exact resolver dependencies", () => {
  const plan = stagingHnsGatewayGrantPlan("pscale_api_gateway_test");
  expect(plan.statements[0]).toBe('GRANT USAGE ON SCHEMA api_next TO "pscale_api_gateway_test"');
  expect(plan.statements).toHaveLength(
    1 + STAGING_HNS_GATEWAY_READ_TABLES.length + STAGING_HNS_GATEWAY_READ_FUNCTIONS.length,
  );
  expect(plan.statements.filter((statement) => statement.startsWith("GRANT SELECT"))).toHaveLength(
    STAGING_HNS_GATEWAY_READ_TABLES.length,
  );
  expect(plan.statements.filter((statement) => statement.startsWith("GRANT EXECUTE"))).toHaveLength(
    STAGING_HNS_GATEWAY_READ_FUNCTIONS.length,
  );
  expect(plan.statements.join("\n")).not.toMatch(
    /INSERT|UPDATE|DELETE|ALL TABLES|pg_read_all_data/u,
  );
  expect(plan.sha256).toMatch(/^[0-9a-f]{64}$/u);
  expect(stagingHnsGatewayGrantPlan("pscale_api_gateway_test")).toEqual(plan);
  expect(() => stagingHnsGatewayGrantPlan('unsafe"role')).toThrow("staging_gateway_role_invalid");
});

test("staging gateway refuses absent, drifted or mismatched approval before SQL", async () => {
  let calls = 0;
  const client = {
    query: async () => {
      calls++;
      throw new Error("SQL must not be reached");
    },
  } as unknown as Client;
  const plan = stagingHnsGatewayGrantPlan("pscale_api_gateway_test");
  for (const [candidate, approval] of [
    [plan, ""],
    [
      { ...plan, statements: [...plan.statements, "GRANT ALL ON SCHEMA api_next TO PUBLIC"] },
      plan.sha256,
    ],
    [{ ...plan, sha256: "0".repeat(64) }, plan.sha256],
  ] as const) {
    await expect(applyStagingHnsGatewayGrantPlan(client, candidate, approval)).rejects.toThrow(
      "staging_gateway_grant_plan_not_approved",
    );
  }
  expect(calls).toBe(0);
});

test("staging gateway command is dry-run first and refuses malformed execution", async () => {
  const role = "pscale_api_gateway_test";
  const dryRun = await runStagingHnsGatewayRoleCommand(["--role", role], {});
  expect(dryRun.outcome).toBe("staging_gateway_grants_dry_run");
  expect(dryRun.role).toBe(role);
  expect(dryRun.plan_sha256).toBe(stagingHnsGatewayGrantPlan(role).sha256);
  expect(() => parseStagingHnsGatewayRoleCommand(["--role", role, "extra"])).toThrow();
  expect(() => parseStagingHnsGatewayRoleCommand(["--role", role, "--execute"])).toThrow(
    "staging_gateway_approval_required",
  );
  expect(() =>
    parseStagingHnsGatewayRoleCommand(["--role", role, "--approve-plan-sha256", "a"]),
  ).toThrow("staging_gateway_approval_without_execute");
  await expect(
    runStagingHnsGatewayRoleCommand(
      ["--role", role, "--execute", "--approve-plan-sha256", "0".repeat(64)],
      {},
    ),
  ).rejects.toThrow("staging_gateway_grant_plan_not_approved");
  await expect(
    runStagingHnsGatewayRoleCommand(
      [
        "--role",
        role,
        "--execute",
        "--approve-plan-sha256",
        stagingHnsGatewayGrantPlan(role).sha256,
      ],
      {},
    ),
  ).rejects.toThrow("staging_gateway_admin_credential_missing");
});
