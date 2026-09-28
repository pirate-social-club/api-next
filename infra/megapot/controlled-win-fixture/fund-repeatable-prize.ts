/** Put exactly one test USDC into the new isolated fixture jackpot. */
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  createPublicClient, createWalletClient, getAddress, http, keccak256, parseAbi,
  parseEventLogs,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const jackpot = getAddress("0xF856B59a9a9a5397aBa89c647742B2a69D03d3c8");
const operator = getAddress("0x8fB9941a4782E4fc05467f9A3138c66C7F2aaCaF");
const usdc = getAddress("0x036cbd53842c5426634e7929541eC2318f3dCF7e");
const amount = 1_000_000n;
const maxCostWei = 100_000_000_000_000n;
const recordRoot = process.env.E2E_GUARD_RECORD_DIR;
if (!recordRoot || !isAbsolute(recordRoot) || recordRoot.startsWith("/tmp/")) {
  throw new Error("durable E2E_GUARD_RECORD_DIR is required");
}
const recordPath = `${recordRoot}/fixture-r2-funding.json`;
const abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
if (Bun.argv.slice(2).some((arg) => arg !== "--execute")) throw new Error("unknown option");
const execute = Bun.argv.includes("--execute");
const key = process.env.MEGAPOT_E2E_OPERATOR_PRIVATE_KEY;
const rpcUrl = process.env.MEGAPOT_V2_RPC_URL;
if (!/^0x[0-9a-fA-F]{64}$/u.test(key ?? "") || !rpcUrl?.startsWith("https://")) {
  throw new Error("isolated operator key and HTTPS RPC are required");
}
const account = privateKeyToAccount(key as `0x${string}`);
if (account.address !== operator) throw new Error("operator key mismatch");
const deployment = JSON.parse(await readFile(
  `${recordRoot}/deployment-${jackpot.toLowerCase()}.json`, "utf8")) as {
    predictedAddress: string; transactionHash: `0x${string}`;
    jackpotCodeHash: string; usdcCodeHash: string;
  };
if (getAddress(deployment.predictedAddress) !== jackpot) {
  throw new Error("deployment record does not match approved jackpot");
}
const rpc = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
if (await rpc.getChainId() !== baseSepolia.id) throw new Error("wrong chain");
const [deploymentReceipt, jackpotCode, usdcCode, operatorBalance, jackpotBalance,
  latest, pending, fees, ethBalance] =
  await Promise.all([
    rpc.getTransactionReceipt({ hash: deployment.transactionHash }),
    rpc.getCode({ address: jackpot }),
    rpc.getCode({ address: usdc }),
    rpc.readContract({ address: usdc, abi, functionName: "balanceOf", args: [operator] }),
    rpc.readContract({ address: usdc, abi, functionName: "balanceOf", args: [jackpot] }),
    rpc.getTransactionCount({ address: operator, blockTag: "latest" }),
    rpc.getTransactionCount({ address: operator, blockTag: "pending" }),
    rpc.estimateFeesPerGas(), rpc.getBalance({ address: operator }),
  ]);
if (deploymentReceipt.status !== "success" ||
    getAddress(deploymentReceipt.contractAddress ?? "0x0000000000000000000000000000000000000000") !== jackpot ||
    !jackpotCode || keccak256(jackpotCode) !== deployment.jackpotCodeHash ||
    !usdcCode || keccak256(usdcCode) !== deployment.usdcCodeHash ||
    operatorBalance < amount || jackpotBalance !== 0n || pending !== latest) {
  throw new Error("fixture funding preconditions failed");
}
const gasEstimate = await rpc.estimateContractGas({ address: usdc, abi,
  functionName: "transfer", args: [jackpot, amount], account: operator });
const gasLimit = gasEstimate + gasEstimate / 4n;
const maxFeePerGas = fees.maxFeePerGas;
const maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
if (!maxFeePerGas || !maxPriorityFeePerGas || gasLimit > 100_000n ||
    gasLimit * maxFeePerGas > maxCostWei || ethBalance < gasLimit * maxFeePerGas) {
  throw new Error("fixture funding gas cap or operator ETH balance failed");
}
const plan = { action: execute ? "execute" : "dry-run", from: operator,
  to: jackpot, token: usdc, amountAtomic: amount.toString(), nonce: latest,
  operatorBalanceBefore: operatorBalance.toString(),
  gasEstimate: gasEstimate.toString(), gasLimit: gasLimit.toString(),
  maxCostWei: (gasLimit * maxFeePerGas).toString(), hardCostCapWei: maxCostWei.toString() };
console.log(JSON.stringify(plan));
if (!execute) process.exit(0);
if (process.env.E2E_APPROVED_FUNDING_ADDRESS !== jackpot ||
    process.env.E2E_APPROVED_FUNDING_ATOMIC !== amount.toString()) {
  throw new Error("exact fixture address and funding amount have not been approved");
}
try {
  await readFile(recordPath);
  throw new Error("fixture funding record already exists");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) });
const hash = await wallet.writeContract({ address: usdc, abi, functionName: "transfer",
  args: [jackpot, amount], gas: gasLimit, maxFeePerGas, maxPriorityFeePerGas });
console.log(JSON.stringify({ action: "submitted", hash }));
const receipt = await rpc.waitForTransactionReceipt({ hash, confirmations: 3 });
const transfers = parseEventLogs({ abi, logs: receipt.logs, eventName: "Transfer" });
if (receipt.status !== "success" ||
    !transfers.some((log) => getAddress(log.address) === usdc &&
      getAddress(log.args.from) === operator && getAddress(log.args.to) === jackpot &&
      log.args.value === amount)) {
  throw new Error("fixture funding receipt failed exact Transfer check");
}
const [afterOperator, afterJackpot] = await Promise.all([
  rpc.readContract({ address: usdc, abi, functionName: "balanceOf", args: [operator] }),
  rpc.readContract({ address: usdc, abi, functionName: "balanceOf", args: [jackpot] }),
]);
if (afterOperator !== operatorBalance - amount || afterJackpot !== amount) {
  throw new Error("fixture funding balances failed exact amount check");
}
await writeFile(recordPath, `${JSON.stringify({ ...plan, hash,
  blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash })}\n`,
{ flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ action: "confirmed", hash,
  blockNumber: receipt.blockNumber.toString(), amountAtomic: amount.toString() }));
