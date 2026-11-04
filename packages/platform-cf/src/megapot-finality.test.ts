import { expect, test } from "bun:test";
import {
  megapotReceiptIsFinalized,
  readMegapotFinalizedHead,
  requireMegapotFinalizedClaimOwner,
} from "./megapot-finality.ts";
import type { MegapotV2RpcClient } from "./megapot-v2-rpc.ts";

test("mainnet receipts wait for canonical finality, independently of confirmation depth", async () => {
  let finalized = 99n;
  let reorg = false;
  const rpc = {
    readFinalizedHead: async () => ({ blockNumber: finalized, blockHash: "canonical" }),
    readBlock: async (blockNumber: bigint) => ({
      blockNumber,
      blockHash: reorg ? "changed" : "canonical",
    }),
  } as MegapotV2RpcClient;
  expect(await megapotReceiptIsFinalized(rpc, 8453, 100n)).toBe(false);
  finalized = 100n;
  expect(await megapotReceiptIsFinalized(rpc, 8453, 100n)).toBe(true);
  reorg = true;
  await expect(megapotReceiptIsFinalized(rpc, 8453, 100n)).rejects.toThrow(
    "megapot_finalized_head_reorg",
  );
  await expect(readMegapotFinalizedHead({} as MegapotV2RpcClient)).rejects.toThrow(
    "megapot_finalized_head_required",
  );
  expect(await megapotReceiptIsFinalized({} as MegapotV2RpcClient, 84532, 100n)).toBe(true);
});

test("claim ownership and drawing rollover must agree at the canonical finalized block", async () => {
  let owner = "custody";
  let drawing = 11n;
  let reads = 0;
  let reorg = false;
  const rpc = {
    readFinalizedHead: async () => ({ blockNumber: 50n, blockHash: "canonical" }),
    readBlock: async (block: bigint) => {
      expect(block).toBe(50n);
      reads += 1;
      return { blockNumber: block, blockHash: reorg && reads % 2 === 0 ? "changed" : "canonical" };
    },
    readCurrentDrawingId: async (block: bigint) => {
      expect(block).toBe(50n);
      return drawing;
    },
    readTicketOwner: async (ticket: bigint, block: bigint) => {
      expect(ticket).toBe(9n);
      expect(block).toBe(50n);
      return owner;
    },
  } as MegapotV2RpcClient;
  const input = { ticketId: 9n, drawingId: 10n, custodyAddress: "custody" };
  await requireMegapotFinalizedClaimOwner(rpc, input);
  owner = "other";
  await expect(requireMegapotFinalizedClaimOwner(rpc, input)).rejects.toThrow(
    "megapot_claim_finalized_owner_mismatch",
  );
  owner = "custody";
  drawing = 10n;
  await expect(requireMegapotFinalizedClaimOwner(rpc, input)).rejects.toThrow(
    "megapot_claim_drawing_not_finalized",
  );
  drawing = 11n;
  reorg = true;
  reads = 0;
  await expect(requireMegapotFinalizedClaimOwner(rpc, input)).rejects.toThrow(
    "megapot_finalized_head_reorg",
  );
});
