/** Guarded Base Sepolia fixture deployment. Dry-run unless --execute is set. */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  getAddress,
  getContractAddress,
  http,
  keccak256,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const usdc = getAddress("0x036cbd53842c5426634e7929541ec2318f3dcf7e");
const usdcCodeHash = "0xedc5281a85c0efecd49999a1ef668390c59b88702f2d4a07029d7f5d63059d6c";
const operator = getAddress("0x8fB9941a4782E4fc05467f9A3138c66C7F2aaCaF");
const ticketPriceAtomic = 10_000n;
const maxGas = 2_100_000n;
const maxDeploymentCostWei = 300_000_000_000_000n;
const minOperatorBalanceWei = 1_500_000_000_000_000n;
const confirmations = 3;
const recordRoot = process.env.E2E_GUARD_RECORD_DIR;
if (!recordRoot || !isAbsolute(recordRoot) || recordRoot.startsWith("/tmp/")) {
  throw new Error("E2E_GUARD_RECORD_DIR must be a durable absolute path");
}

if (Bun.argv.slice(2).some((arg) => arg !== "--execute")) throw new Error("unknown option");
const execute = Bun.argv.includes("--execute");
const key = process.env.MEGAPOT_E2E_OPERATOR_PRIVATE_KEY;
const rpcUrl = process.env.MEGAPOT_V2_RPC_URL;
if (!/^0x[0-9a-fA-F]{64}$/u.test(key ?? "") || !rpcUrl?.startsWith("https://")) {
  throw new Error("operator key and HTTPS RPC are required");
}
const account = privateKeyToAccount(key as `0x${string}`);
if (account.address !== operator) throw new Error("operator key does not match isolated wallet");
const client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
if (await client.getChainId() !== baseSepolia.id) throw new Error("wrong chain");
const tokenCode = await client.getCode({ address: usdc });
if (!tokenCode || keccak256(tokenCode) !== usdcCodeHash) throw new Error("USDC code hash drifted");
const [nonce, pending] = await Promise.all([
  client.getTransactionCount({ address: operator, blockTag: "latest" }),
  client.getTransactionCount({ address: operator, blockTag: "pending" }),
]);
if (pending !== nonce) throw new Error("operator has a pending transaction");
const predictedAddress = getContractAddress({ from: operator, nonce: BigInt(nonce) });
if (await client.getCode({ address: predictedAddress }) !== undefined) {
  throw new Error("predicted fixture address is already occupied");
}
const recordPath = `${recordRoot}/deployment-${predictedAddress.toLowerCase()}.json`;
const artifactBytes = await readFile(resolve(import.meta.dir,
  "out/ControlledMegapot.sol/ControlledMegapot.json"));
const artifact = JSON.parse(artifactBytes.toString("utf8")) as {
  abi: Parameters<typeof encodeDeployData>[0]["abi"];
  bytecode: { object: `0x${string}` };
};
const args = [usdc, operator, ticketPriceAtomic] as const;
const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args });
const [gasEstimate, fees, balance, block] = await Promise.all([
  client.estimateGas({ account: operator, data }),
  client.estimateFeesPerGas(),
  client.getBalance({ address: operator }),
  client.getBlock(),
]);
const gasLimit = gasEstimate + gasEstimate / 4n;
const maxFeePerGas = fees.maxFeePerGas;
const maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
const maxCostWei = maxFeePerGas ? gasLimit * maxFeePerGas : null;
const plan = {
  chainId: baseSepolia.id,
  operator,
  predictedAddress,
  operatorNonce: nonce,
  artifactSha256: createHash("sha256").update(artifactBytes).digest("hex"),
  usdc,
  usdcCodeHash,
  ticketPriceAtomic: ticketPriceAtomic.toString(),
  blockNumber: block.number.toString(),
  blockHash: block.hash,
  gasEstimate: gasEstimate.toString(),
  gasLimit: gasLimit.toString(),
  maxFeePerGasWei: maxFeePerGas?.toString() ?? null,
  maxCostWei: maxCostWei?.toString() ?? null,
  hardCostCapWei: maxDeploymentCostWei.toString(),
  gasWithinCap: maxPriorityFeePerGas !== undefined && gasLimit <= maxGas &&
    maxCostWei !== null && maxCostWei <= maxDeploymentCostWei,
  operatorBalanceWei: balance.toString(),
  fundingReady: balance >= minOperatorBalanceWei,
};
console.log(JSON.stringify({ action: execute ? "execute" : "dry-run", ...plan }));
if (!maxFeePerGas || !maxPriorityFeePerGas || !plan.gasWithinCap) {
  throw new Error("deployment fee exceeds fixed cap");
}
if (!execute) process.exit(0);
if (process.env.E2E_APPROVED_DEPLOYMENT_ADDRESS !== predictedAddress) {
  throw new Error("exact predicted address has not been approved");
}
if (balance < minOperatorBalanceWei) throw new Error("operator ETH float is insufficient");
try {
  await readFile(recordPath);
  throw new Error("deployment record already exists");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) });
const hash = await wallet.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode.object,
  args,
  gas: gasLimit,
  maxFeePerGas,
  maxPriorityFeePerGas,
});
const receipt = await client.waitForTransactionReceipt({ hash, confirmations });
if (receipt.status !== "success" ||
    !receipt.contractAddress || getAddress(receipt.contractAddress) !== predictedAddress) {
  throw new Error("deployment receipt did not match the approved address");
}
const jackpotCode = await client.getCode({ address: predictedAddress });
if (!jackpotCode) throw new Error("jackpot bytecode missing after deployment");
const ticketNft = await client.readContract({
  address: predictedAddress,
  abi: artifact.abi,
  functionName: "jackpotNFT",
});
if (typeof ticketNft !== "string") throw new Error("ticket NFT address missing");
const nftAddress = getAddress(ticketNft);
const nftCode = await client.getCode({ address: nftAddress });
if (!nftCode) throw new Error("ticket NFT bytecode missing");
await writeFile(recordPath, `${JSON.stringify({
  ...plan,
  transactionHash: hash,
  receiptBlockNumber: receipt.blockNumber.toString(),
  receiptBlockHash: receipt.blockHash,
  jackpotCodeHash: keccak256(jackpotCode),
  ticketNftAddress: nftAddress,
  ticketNftCodeHash: keccak256(nftCode),
})}\n`, { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ action: "deployed", contract: predictedAddress, hash,
  ticketNft: nftAddress, receiptBlockNumber: receipt.blockNumber.toString() }));
