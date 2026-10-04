import { createHash } from "node:crypto";
import { Client } from "pg";
import { createPublicClient, http, keccak256 } from "viem";
import { baseSepolia } from "viem/chains";
import { normalizePostgresConnectionString } from "../postgres-connection-string.ts";
import { validateIsolatedDatabaseIdentity } from "./bootstrap-database.ts";

export async function installFixtureAuthority(connectionString, identity, manifest) {
  validateIsolatedDatabaseIdentity(connectionString, identity);
  if (
    identity.branchId !== "l8mhyb0fxy54" ||
    identity.branchName !== "rewards-runner-20261004" ||
    manifest.environment !== "test" ||
    manifest.chain_id !== 84532 ||
    manifest.attestation_id !== "megapot-e2e-sepolia-20261004-r2" ||
    manifest.jackpot_address !== "0xf856b59a9a9a5397aba89c647742b2a69d03d3c8" ||
    manifest.usdc_address !== "0x036cbd53842c5426634e7929541ec2318f3dcf7e" ||
    manifest.custody_address !== "0x544881290138fe0e66c1ec7d1a1f141395246f20"
  )
    throw Error("Isolated fixture authority identity differs");
  const chain = createPublicClient({
    chain: baseSepolia,
    transport: http("https://base-sepolia-rpc.publicnode.com", { retryCount: 0, timeout: 20000 }),
  });
  if ((await chain.getChainId()) !== 84532) throw Error("Wrong fixture chain");
  const block = await chain.getBlock({ blockNumber: BigInt(manifest.attestation_block_number) });
  const head = await chain.getBlockNumber();
  if (block.hash !== manifest.attestation_block_hash || head - block.number < 3n)
    throw Error("Fixture anchor is not canonical");
  for (const [address, key] of [
    [manifest.jackpot_address, "jackpot_code_hash"],
    [manifest.usdc_address, "usdc_code_hash"],
    [manifest.ticket_nft_address, "ticket_nft_code_hash"],
  ]) {
    const code = await chain.getCode({ address });
    if (!code || code === "0x" || keccak256(code) !== manifest[key])
      throw Error("Fixture contract code differs");
  }
  const db = new Client({
    connectionString: normalizePostgresConnectionString(connectionString),
    connectionTimeoutMillis: 20000,
  });
  await db.connect();
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL search_path TO api_next, public");
    try {
      const receipt = await db.query(
        `SELECT finished FROM rewards_bootstrap_${identity.branchId}.receipt WHERE branch_id=$1`,
        [identity.branchId],
      );
      const control = await db.query(
        "SELECT paused FROM api_next.reward_operations_control WHERE singleton",
      );
      if (
        receipt.rows.length !== 1 ||
        receipt.rows[0].finished !== true ||
        control.rows.length !== 1 ||
        control.rows[0].paused !== true
      )
        throw Error("Completed paused isolated bootstrap required");
      await db.query(
        `INSERT INTO api_next.reward_asset_whitelist (chain_id,token_address,decimals,symbol,asset_kind,environment,status,policy_version,activated_at,plain_erc20_verified_at) VALUES ($1,$2,6,'USDC','settlement_usdc','test','active','megapot-settlement-usdc-v1',$3,$3) ON CONFLICT (chain_id,token_address) DO NOTHING`,
        [84532, manifest.usdc_address, manifest.verified_at],
      );
      const fields = [
        "attestation_id",
        "environment",
        "chain_id",
        "jackpot_address",
        "usdc_address",
        "ticket_nft_address",
        "custody_address",
        "referrer_address",
        "source_tag",
        "jackpot_code_hash",
        "usdc_code_hash",
        "ticket_nft_code_hash",
        "attestation_block_number",
        "attestation_block_hash",
        "abi_version",
        "verified_at",
      ];
      await db.query(
        `INSERT INTO api_next.megapot_deployment_attestations (${fields.join(",")},status) VALUES (${fields.map((_, i) => "$" + (i + 1)).join(",")},'active') ON CONFLICT (attestation_id) DO NOTHING`,
        fields.map((field) => manifest[field]),
      );
      const attestation = (
        await db.query(
          "SELECT * FROM api_next.megapot_deployment_attestations WHERE attestation_id=$1",
          [manifest.attestation_id],
        )
      ).rows;
      if (
        attestation.length !== 1 ||
        attestation[0].status !== "active" ||
        fields.some(
          (field) =>
            field !== "verified_at" && String(attestation[0][field]) !== String(manifest[field]),
        )
      )
        throw Error("Existing isolated authority differs");
      const asset = (
        await db.query(
          "SELECT environment,status,decimals,asset_kind FROM api_next.reward_asset_whitelist WHERE chain_id=84532 AND token_address=$1",
          [manifest.usdc_address],
        )
      ).rows;
      if (
        asset.length !== 1 ||
        asset[0].environment !== "test" ||
        asset[0].status !== "active" ||
        asset[0].decimals !== 6 ||
        asset[0].asset_kind !== "settlement_usdc"
      )
        throw Error("Existing isolated asset differs");
      await db.query("COMMIT");
      return {
        attestationId: manifest.attestation_id,
        environment: "test",
        chainId: 84532,
        manifestSha256: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
        canonicalAnchor: manifest.attestation_block_hash,
        simulatedClaimVerification: true,
      };
    } catch (error) {
      await db.query("ROLLBACK").catch(() => {});
      throw error;
    }
  } finally {
    await db.end();
  }
}
