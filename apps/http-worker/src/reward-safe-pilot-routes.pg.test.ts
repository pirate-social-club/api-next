import { afterAll, describe, expect, mock, test } from "bun:test";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { makeHttpWorkerTestBindings } from "./composition.test-fixtures.ts";

mock.module("cloudflare:workers", () => ({ DurableObject: class DurableObject {} }));
// Every reward write and chain read runs in the handlers or through an RPC client built
// after admission; counting both shows what a refused request never reached.
const handlers = { ...(await import("./rewards-song-offer-handlers.ts")) };
const megapotRpc = { ...(await import("@pirate/platform-cf/megapot-v2-rpc")) };
const reached = { handlers: 0, rpcClients: 0 };
mock.module("./rewards-song-offer-handlers.ts", () => ({
  ...handlers,
  makeSongRewardOfferHandlers: (
    ...input: Parameters<typeof handlers.makeSongRewardOfferHandlers>
  ) => {
    reached.handlers += 1;
    return handlers.makeSongRewardOfferHandlers(...input);
  },
}));
mock.module("@pirate/platform-cf/megapot-v2-rpc", () => ({
  ...megapotRpc,
  makeMegapotV2RpcClient: (...input: Parameters<typeof megapotRpc.makeMegapotV2RpcClient>) => {
    reached.rpcClients += 1;
    return megapotRpc.makeMegapotV2RpcClient(...input);
  },
}));
const { createProductionHttpWorker } = await import("./composition.ts");
afterAll(() => {
  mock.module("./rewards-song-offer-handlers.ts", () => handlers);
  mock.module("@pirate/platform-cf/megapot-v2-rpc", () => megapotRpc);
});
const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && connectionString === undefined)
  throw new Error("Safe pool pilot routes require the PostgreSQL test connection");
const suite = connectionString === undefined ? describe.skip : describe;

const hash = (byte: string) => `0x${byte.repeat(64)}`;
const address = (byte: string) => `0x${byte.repeat(40)}`;

suite("Safe pool pilot reward routes", () => {
  test("serve an admitted Safe attestation and stay unavailable otherwise", async () => {
    if (connectionString === undefined) throw new Error();
    const database = `safe_pilot_routes_${crypto.randomUUID().replaceAll("-", "")}`;
    const control = new Client({ connectionString });
    await control.connect();
    await control.query(`CREATE DATABASE "${database}"`);
    const url = new URL(connectionString);
    url.pathname = `/${database}`;
    url.searchParams.set("options", "-c search_path=api_next");
    const connection = url.toString();
    const admin = new Client({ connectionString: connection });
    const original = globalThis.fetch;
    try {
      await admin.connect();
      await admin.query("CREATE SCHEMA api_next");
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      // A staging Safe on Base Sepolia and a production Safe on Base, each the
      // owner-executed custody of its own attestation.
      await admin.query("SET session_replication_role = replica");
      for (const [attestationId, environment, chainId, safe] of [
        ["staging-safe", "staging", 84_532, address("5")],
        ["production-safe", "production", 8453, address("7")],
      ] as const) {
        await admin.query(
          `INSERT INTO reward_signer_nonces (chain_id,signer_address,next_nonce,
             observed_pending_nonce,observed_block_number,observed_block_hash,observed_at,
             nonce_authority)
           VALUES ($1,$2,0,0,1,$3,clock_timestamp(),'safe_owner_v1')`,
          [chainId, safe, hash("1")],
        );
        await admin.query(
          `INSERT INTO megapot_deployment_attestations (attestation_id, environment, chain_id,
             jackpot_address, usdc_address, ticket_nft_address, custody_address,
             referrer_address, source_tag, jackpot_code_hash, usdc_code_hash,
             ticket_nft_code_hash, attestation_block_number, attestation_block_hash,
             abi_version, status, verified_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,900,$13,'megapot_v2','active',
             clock_timestamp())`,
          [
            attestationId,
            environment,
            chainId,
            address("2"),
            address("3"),
            address("4"),
            safe,
            address("6"),
            hash("8"),
            hash("a"),
            hash("b"),
            hash("c"),
            hash("d"),
          ],
        );
      }
      await admin.query("SET session_replication_role = origin");
      const base = {
        ...(await makeHttpWorkerTestBindings(connection)),
        SONG_FUNDING_COMMANDS: { connectionString: "postgres://funding@127.0.0.1:1/fixture" },
      };
      const fetches: string[] = [];
      globalThis.fetch = (async (input: string | URL | Request) => {
        fetches.push(String(input));
        throw new Error("no outbound request in this test");
      }) as unknown as typeof fetch;
      const pool = async (overrides: Readonly<Record<string, string>>) => {
        const worker = await createProductionHttpWorker({
          ...base,
          API_NEXT_ENV: "staging",
          ...overrides,
        });
        reached.handlers = 0;
        reached.rpcClients = 0;
        fetches.length = 0;
        const response = await worker.request(
          "https://worker.test/communities/community-1/posts/post-1/rewards/megapot-pool",
        );
        return {
          status: response.status,
          body: (await response.json()) as unknown,
          reached: { ...reached, fetches: fetches.length },
        };
      };
      const pilot = {
        SAFE_POOL_PILOT_ENABLED: "true",
        SAFE_POOL_RPC_URL: "https://base-rpc.test",
      };
      const unavailable = { status: 502, body: { error: { code: "provider_unavailable" } } };
      // A refused request built no handler or RPC client and made no outbound request.
      const refused = { ...unavailable, reached: { handlers: 0, rpcClients: 0, fetches: 0 } };
      const served = { status: 200, body: { pool: null }, reached: { handlers: 1, rpcClients: 1 } };

      // Neither reward lane: the routes stay mounted and unavailable.
      expect(await pool({})).toMatchObject(unavailable);
      // A staging worker serves its own staging Safe and never a production one.
      expect(await pool({ ...pilot, SAFE_POOL_ATTESTATION_ID: "staging-safe" })).toMatchObject(
        served,
      );
      expect(await pool({ ...pilot, SAFE_POOL_ATTESTATION_ID: "missing" })).toMatchObject(
        unavailable,
      );
      expect(await pool({ ...pilot, SAFE_POOL_ATTESTATION_ID: "production-safe" })).toMatchObject(
        refused,
      );
      // The production switch is refused outside production.
      await expect(
        pool({
          ...pilot,
          SAFE_POOL_ATTESTATION_ID: "production-safe",
          SAFE_POOL_PRODUCTION_ENABLED: "true",
        }),
      ).rejects.toThrow("HTTP worker configuration is incomplete or invalid");
      // A production worker serves a production Safe only behind its switch, and never
      // a staging rehearsal, switch or not.
      const production = { ...pilot, API_NEXT_ENV: "production", MEGAPOT_CHAIN_ID: "8453" };
      for (const overrides of [
        { SAFE_POOL_ATTESTATION_ID: "production-safe" },
        { SAFE_POOL_ATTESTATION_ID: "staging-safe" },
        { SAFE_POOL_ATTESTATION_ID: "staging-safe", SAFE_POOL_PRODUCTION_ENABLED: "true" },
      ]) {
        expect(await pool({ ...production, ...overrides })).toMatchObject(refused);
      }
      expect(
        await pool({
          ...production,
          SAFE_POOL_ATTESTATION_ID: "production-safe",
          SAFE_POOL_PRODUCTION_ENABLED: "true",
        }),
      ).toMatchObject(served);
    } finally {
      globalThis.fetch = original;
      await admin.end();
      await control.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      await control.end();
    }
  }, 120000);
});
