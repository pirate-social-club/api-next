/** Bring an unentered isolated placeholder forward without changing its prize. */
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  type Abi, createPublicClient, createWalletClient, getAddress, http, keccak256,
  parseEventLogs,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

if (Bun.argv.slice(2).some((arg) => arg !== "--execute")) throw new Error("unknown option");
const execute = Bun.argv.includes("--execute");
const addressText = process.env.E2E_JACKPOT_ADDRESS;
const expectedHash = process.env.E2E_JACKPOT_CODE_HASH;
const drawingText = process.env.E2E_DRAWING_ID;
const timeText = process.env.E2E_DRAWING_TIME_UNIX;
const recordRoot = process.env.E2E_GUARD_RECORD_DIR;
const key = process.env.MEGAPOT_E2E_OPERATOR_PRIVATE_KEY;
const rpcUrl = process.env.MEGAPOT_V2_RPC_URL;
if (!/^0x[0-9a-fA-F]{40}$/u.test(addressText ?? "") ||
    !/^0x[0-9a-fA-F]{64}$/u.test(expectedHash ?? "") ||
    !/^[1-9]\d{0,3}$/u.test(drawingText ?? "") ||
    !/^\d{10}$/u.test(timeText ?? "") ||
    !recordRoot || !isAbsolute(recordRoot) || recordRoot.startsWith("/tmp/") ||
    !/^0x[0-9a-fA-F]{64}$/u.test(key ?? "") || !rpcUrl?.startsWith("https://")) {
  throw new Error("reviewed fixture, drawing, time, durable records and operator access required");
}
const jackpot = getAddress(addressText as string);
const drawingId = BigInt(drawingText as string);
const newTime = BigInt(timeText as string);
const account = privateKeyToAccount(key as `0x${string}`);
const artifact = JSON.parse(await readFile(resolve(import.meta.dir,
  "out/ControlledMegapot.sol/ControlledMegapot.json"), "utf8")) as { abi: Abi };
const rpc = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
if (await rpc.getChainId() !== baseSepolia.id) throw new Error("wrong chain");
const [code, head, operator, currentId, drawing, reserved, nonce, pending, fees, ethBalance] =
  await Promise.all([
    rpc.getCode({ address: jackpot }), rpc.getBlock(),
    rpc.readContract({ address: jackpot, abi: artifact.abi, functionName: "operator" }),
    rpc.readContract({ address: jackpot, abi: artifact.abi, functionName: "currentDrawingId" }),
    rpc.readContract({ address: jackpot, abi: artifact.abi, functionName: "getDrawingState",
      args: [drawingId] }),
    rpc.readContract({ address: jackpot, abi: artifact.abi, functionName: "reservedPayout" }),
    rpc.getTransactionCount({ address: account.address, blockTag: "latest" }),
    rpc.getTransactionCount({ address: account.address, blockTag: "pending" }),
    rpc.estimateFeesPerGas(), rpc.getBalance({ address: account.address }),
  ]);
const state = drawing as { drawingTime?: unknown; globalTicketsBought?: unknown;
  prizePool?: unknown; jackpotLock?: unknown };
if (!code || keccak256(code).toLowerCase() !== expectedHash?.toLowerCase() ||
    operator !== account.address || currentId !== drawingId ||
    typeof drawing !== "object" || drawing === null ||
    state.globalTicketsBought !== 0n || state.jackpotLock !== false ||
    typeof state.prizePool !== "bigint" || state.prizePool <= 0n ||
    typeof state.drawingTime !== "bigint" ||
    newTime < head.timestamp + 300n || newTime > head.timestamp + 3_600n ||
    newTime >= state.drawingTime || typeof reserved !== "bigint" ||
    reserved < state.prizePool || pending !== nonce) {
  throw new Error("empty drawing, code, funding, time or operator precondition failed");
}
const gasEstimate = await rpc.estimateContractGas({ address: jackpot, abi: artifact.abi,
  functionName: "rescheduleEmptyDrawing", args: [newTime], account: account.address });
const gasLimit = gasEstimate + gasEstimate / 4n;
const maxFeePerGas = fees.maxFeePerGas;
const maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
if (!maxFeePerGas || !maxPriorityFeePerGas || gasLimit > 300_000n ||
    gasLimit * maxFeePerGas > 100_000_000_000_000n ||
    ethBalance < gasLimit * maxFeePerGas) {
  throw new Error("reschedule gas cap or operator balance failed");
}
const recordPath = `${recordRoot}/rescheduled-empty-drawing-${drawingId}.json`;
const plan = { action: execute ? "execute" : "dry-run", jackpot,
  codeHash: expectedHash, drawingId: String(drawingId),
  oldTimeUnix: String(state.drawingTime), newTimeUnix: String(newTime),
  prizeAtomic: String(state.prizePool), reservedAtomic: String(reserved),
  operatorNonce: nonce, gasLimit: String(gasLimit),
  maxCostWei: String(gasLimit * maxFeePerGas) };
console.log(JSON.stringify(plan));
if (!execute) process.exit(0);
if (process.env.E2E_APPROVED_DRAWING_TIME_UNIX !== timeText) {
  throw new Error("exact new drawing time has not been approved");
}
try {
  await readFile(recordPath);
  throw new Error("reschedule record already exists");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) });
const hash = await wallet.writeContract({ address: jackpot, abi: artifact.abi,
  functionName: "rescheduleEmptyDrawing", args: [newTime], gas: gasLimit,
  maxFeePerGas, maxPriorityFeePerGas });
console.log(JSON.stringify({ action: "submitted", hash }));
const receipt = await rpc.waitForTransactionReceipt({ hash, confirmations: 3 });
const events = parseEventLogs({ abi: artifact.abi, logs: receipt.logs,
  eventName: "EmptyDrawingRescheduled" });
const event = events[0] as { address: string; args: {
  drawingId?: unknown; oldTime?: unknown; newTime?: unknown;
} } | undefined;
const [after, afterId, afterReserved] = await Promise.all([
  rpc.readContract({ address: jackpot, abi: artifact.abi, functionName: "getDrawingState",
    args: [drawingId] }),
  rpc.readContract({ address: jackpot, abi: artifact.abi, functionName: "currentDrawingId" }),
  rpc.readContract({ address: jackpot, abi: artifact.abi, functionName: "reservedPayout" }),
]);
const next = after as typeof state;
if (receipt.status !== "success" || events.length !== 1 || event === undefined ||
    event.address.toLowerCase() !== jackpot.toLowerCase() ||
    event.args.drawingId !== drawingId ||
    event.args.oldTime !== state.drawingTime ||
    event.args.newTime !== newTime || afterId !== drawingId ||
    typeof after !== "object" || after === null ||
    next.drawingTime !== newTime || next.globalTicketsBought !== 0n ||
    next.prizePool !== state.prizePool || afterReserved !== reserved) {
  throw new Error("reschedule receipt or state readback failed");
}
await writeFile(recordPath, `${JSON.stringify({ ...plan, hash,
  blockNumber: String(receipt.blockNumber), blockHash: receipt.blockHash })}\n`,
{ flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ action: "rescheduled", hash, drawingId: String(drawingId) }));
