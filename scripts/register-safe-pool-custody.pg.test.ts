import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { makeDirectPostgresControlPlaneLayer } from "../packages/platform-cf/src/postgres.ts";
import {
  inspectSafePoolCustody,
  persistSafePoolCustody,
  type SafeCustodyReader,
} from "./register-safe-pool-custody.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
}
const suite = url ? describe : describe.skip;
const SAFE = `0x${"5".repeat(40)}`;
const OTHER_SAFE = `0x${"7".repeat(40)}`;
const REFERRER = `0x${"6".repeat(40)}`;
const SOURCE = `0x${"8".repeat(64)}`;

const manifest = JSON.parse(
  await readFile(new URL("../infra/megapot/base-v2-safe-pilot.json", import.meta.url), "utf8"),
);
const rpc = {
  attestDeployment: async () => ({
    jackpotCodeHash: manifest.jackpot_code_hash,
    ticketNftCodeHash: manifest.ticket_nft_code_hash,
    usdcCodeHash: manifest.usdc_code_hash,
  }),
  readHead: async () => ({ blockNumber: 1_000n, blockHash: `0x${"1".repeat(64)}` }),
  readBlock: async (blockNumber: bigint) => ({
    blockNumber,
    blockHash: `0x${"2".repeat(64)}`,
    blockTimestamp: 1_792_000_000n,
  }),
};
const reader = (singleton: string): SafeCustodyReader => ({
  readSingleton: async () => singleton,
  readVersion: async () => "1.4.1",
  readOwners: async () => [`0x${"9".repeat(40)}`, `0x${"a".repeat(40)}`],
  readThreshold: async () => 2n,
  readNonce: async () => 4n,
});
const inspect = (safeAddress: string, singleton = manifest.safe_singleton_address) =>
  inspectSafePoolCustody({
    manifest,
    rpc,
    safe: reader(singleton),
    safeAddress,
    referrerAddress: REFERRER,
    sourceTag: SOURCE,
    requiredConfirmations: 3,
  });

describe("Safe pool custody inspection", () => {
  test("refuses an address that is not a Safe on the pinned singleton", async () => {
    await expect(inspect(SAFE, `0x${"3".repeat(40)}`)).rejects.toThrow("not a Safe 1.4.1 proxy");
  });
});

suite("Safe pool custody registration", () => {
  const schema = `safe_pool_custody_${process.pid}_${Date.now()}`;
  const admin = new Client({ connectionString: url });
  const scoped = `${url}${url?.includes("?") ? "&" : "?"}options=${encodeURIComponent(
    `-c search_path=${schema}`,
  )}`;

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    await admin.query(await Bun.file(new URL("../db/postgres/schema.sql", import.meta.url)).text());
    await admin.query(`SET search_path TO "${schema}"`);
    await admin.query("SELECT set_reward_operations_paused_v1(0,FALSE,'safe_custody_test')");
  });

  afterAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  test("records the asset, attestation and Safe authority once, and refuses a different Safe", async () => {
    const layer = makeDirectPostgresControlPlaneLayer(scoped);
    const plan = await inspect(SAFE);
    expect(plan).toMatchObject({ safeAddress: SAFE, threshold: "2", safeNonce: 4n });
    await persistSafePoolCustody(layer, plan);
    await persistSafePoolCustody(layer, plan);
    expect(
      (
        await admin.query(
          `SELECT attestation.custody_address, attestation.environment,
                  signer.nonce_authority, signer.next_nonce::text AS next_nonce,
                  (SELECT count(*)::int FROM reward_asset_whitelist
                    WHERE environment='production') AS assets
             FROM megapot_deployment_attestations attestation
             JOIN reward_signer_nonces signer
               ON signer.chain_id=attestation.chain_id
              AND signer.signer_address=attestation.custody_address
            WHERE attestation.attestation_id=$1`,
          [manifest.attestation_id],
        )
      ).rows,
    ).toEqual([
      {
        custody_address: SAFE,
        environment: "production",
        nonce_authority: "safe_owner_v1",
        next_nonce: "4",
        assets: 1,
      },
    ]);
    await expect(persistSafePoolCustody(layer, await inspect(OTHER_SAFE))).rejects.toThrow(
      "does not match this Safe",
    );
  });
});
