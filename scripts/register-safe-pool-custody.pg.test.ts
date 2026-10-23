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

const stagingManifest = JSON.parse(
  await readFile(
    new URL("../infra/megapot/base-sepolia-v2-safe-pilot.json", import.meta.url),
    "utf8",
  ),
);

describe("Safe pool custody manifests", () => {
  test("match the fork evidence on Base and the Base Sepolia deployment manifest", async () => {
    const evidence = JSON.parse(
      await readFile(
        new URL("../infra/megapot/safe-pilot/fork-evidence.json", import.meta.url),
        "utf8",
      ),
    ).contracts;
    expect(manifest).toMatchObject({
      environment: "production",
      chain_id: 8453,
      jackpot_address: evidence.jackpot.address.toLowerCase(),
      jackpot_code_hash: evidence.jackpot.codeHash,
      usdc_address: evidence.usdc.address.toLowerCase(),
      usdc_code_hash: evidence.usdc.codeHash,
      ticket_nft_address: evidence.nft.address.toLowerCase(),
      ticket_nft_code_hash: evidence.nft.codeHash,
      safe_singleton_address: evidence.safe.address.toLowerCase(),
    });
    const sepolia = JSON.parse(
      await readFile(new URL("../infra/megapot/base-sepolia-v2.json", import.meta.url), "utf8"),
    );
    expect(stagingManifest).toMatchObject({
      environment: "staging",
      chain_id: 84532,
      jackpot_address: sepolia.jackpot_address,
      jackpot_code_hash: sepolia.jackpot_code_hash,
      usdc_address: sepolia.usdc_address,
      usdc_code_hash: sepolia.usdc_code_hash,
      ticket_nft_address: sepolia.ticket_nft_address,
      ticket_nft_code_hash: sepolia.ticket_nft_code_hash,
      // The same Safe 1.4.1 singleton address and code are deployed on Base Sepolia.
      safe_singleton_address: manifest.safe_singleton_address,
    });
  });
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

  test("records a staging rehearsal custody on Base Sepolia", async () => {
    const layer = makeDirectPostgresControlPlaneLayer(scoped);
    const plan = await inspectSafePoolCustody({
      manifest: stagingManifest,
      rpc,
      safe: reader(stagingManifest.safe_singleton_address),
      safeAddress: OTHER_SAFE,
      referrerAddress: REFERRER,
      sourceTag: SOURCE,
      requiredConfirmations: 3,
    });
    await persistSafePoolCustody(layer, plan);
    expect(
      (
        await admin.query(
          `SELECT attestation.environment, attestation.chain_id::int AS chain_id,
                  signer.nonce_authority
             FROM megapot_deployment_attestations attestation
             JOIN reward_signer_nonces signer
               ON signer.chain_id=attestation.chain_id
              AND signer.signer_address=attestation.custody_address
            WHERE attestation.attestation_id=$1`,
          [stagingManifest.attestation_id],
        )
      ).rows,
    ).toEqual([{ environment: "staging", chain_id: 84532, nonce_authority: "safe_owner_v1" }]);
  });
});
