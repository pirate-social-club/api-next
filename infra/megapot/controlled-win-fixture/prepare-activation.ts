/** Read-only preflight and local config copies for the isolated reward run. */
import { readFile, writeFile } from "node:fs/promises";
import pg from "pg";
import { createPublicClient, getAddress, http, parseAbi } from "viem";
import { baseSepolia } from "viem/chains";

const dir = "/tmp/megapot-e2e-config-20260926";
const attestationId = "megapot-e2e-sepolia-20260926-r1";
const jackpot = getAddress("0xb9464401103143e916434A277064f5601f3D7708");
const custody = getAddress("0x544881290138fe0E66C1EC7D1A1f141395246f20");
const gas = getAddress("0x85ea2BCe79F4Cf8489457577Ce75f98c47C90c6A");
const usdc = getAddress("0x036cbd53842c5426634e7929541eC2318f3dCF7e");
const hyperdrive = "cf1afd643ad7469fba79694ccac74df3";
const abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const rpcUrl = process.env.MEGAPOT_V2_RPC_URL;
const adminUrl = process.env.MEGAPOT_E2E_ADMIN_POSTGRES_URL;
if (!rpcUrl?.startsWith("https://") || !adminUrl ||
    !new URL(adminUrl).username.startsWith("pscale_api_i6jmpxeg4gvr.5ufdugrgjptk")) {
  throw new Error("isolated RPC and branch-pinned admin URL required");
}
const rpc = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
const [chain, prize, custodyEth, gasEth] = await Promise.all([
  rpc.getChainId(),
  rpc.readContract({ address: usdc, abi, functionName: "balanceOf", args: [jackpot] }),
  rpc.getBalance({ address: custody }), rpc.getBalance({ address: gas }),
]);
if (chain !== baseSepolia.id || prize !== 1_000_000n ||
    custodyEth < 2_000_000_000_000_000n || gasEth < 5_000_000_000_000_000n) {
  throw new Error(JSON.stringify({ reason: "chain or float preflight failed",
    chain, prizeAtomic: prize.toString(), custodyEthWei: custodyEth.toString(),
    gasEthWei: gasEth.toString() }));
}
const db = new pg.Client({ connectionString: adminUrl });
await db.connect();
try {
  await db.query("SET search_path TO api_next,public");
  const result = await db.query<{ attestation_id: string; jackpot_address: string;
    custody_address: string }>(
    "SELECT attestation_id,jackpot_address,custody_address FROM megapot_deployment_attestations WHERE environment='staging' AND status='active'",
  );
  if (result.rows.length !== 1 || result.rows[0]?.attestation_id !== attestationId ||
      getAddress(result.rows[0].jackpot_address) !== jackpot ||
      getAddress(result.rows[0].custody_address) !== custody) {
    throw new Error("isolated database has wrong active attestation");
  }
  const open = await db.query<{ open_offers: string }>(
    "SELECT count(*)::text AS open_offers FROM song_reward_offers WHERE status IN ('draft','active','paused','operational_hold')",
  );
  if (open.rows[0]?.open_offers !== "0") throw new Error("an offer is already open");
} finally {
  await db.end();
}
for (const kind of ["http", "jobs"] as const) {
  const source = JSON.parse(await readFile(`${dir}/${kind}.json`, "utf8")) as {
    name: string; vars: Record<string, string>;
    hyperdrive: { binding: string; id: string }[];
    secrets: { required: string[] };
  };
  if (source.name !== `pirate-${kind === "http" ? "http" : "jobs"}-worker-megapot-e2e-staging` ||
      source.hyperdrive.length !== 1 || source.hyperdrive[0]?.id !== hyperdrive ||
      source.vars.MEGAPOT_ATTESTATION_ID !== attestationId ||
      source.vars.MEGAPOT_REWARDS_ENABLED !== "false") {
    throw new Error(`${kind} source config drifted`);
  }
  if (kind === "http" && (source.vars.MEGAPOT_GAS_TOPUP_TARGET_WEI !== "50000000000000" ||
      source.vars.MEGAPOT_GAS_TOPUP_MAX_WEI !== "50000000000000" ||
      source.vars.MEGAPOT_GAS_TOPUP_ACCOUNT_DAILY_COUNT !== "3" ||
      source.vars.MEGAPOT_GAS_TOPUP_PLATFORM_DAILY_WEI !== "100000000000000")) {
    throw new Error("isolated HTTP gas caps drifted");
  }
  if (kind === "jobs" && !source.secrets.required.includes("MEGAPOT_GAS_TOPUP_PRIVATE_KEY")) {
    throw new Error("isolated jobs gas key is not required");
  }
  const active = structuredClone(source);
  active.vars.MEGAPOT_REWARDS_ENABLED = "true";
  await writeFile(`${dir}/${kind}-active.json`, `${JSON.stringify(active, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ kind, activeConfig: `${dir}/${kind}-active.json`,
    soleChangedField: "vars.MEGAPOT_REWARDS_ENABLED", from: "false", to: "true",
    attestationId, hyperdrive, secretNames: source.secrets.required }));
}
console.log(JSON.stringify({ action: "prepared", prizeAtomic: prize.toString(),
  custodyEthWei: custodyEth.toString(), gasEthWei: gasEth.toString() }));
