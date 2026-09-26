/** Put exactly one test USDC into the isolated, attested jackpot. */
import { readFile, writeFile } from "node:fs/promises";
import { createPublicClient, createWalletClient, getAddress, http, parseAbi, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const jackpot = getAddress("0xb9464401103143e916434A277064f5601f3D7708");
const operator = getAddress("0x8fB9941a4782E4fc05467f9A3138c66C7F2aaCaF");
const usdc = getAddress("0x036cbd53842c5426634e7929541eC2318f3dCF7e");
const amount = 1_000_000n;
const maxCostWei = 100_000_000_000_000n;
const recordPath = "/tmp/megapot-e2e-config-20260926/fixture-funding.json";
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
const seed = JSON.parse(await readFile("/tmp/megapot-e2e-config-20260926/seed-from-sponsor.json", "utf8")) as {
  to: string; amountAtomic: string; token: string; hash: `0x${string}`;
};
if (getAddress(seed.to) !== operator || getAddress(seed.token) !== usdc ||
    seed.amountAtomic !== amount.toString()) {
  throw new Error("sponsor seed record does not match operator USDC");
}
const rpc = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
if (await rpc.getChainId() !== baseSepolia.id) throw new Error("wrong chain");
const [seedReceipt, operatorBalance, jackpotBalance, latest, pending, fees, ethBalance] =
  await Promise.all([
    rpc.getTransactionReceipt({ hash: seed.hash }),
    rpc.readContract({ address: usdc, abi, functionName: "balanceOf", args: [operator] }),
    rpc.readContract({ address: usdc, abi, functionName: "balanceOf", args: [jackpot] }),
    rpc.getTransactionCount({ address: operator, blockTag: "latest" }),
    rpc.getTransactionCount({ address: operator, blockTag: "pending" }),
    rpc.estimateFeesPerGas(), rpc.getBalance({ address: operator }),
  ]);
if (seedReceipt.status !== "success" || operatorBalance !== amount || jackpotBalance !== 0n ||
    latest !== 1 || pending !== latest) {
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
  gasEstimate: gasEstimate.toString(), gasLimit: gasLimit.toString(),
  maxCostWei: (gasLimit * maxFeePerGas).toString(), hardCostCapWei: maxCostWei.toString() };
console.log(JSON.stringify(plan));
if (!execute) process.exit(0);
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
if (afterOperator !== 0n || afterJackpot !== amount) {
  throw new Error("fixture funding balances failed exact amount check");
}
await writeFile(recordPath, `${JSON.stringify({ ...plan, hash,
  blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash })}\n`,
{ flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ action: "confirmed", hash,
  blockNumber: receipt.blockNumber.toString(), amountAtomic: amount.toString() }));
