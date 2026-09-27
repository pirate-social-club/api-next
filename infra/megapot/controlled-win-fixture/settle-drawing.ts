/** Settle an isolated Base Sepolia drawing after its scheduled time. */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type Abi, createPublicClient, createWalletClient, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const jackpot = getAddress("0xb9464401103143e916434A277064f5601f3D7708");
const operator = getAddress("0x8fB9941a4782E4fc05467f9A3138c66C7F2aaCaF");
const custody = getAddress("0x544881290138fe0E66C1EC7D1A1f141395246f20");
const prize = 1_000_000n;
const drawingNumber = process.env.E2E_DRAWING_ID;
if (drawingNumber !== "1" && drawingNumber !== "2") throw new Error("drawing ID must be 1 or 2");
const winning = drawingNumber === "2";
const armedRecordPath = `/tmp/megapot-e2e-config-20260926/armed-drawing-${drawingNumber}.json`;
const settledRecordPath = `/tmp/megapot-e2e-config-20260926/settled-drawing-${drawingNumber}.json`;
const artifact = JSON.parse(await readFile(resolve(import.meta.dir,
  "out/ControlledMegapot.sol/ControlledMegapot.json"), "utf8")) as { abi: Abi };
const ticket = JSON.parse(await readFile(resolve(import.meta.dir,
  "out/ControlledMegapot.sol/ControlledMegapotTicket.json"), "utf8")) as { abi: Abi };

if (Bun.argv.slice(2).some((arg) => arg !== "--execute")) throw new Error("unknown option");
const execute = Bun.argv.includes("--execute");
const key = process.env.MEGAPOT_E2E_OPERATOR_PRIVATE_KEY;
const rpcUrl = process.env.MEGAPOT_V2_RPC_URL;
if (!/^0x[0-9a-fA-F]{64}$/u.test(key ?? "") || !rpcUrl?.startsWith("https://")) {
  throw new Error("operator key and HTTPS RPC are required");
}
const account = privateKeyToAccount(key as `0x${string}`);
if (account.address !== operator) throw new Error("operator key mismatch");
const rpc = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
if (await rpc.getChainId() !== baseSepolia.id) throw new Error("wrong chain");

const armed = JSON.parse(await readFile(armedRecordPath, "utf8")) as {
  hash: `0x${string}`; drawingId: string; prizeAtomic: string; drawingTimeUnix: string;
};
if (armed.drawingId !== drawingNumber || armed.prizeAtomic !== prize.toString() ||
    (await rpc.getTransactionReceipt({ hash: armed.hash })).status !== "success") {
  throw new Error("drawing arm record is not confirmed");
}
const [head, drawingId, nextTicketId, reserved, state, ticketNft, nonce, pending,
  fees, ethBalance] = await Promise.all([
  rpc.getBlock(),
  rpc.readContract({ address: jackpot, abi: artifact.abi, functionName: "currentDrawingId" }),
  rpc.readContract({ address: jackpot, abi: artifact.abi, functionName: "nextTicketId" }),
  rpc.readContract({ address: jackpot, abi: artifact.abi, functionName: "reservedPayout" }),
  rpc.readContract({ address: jackpot, abi: artifact.abi, functionName: "getDrawingState", args: [BigInt(drawingNumber)] }),
  rpc.readContract({ address: jackpot, abi: artifact.abi, functionName: "jackpotNFT" }),
  rpc.getTransactionCount({ address: operator, blockTag: "latest" }),
  rpc.getTransactionCount({ address: operator, blockTag: "pending" }),
  rpc.estimateFeesPerGas(), rpc.getBalance({ address: operator }),
]);
const drawing = state as { drawingTime?: unknown; prizePool?: unknown;
  globalTicketsBought?: unknown; jackpotLock?: unknown };
