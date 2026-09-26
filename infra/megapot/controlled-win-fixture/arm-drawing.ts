/** Arm one funded, one-ticket Base Sepolia drawing at a chosen time. */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type Abi, createPublicClient, createWalletClient, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const jackpot = getAddress("0xb9464401103143e916434A277064f5601f3D7708");
const operator = getAddress("0x8fB9941a4782E4fc05467f9A3138c66C7F2aaCaF");
const usdc = getAddress("0x036cbd53842c5426634e7929541eC2318f3dCF7e");
const prize = 1_000_000n;
const recordPath = "/tmp/megapot-e2e-config-20260926/armed-drawing-1.json";
const artifact = JSON.parse(await readFile(resolve(import.meta.dir,
  "out/ControlledMegapot.sol/ControlledMegapot.json"), "utf8")) as {
    abi: Abi;
  };
const erc20 = [{ type: "function", name: "balanceOf", stateMutability: "view",
  inputs: [{ name: "account", type: "address" }],
  outputs: [{ name: "balance", type: "uint256" }] }] as const;

if (Bun.argv.slice(2).some((arg) => arg !== "--execute")) throw new Error("unknown option");
const execute = Bun.argv.includes("--execute");
const drawingUnix = process.env.E2E_DRAWING_TIME_UNIX;
const key = process.env.MEGAPOT_E2E_OPERATOR_PRIVATE_KEY;
const rpcUrl = process.env.MEGAPOT_V2_RPC_URL;
if (!/^\d{10}$/u.test(drawingUnix ?? "") || !/^0x[0-9a-fA-F]{64}$/u.test(key ?? "") ||
    !rpcUrl?.startsWith("https://")) {
  throw new Error("drawing Unix time, operator key and HTTPS RPC are required");
}
const account = privateKeyToAccount(key as `0x${string}`);
if (account.address !== operator) throw new Error("operator key mismatch");
const rpc = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
if (await rpc.getChainId() !== baseSepolia.id) throw new Error("wrong chain");
const funded = JSON.parse(await readFile("/tmp/megapot-e2e-config-20260926/fixture-funding.json", "utf8")) as {
  to: string; amountAtomic: string; hash: `0x${string}`;
};
if (getAddress(funded.to) !== jackpot || funded.amountAtomic !== prize.toString() ||
    (await rpc.getTransactionReceipt({ hash: funded.hash })).status !== "success") {
  throw new Error("fixture funding record is not confirmed");
}
const [head, drawingId, nextTicketId, reserved, purchasable, balance, nonce, pending, fees, ethBalance] =
  await Promise.all([
    rpc.getBlock(),
    rpc.readContract({ address: jackpot, abi: artifact.abi, functionName: "currentDrawingId" }),
    rpc.readContract({ address: jackpot, abi: artifact.abi, functionName: "nextTicketId" }),
    rpc.readContract({ address: jackpot, abi: artifact.abi, functionName: "reservedPayout" }),
    rpc.readContract({ address: jackpot, abi: artifact.abi, functionName: "allowTicketPurchases" }),
    rpc.readContract({ address: usdc, abi: erc20, functionName: "balanceOf", args: [jackpot] }),
    rpc.getTransactionCount({ address: operator, blockTag: "latest" }),
    rpc.getTransactionCount({ address: operator, blockTag: "pending" }),
    rpc.estimateFeesPerGas(), rpc.getBalance({ address: operator }),
  ]);
const at = BigInt(drawingUnix as string);
if (drawingId !== 1n || nextTicketId !== 1n || reserved !== 0n || purchasable !== false ||
    balance !== prize || nonce < 2 || pending !== nonce ||
    at < head.timestamp + 600n || at > head.timestamp + 14_400n) {
  throw new Error("drawing ID, prize, operator nonce or time window precondition failed");
}
const gasEstimate = await rpc.estimateContractGas({ address: jackpot, abi: artifact.abi,
  functionName: "armDrawing", args: [at, prize], account: operator });
const gasLimit = gasEstimate + gasEstimate / 4n;
const maxFeePerGas = fees.maxFeePerGas;
const maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
if (!maxFeePerGas || !maxPriorityFeePerGas || gasLimit > 300_000n ||
    gasLimit * maxFeePerGas > 100_000_000_000_000n ||
    ethBalance < gasLimit * maxFeePerGas) {
  throw new Error("drawing arm gas cap or operator balance failed");
}
const plan = { action: execute ? "execute" : "dry-run", jackpot,
  drawingId: "1", drawingTimeUnix: at.toString(),
  drawingTimeUtc: new Date(Number(at) * 1000).toISOString(),
  prizeAtomic: prize.toString(), ticketLimit: 1, operatorNonce: nonce,
  gasLimit: gasLimit.toString(), maxCostWei: (gasLimit * maxFeePerGas).toString() };
console.log(JSON.stringify(plan));
if (!execute) process.exit(0);
if (process.env.E2E_APPROVED_DRAWING_TIME_UNIX !== drawingUnix) {
  throw new Error("exact drawing time has not been approved");
}
try {
  await readFile(recordPath);
  throw new Error("drawing record already exists");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) });
const hash = await wallet.writeContract({ address: jackpot, abi: artifact.abi,
  functionName: "armDrawing", args: [at, prize], gas: gasLimit,
  maxFeePerGas, maxPriorityFeePerGas });
console.log(JSON.stringify({ action: "submitted", hash }));
const receipt = await rpc.waitForTransactionReceipt({ hash, confirmations: 3 });
const [state, payouts, open] = await Promise.all([
  rpc.readContract({ address: jackpot, abi: artifact.abi, functionName: "getDrawingState", args: [1n] }),
  rpc.readContract({ address: jackpot, abi: artifact.abi, functionName: "getDrawingTierPayouts", args: [1n] }),
  rpc.readContract({ address: jackpot, abi: artifact.abi, functionName: "allowTicketPurchases" }),
]);
const drawing = state as { drawingTime?: unknown; prizePool?: unknown;
  globalTicketsBought?: unknown };
if (receipt.status !== "success" || typeof state !== "object" || !state ||
    drawing.drawingTime !== at || drawing.prizePool !== prize ||
    drawing.globalTicketsBought !== 0n ||
    !Array.isArray(payouts) || payouts[1] !== prize || open !== true) {
  throw new Error("drawing arm receipt or state readback failed");
}
await writeFile(recordPath, `${JSON.stringify({ ...plan, hash,
  blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash })}\n`,
{ flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ action: "armed", hash, drawingId: "1",
  drawingTimeUtc: plan.drawingTimeUtc }));
