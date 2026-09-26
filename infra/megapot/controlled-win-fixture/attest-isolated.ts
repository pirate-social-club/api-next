/** Rotate only the copied database's terminal public attestation to the fixture. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { type Abi, createPublicClient, getAddress, http, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const attestationId = "megapot-e2e-sepolia-20260926-r1";
const oldAttestationId = "megapot-base-sepolia-v2";
const deploymentPath = "/tmp/megapot-e2e-config-20260926/deployment.json";
const expectedOperator = getAddress("0x8fB9941a4782E4fc05467f9A3138c66C7F2aaCaF");
const expectedCustody = getAddress("0x544881290138fe0E66C1EC7D1A1f141395246f20");
const expectedJackpot = getAddress("0xb9464401103143e916434A277064f5601f3D7708");
const expectedUsdc = getAddress("0x036cbd53842c5426634e7929541ec2318f3dcf7e");
const expectedUsdcCodeHash = "0xedc5281a85c0efecd49999a1ef668390c59b88702f2d4a07029d7f5d63059d6c";
const artifactBytes = await readFile(resolve(import.meta.dir,
  "out/ControlledMegapot.sol/ControlledMegapot.json"));
const artifact = JSON.parse(artifactBytes.toString("utf8")) as { abi: Abi };
const sourceTag = `0x${createHash("sha256")
  .update(await readFile(resolve(import.meta.dir, "src/ControlledMegapot.sol")))
  .digest("hex")}`;

if (Bun.argv.slice(2).some((arg) => arg !== "--execute")) throw new Error("unknown option");
const execute = Bun.argv.includes("--execute");
const adminUrl = process.env.MEGAPOT_E2E_ADMIN_POSTGRES_URL;
const rpcUrl = process.env.MEGAPOT_V2_RPC_URL;
const custodyKey = process.env.MEGAPOT_E2E_CUSTODY_PRIVATE_KEY;
if (!adminUrl || !rpcUrl?.startsWith("https://") ||
    !/^0x[0-9a-fA-F]{64}$/u.test(custodyKey ?? "")) {
  throw new Error("isolated admin URL, HTTPS RPC and custody key are required");
}
const admin = new URL(adminUrl);
if (!admin.username.startsWith("pscale_api_i6jmpxeg4gvr.5ufdugrgjptk")) {
  throw new Error("admin URL is not for the isolated branch");
}
if (privateKeyToAccount(custodyKey as `0x${string}`).address !== expectedCustody) {
  throw new Error("custody key does not match isolated wallet");
}
const deployment = JSON.parse(await readFile(deploymentPath, "utf8")) as {
  predictedAddress: string;
  ticketNftAddress: string;
  jackpotCodeHash: string;
  ticketNftCodeHash: string;
  usdcCodeHash: string;
  artifactSha256: string;
  transactionHash: `0x${string}`;
  receiptBlockNumber: string;
};
const jackpot = getAddress(deployment.predictedAddress);
const ticketNft = getAddress(deployment.ticketNftAddress);
if (jackpot !== expectedJackpot || deployment.usdcCodeHash !== expectedUsdcCodeHash ||
    deployment.artifactSha256 !== createHash("sha256").update(artifactBytes).digest("hex")) {
  throw new Error("deployment record does not match approved source and address");
}
const rpc = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
if (await rpc.getChainId() !== baseSepolia.id) throw new Error("wrong chain");
const head = await rpc.getBlockNumber();
const anchorNumber = head - 3n;
const receipt = await rpc.getTransactionReceipt({ hash: deployment.transactionHash });
if (receipt.status !== "success" || !receipt.contractAddress ||
    getAddress(receipt.contractAddress) !== jackpot ||
    receipt.blockNumber.toString() !== deployment.receiptBlockNumber) {
  throw new Error("deployment receipt does not match the approved contract");
}
if (anchorNumber < BigInt(deployment.receiptBlockNumber)) {
  throw new Error("deployment lacks three confirmations");
}
const [jackpotCode, nftCode, usdcCode, linkedNft, linkedUsdc, linkedOperator, price, anchor] =
  await Promise.all([
    rpc.getCode({ address: jackpot }),
    rpc.getCode({ address: ticketNft }),
    rpc.getCode({ address: expectedUsdc }),
    rpc.readContract({ address: jackpot, abi: artifact.abi, functionName: "jackpotNFT" }),
    rpc.readContract({ address: jackpot, abi: artifact.abi, functionName: "usdc" }),
    rpc.readContract({ address: jackpot, abi: artifact.abi, functionName: "operator" }),
    rpc.readContract({ address: jackpot, abi: artifact.abi, functionName: "ticketPrice" }),
    rpc.getBlock({ blockNumber: anchorNumber }),
  ]);
if (!jackpotCode || !nftCode || !usdcCode ||
    keccak256(jackpotCode) !== deployment.jackpotCodeHash ||
    keccak256(nftCode) !== deployment.ticketNftCodeHash ||
    keccak256(usdcCode) !== expectedUsdcCodeHash ||
    typeof linkedNft !== "string" || getAddress(linkedNft) !== ticketNft ||
    typeof linkedUsdc !== "string" || getAddress(linkedUsdc) !== expectedUsdc ||
    typeof linkedOperator !== "string" || getAddress(linkedOperator) !== expectedOperator ||
    price !== 10_000n || !anchor.hash) {
  throw new Error("deployed contract does not match fixture authority");
}

const db = new pg.Client({ connectionString: adminUrl });
await db.connect();
try {
  await db.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  await db.query("SET LOCAL search_path TO api_next,public");
  const authority = await db.query<{ attestation_id: string; status: string }>(
    "SELECT attestation_id,status FROM megapot_deployment_attestations WHERE environment='staging' AND status='active' FOR UPDATE",
  );
  if (authority.rows.length !== 1 || authority.rows[0]?.attestation_id !== oldAttestationId) {
    throw new Error("copied active attestation is not the expected public row");
  }
  const obligations = await db.query<{ kind: string; count: string }>(`
    SELECT 'credits' kind,count(*)::text FROM reward_ledger_credits
    UNION ALL SELECT 'open_offers',count(*)::text FROM song_reward_offers
      WHERE status IN ('draft','active','paused','operational_hold')
    UNION ALL SELECT 'open_legs',count(*)::text FROM song_reward_offer_legs
      WHERE status IN ('draft','funding','active','paused','operational_hold')
    UNION ALL SELECT 'open_tickets',count(*)::text FROM megapot_ticket_inventory
      WHERE status IN ('custodied','claim_pending')
    UNION ALL SELECT 'open_effects',count(*)::text FROM reward_chain_effects
      WHERE state NOT IN ('confirmed','reverted','replaced','reclaimable_failed','terminal_failed')
    UNION ALL SELECT 'open_refunds',count(*)::text FROM reward_refund_effects r
      JOIN reward_chain_effects e ON e.effect_id=r.refund_effect_id
      WHERE e.state <> 'confirmed'
  `);
  if (obligations.rows.some((row) => row.count !== "0")) {
    throw new Error(`copied branch has obligations: ${JSON.stringify(obligations.rows)}`);
  }
  const asset = await db.query("SELECT 1 FROM reward_asset_whitelist WHERE chain_id=84532 AND token_address=$1 AND status='active' AND decimals=6 AND asset_kind='settlement_usdc'", [expectedUsdc.toLowerCase()]);
  if (asset.rowCount !== 1) throw new Error("canonical test USDC is not active");
  const prior = await db.query("SELECT 1 FROM megapot_deployment_attestations WHERE attestation_id=$1", [attestationId]);
  if (prior.rowCount !== 0) throw new Error("fixture attestation ID already exists");
  const plan = {
    action: execute ? "execute" : "dry-run", attestationId, retires: oldAttestationId,
    jackpot, ticketNft, usdc: expectedUsdc, custody: expectedCustody,
    referrer: expectedOperator, sourceTag, anchorNumber: anchor.number.toString(),
    anchorHash: anchor.hash, obligations: obligations.rows,
  };
  console.log(JSON.stringify(plan));
  if (execute) {
    const verifiedAt = new Date(Number(anchor.timestamp) * 1000).toISOString();
    await db.query("UPDATE megapot_deployment_attestations SET status='retired',retired_at=clock_timestamp() WHERE attestation_id=$1 AND status='active'", [oldAttestationId]);
    await db.query(`INSERT INTO megapot_deployment_attestations (
      attestation_id,environment,chain_id,jackpot_address,usdc_address,ticket_nft_address,
      custody_address,referrer_address,source_tag,jackpot_code_hash,usdc_code_hash,
      ticket_nft_code_hash,attestation_block_number,attestation_block_hash,abi_version,
      status,verified_at
    ) VALUES ($1,'staging',84532,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'megapot_v2','active',$13)`,
    [attestationId,jackpot.toLowerCase(),expectedUsdc.toLowerCase(),ticketNft.toLowerCase(),
      expectedCustody.toLowerCase(),expectedOperator.toLowerCase(),sourceTag,
      deployment.jackpotCodeHash,expectedUsdcCodeHash,deployment.ticketNftCodeHash,
      anchor.number.toString(),anchor.hash,verifiedAt]);
    const readback = await db.query<{ attestation_id: string }>(
      "SELECT attestation_id FROM megapot_deployment_attestations WHERE environment='staging' AND status='active'",
    );
    if (readback.rows.length !== 1 || readback.rows[0]?.attestation_id !== attestationId) {
      throw new Error("attestation readback failed");
    }
    await db.query("COMMIT");
    console.log(JSON.stringify({ action: "attested", attestationId, jackpot, anchorNumber: anchor.number.toString() }));
  } else {
    await db.query("ROLLBACK");
  }
} catch (error) {
  await db.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await db.end();
}
