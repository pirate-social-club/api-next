import type { MegapotV2RpcClient } from "./megapot-v2-rpc.ts";

/** Mainnet simulation requires the canonical finalized L2 head as well as depth. */
export async function readMegapotFinalizedHead(rpc: MegapotV2RpcClient) {
  if (rpc.readFinalizedHead === undefined) throw new Error("megapot_finalized_head_required");
  const finalized = await rpc.readFinalizedHead();
  const canonical = await rpc.readBlock(finalized.blockNumber);
  if (
    canonical.blockNumber !== finalized.blockNumber ||
    canonical.blockHash !== finalized.blockHash
  ) {
    throw new Error("megapot_finalized_head_reorg");
  }
  return finalized;
}

export async function megapotReceiptIsFinalized(
  rpc: MegapotV2RpcClient,
  chainId: number,
  blockNumber: bigint,
): Promise<boolean> {
  return chainId !== 8453 || (await readMegapotFinalizedHead(rpc)).blockNumber >= blockNumber;
}

/** Refuse signing against a latest-only owner or a drawing not finalized yet. */
export async function requireMegapotFinalizedClaimOwner(
  rpc: MegapotV2RpcClient,
  input: { readonly ticketId: bigint; readonly drawingId: bigint; readonly custodyAddress: string },
): Promise<void> {
  const block = await readMegapotFinalizedHead(rpc);
  const [drawingId, owner] = await Promise.all([
    rpc.readCurrentDrawingId(block.blockNumber),
    rpc.readTicketOwner(input.ticketId, block.blockNumber),
  ]);
  if (drawingId <= input.drawingId) throw new Error("megapot_claim_drawing_not_finalized");
  if (owner.toLowerCase() !== input.custodyAddress.toLowerCase())
    throw new Error("megapot_claim_finalized_owner_mismatch");
  const canonical = await rpc.readBlock(block.blockNumber);
  if (canonical.blockNumber !== block.blockNumber || canonical.blockHash !== block.blockHash)
    throw new Error("megapot_finalized_head_reorg");
}