if (drawingId !== BigInt(drawingNumber) || nextTicketId !== (winning ? 2n : 1n) || reserved !== prize ||
    typeof state !== "object" || !state || drawing.drawingTime !== BigInt(armed.drawingTimeUnix) ||
    drawing.prizePool !== prize || drawing.globalTicketsBought !== (winning ? 1n : 0n) ||
    drawing.jackpotLock !== false || typeof ticketNft !== "string" ||
    pending !== nonce) {
  throw new Error("drawing, purchased ticket or operator nonce precondition failed");
}
const ticketOwner = winning
  ? await rpc.readContract({ address: getAddress(ticketNft),
    abi: ticket.abi, functionName: "ownerOf", args: [1n] })
  : null;
if (winning && ticketOwner !== custody) throw new Error("purchased ticket is not in custody");
const due = head.timestamp >= BigInt(armed.drawingTimeUnix);
const plan = { action: execute ? "execute" : "dry-run", jackpot, drawingId: drawingNumber,
  drawingTimeUtc: new Date(Number(armed.drawingTimeUnix) * 1000).toISOString(),
  headTimeUtc: new Date(Number(head.timestamp) * 1000).toISOString(),
  due, expectedTickets: winning ? 1 : 0, ticketId: winning ? "1" : null,
  ticketOwner, prizeAtomic: prize.toString(),
  operatorNonce: nonce };
if (!execute) { console.log(JSON.stringify(plan)); process.exit(0); }
if (!due) throw new Error("drawing is not due");
try {
  await readFile(settledRecordPath);
  throw new Error("drawing settlement record already exists");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const gasEstimate = await rpc.estimateContractGas({ address: jackpot,
  abi: artifact.abi, functionName: "settleDrawing", account: operator });
const gasLimit = gasEstimate + gasEstimate / 4n;
const maxFeePerGas = fees.maxFeePerGas;
const maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
if (!maxFeePerGas || !maxPriorityFeePerGas || gasLimit > 300_000n ||
    gasLimit * maxFeePerGas > 100_000_000_000_000n ||
    ethBalance < gasLimit * maxFeePerGas) {
  throw new Error("settlement gas cap or operator balance failed");
}
console.log(JSON.stringify({ ...plan, gasLimit: gasLimit.toString(),
  maxCostWei: (gasLimit * maxFeePerGas).toString() }));
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) });
const hash = await wallet.writeContract({ address: jackpot, abi: artifact.abi,
  functionName: "settleDrawing", gas: gasLimit, maxFeePerGas, maxPriorityFeePerGas });
console.log(JSON.stringify({ action: "submitted", hash }));
const receipt = await rpc.waitForTransactionReceipt({ hash, confirmations: 3 });
const [nextDrawing, after, tierIds, remaining] = await Promise.all([
  rpc.readContract({ address: jackpot, abi: artifact.abi, functionName: "currentDrawingId" }),
  rpc.readContract({ address: jackpot, abi: artifact.abi, functionName: "getDrawingState", args: [BigInt(drawingNumber)] }),
  winning
    ? rpc.readContract({ address: jackpot, abi: artifact.abi, functionName: "getTicketTierIds", args: [[1n]] })
    : Promise.resolve([]),
  rpc.readContract({ address: jackpot, abi: artifact.abi, functionName: "reservedPayout" }),
]);
const settled = after as { jackpotLock?: unknown; winningTicket?: unknown };
if (receipt.status !== "success" || nextDrawing !== BigInt(drawingNumber) + 1n ||
    typeof after !== "object" || !after || settled.jackpotLock !== true ||
    settled.winningTicket !== (winning ? 1n : 0n) || !Array.isArray(tierIds) ||
    tierIds.length !== (winning ? 1 : 0) || (winning && tierIds[0] !== 1n) ||
    remaining !== (winning ? prize : 0n)) {
  throw new Error("drawing settlement receipt or state readback failed");
}
await writeFile(settledRecordPath, `${JSON.stringify({ ...plan, hash,
  blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash,
  tier: winning ? "1" : null })}\n`, { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ action: "settled", hash, drawingId: drawingNumber,
  tier: winning ? "1" : null }));
