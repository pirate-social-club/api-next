import { describe, expect, test } from "bun:test";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../postgres-test-baseline.ts";
import { buildContinuityCandidate } from "./candidate.mjs";
import { readContinuityState } from "./database.mjs";
import { promoteContinuity } from "./promotion.mjs";
import { seedContinuityFixture } from "./promotion.pg-fixture.mjs";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && connectionString === undefined)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = connectionString === undefined ? describe.skip : describe;

suite("operator continuity PostgreSQL transaction", () => {
  test("dry-run writes nothing, rehearsal and late failure roll back, and commit advances all serving dependencies", async () => {
    if (connectionString === undefined) throw new Error("Test connection unavailable");
    const schema = `hns_continuity_${crypto.randomUUID().replaceAll("-", "")}`;
    const client = new Client({ connectionString });
    await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    try {
      const separator = connectionString.includes("?") ? "&" : "?";
      await applyPostgresTestBaselineConnection({
        connectionString: `${connectionString}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`,
      });
      await client.query(`SET search_path TO "${schema}"`);
      const input = await seedContinuityFixture(client);
      const prepared = await buildContinuityCandidate(input);
      const args = {
        client,
        state: input.state,
        prepared,
        reviewedCandidateBytes: prepared.candidate_bytes,
        expectedCandidateSha256: prepared.candidate_sha256,
        authoritySchema: schema,
      };
      async function pointers(): Promise<readonly [number, number, number, number]> {
        const state = await readContinuityState(client, input.state.dns.canonical_root);
        return [
          Number(state.dns.dns_zone_activation_generation),
          Number(state.app.app_host_activation_generation),
          Number(state.sale.sale_namespace_activation_generation),
          Number(state.health.health_generation),
        ];
      }
      const before = await pointers();
      expect((await promoteContinuity({ ...args, mode: "--preflight" })).committed).toBe(false);
      expect(await pointers()).toEqual(before);
      expect((await promoteContinuity({ ...args, mode: "--rehearse" })).sale_generation).toBe(
        before[2] + 1,
      );
      expect(await pointers()).toEqual(before);
      const inventoryCount = (
        await client.query("SELECT count(*)::int AS count FROM hns_authority_inventories")
      ).rows[0].count;
      // Fail the actual final sale revision after DNS, app and health have been written.
      await client.query(
        `CREATE FUNCTION reject_continuity_sale_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'continuity fixture late failure'; END $$`,
      );
      await client.query(
        "CREATE TRIGGER reject_continuity_sale_fixture BEFORE INSERT ON community_handle_sale_namespace_activation_revisions FOR EACH ROW EXECUTE FUNCTION reject_continuity_sale_fixture()",
      );
      await expect(promoteContinuity({ ...args, mode: "--commit" })).rejects.toThrow();
      expect(await pointers()).toEqual(before);
      expect(
        (await client.query("SELECT count(*)::int AS count FROM hns_authority_inventories")).rows[0]
          .count,
      ).toBe(inventoryCount);
      await client.query(
        "DROP TRIGGER reject_continuity_sale_fixture ON community_handle_sale_namespace_activation_revisions",
      );
      const receipt = await promoteContinuity({ ...args, mode: "--commit" });
      expect(receipt.committed).toBe(true);
      expect(await pointers()).toEqual([before[0] + 1, before[1] + 1, before[2] + 1, 1]);
      const dependency = await client.query(
        "SELECT * FROM current_hns_sale_namespace_dependency_v1($1,$2,$3,$4,$5,clock_timestamp())",
        [
          input.state.sale.community_id,
          input.state.sale.namespace_authority_reference,
          input.state.sale.namespace_authority_generation,
          input.state.dns.dns_zone_activation_id,
          prepared.candidate.generations.dns_activation_generation,
        ],
      );
      expect(dependency.rows[0]).toMatchObject({
        namespace_authority_current: true,
        dns_zone_current: true,
        dns_delegation_current: true,
      });
      await expect(promoteContinuity({ ...args, mode: "--commit" })).rejects.toThrow(
        "generation_fence_changed",
      );
      expect(await pointers()).toEqual([before[0] + 1, before[1] + 1, before[2] + 1, 1]);
      // Repeat the ceremony from new live pointers, then lose the COMMIT acknowledgement.
      const nextState = await readContinuityState(client, input.state.dns.canonical_root);
      const next = await buildContinuityCandidate({ ...input, state: nextState });
      let commits = 0;
      const uncertainClient = {
        query: async (...query: unknown[]) => {
          const result = await Reflect.apply(client.query, client, query);
          if (query[0] === "COMMIT") {
            commits++;
            throw new Error("fixture transport lost the commit acknowledgement");
          }
          return result;
        },
      };
      await expect(
        promoteContinuity({
          ...args,
          client: uncertainClient,
          state: nextState,
          prepared: next,
          reviewedCandidateBytes: next.candidate_bytes,
          expectedCandidateSha256: next.candidate_sha256,
          mode: "--commit",
        }),
      ).rejects.toThrow("Commit outcome unknown");
      expect(commits).toBe(1);
      expect(await pointers()).toEqual([before[0] + 2, before[1] + 2, before[2] + 2, 1]);
    } finally {
      await client.query("ROLLBACK");
      await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      await client.end();
    }
  }, 120000);
});
