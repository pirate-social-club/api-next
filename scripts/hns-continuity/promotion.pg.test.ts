import { describe, expect, test } from "bun:test";
import { Client } from "pg";
import {
  decodeHnsDnsHealthDocumentV1,
  encodeHnsDnsHealthDocumentV1,
} from "../../packages/application/src/hns-host-persistence.ts";
import { hnsDnsHealthStatementFromReviewedDocument } from "../../packages/platform-cf/src/hns-host-persistence-repository.ts";
import { applyPostgresTestBaselineConnection } from "../postgres-test-baseline.ts";
import { buildContinuityCandidate } from "./candidate.mjs";
import { readContinuityState } from "./database.mjs";
import { rotationFixture } from "./gateway-rotation.fixture.ts";
import { promoteContinuity } from "./promotion.mjs";
import { seedContinuityFixture } from "./promotion.pg-fixture.mjs";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && connectionString === undefined)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = connectionString === undefined ? describe.skip : describe;

suite("operator continuity PostgreSQL transaction", () => {
  for (const rotate of [false, true])
    test(`continuity rotation=${rotate}: dry-run, late rollback, atomic advance and stale fencing`, async () => {
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
        const gatewayRotation = rotate ? rotationFixture(input.state) : undefined;
        const prepared = await buildContinuityCandidate({ ...input, gatewayRotation });
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
        if (rotate) {
          const staleHealth = await buildContinuityCandidate({
            ...input,
            gatewayRotation,
            state: {
              ...input.state,
              health: {
                ...input.state.health,
                health_generation: Number(input.state.health.health_generation) + 1,
              },
            },
          });
          await expect(
            promoteContinuity({
              ...args,
              prepared: staleHealth,
              reviewedCandidateBytes: staleHealth.candidate_bytes,
              expectedCandidateSha256: staleHealth.candidate_sha256,
              mode: "--preflight",
            }),
          ).rejects.toThrow("Gateway rotation generation or identity fence changed");
          expect(await pointers()).toEqual(before);
        }
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
          (await client.query("SELECT count(*)::int AS count FROM hns_authority_inventories"))
            .rows[0].count,
        ).toBe(inventoryCount);
        await client.query(
          "DROP TRIGGER reject_continuity_sale_fixture ON community_handle_sale_namespace_activation_revisions",
        );
        if (rotate) {
          const rival = new Client({ connectionString });
          await rival.connect();
          try {
            const results = await Promise.allSettled([
              promoteContinuity({ ...args, mode: "--commit" }),
              promoteContinuity({ ...args, client: rival, mode: "--commit" }),
            ]);
            expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
            expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
          } finally {
            await rival.end();
          }
        } else {
          expect((await promoteContinuity({ ...args, mode: "--commit" })).committed).toBe(true);
        }
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
        if (rotate) {
          const current = await readContinuityState(client, input.state.dns.canonical_root);
          expect(current.dns.gateway_deployment_reference).toBe(gatewayRotation.gateway_reference);
          expect(current.app.gateway_deployment_reference).toBe(gatewayRotation.gateway_reference);
          expect(Number(current.sale.dns_zone_activation_generation)).toBe(
            prepared.candidate.generations.dns_activation_generation,
          );
          const artifact = prepared.candidate.artifacts.find(
            (entry) => entry.name === "health_observation",
          );
          const health = decodeHnsDnsHealthDocumentV1(
            Uint8Array.from(Buffer.from(artifact.bytes_hex, "hex")),
          );
          const stale = hnsDnsHealthStatementFromReviewedDocument(
            encodeHnsDnsHealthDocumentV1({
              ...health,
              operation_id: "rotation-stale-health",
              idempotency_key: "rotation-stale-health",
              request_hash: "a".repeat(64),
              expected_health_generation: 1,
              observed_gateway_deployment_reference: input.state.dns.gateway_deployment_reference,
            }),
          );
          await client.query("BEGIN");
          try {
            await client.query(stale.text, [...stale.values]);
            const invalid = await client.query(
              "SELECT * FROM current_hns_sale_namespace_dependency_v1($1,$2,$3,$4,$5,clock_timestamp())",
              [
                input.state.sale.community_id,
                input.state.sale.namespace_authority_reference,
                input.state.sale.namespace_authority_generation,
                input.state.dns.dns_zone_activation_id,
                prepared.candidate.generations.dns_activation_generation,
              ],
            );
            expect(invalid.rows[0].dns_delegation_current).toBe(false);
          } finally {
            await client.query("ROLLBACK");
          }
        }
        await expect(promoteContinuity({ ...args, mode: "--commit" })).rejects.toThrow(
          "generation_fence_changed",
        );
        expect(await pointers()).toEqual([before[0] + 1, before[1] + 1, before[2] + 1, 1]);
        // Advance to a second reference, then restore the first exact reviewed manifest.
        if (rotate) {
          const secondState = await readContinuityState(client, input.state.dns.canonical_root);
          const second = await buildContinuityCandidate({
            ...input,
            state: secondState,
            gatewayRotation: rotationFixture(secondState, "second-successor"),
          });
          await promoteContinuity({
            ...args,
            state: secondState,
            prepared: second,
            reviewedCandidateBytes: second.candidate_bytes,
            expectedCandidateSha256: second.candidate_sha256,
            mode: "--commit",
          });
        }
        // Lose the COMMIT acknowledgement on a new successor; never retry it.
        const nextState = await readContinuityState(client, input.state.dns.canonical_root);
        const restoring = rotate
          ? {
              ...gatewayRotation,
              previous_gateway_reference: nextState.dns.gateway_deployment_reference,
              observed_at: nextState.database_time,
            }
          : undefined;
        const next = await buildContinuityCandidate({
          ...input,
          state: nextState,
          gatewayRotation: restoring,
        });
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
        const advances = rotate ? 3 : 2;
        expect(await pointers()).toEqual([
          before[0] + advances,
          before[1] + advances,
          before[2] + advances,
          1,
        ]);
        if (rotate)
          expect(
            (await readContinuityState(client, input.state.dns.canonical_root)).dns
              .gateway_deployment_reference,
          ).toBe(gatewayRotation.gateway_reference);
      } finally {
        await client.query("ROLLBACK");
        await client.query(`DROP SCHEMA "${schema}" CASCADE`);
        await client.end();
      }
    }, 120000);
});
