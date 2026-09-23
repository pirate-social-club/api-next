import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { MegapotTicket } from "@pirate/domain";
import { type Hex, keccak256, toBytes } from "viem";
import { decodeMegapotMainnetCoreCandidate } from "./megapot-mainnet-core-preflight.ts";
import {
  encodeMegapotBuyTickets,
  encodeMegapotUsdcApproval,
  encodeMegapotUsdcTransfer,
  MEGAPOT_REFERRAL_SPLIT_SCALE,
  type MegapotV2DeploymentAttestation,
  validateMegapotPurchaseReceipt,
  validateMegapotUsdcApprovalReceipt,
} from "./megapot-v2.ts";
import { type MegapotV2RpcClient, makeMegapotV2RpcClient } from "./megapot-v2-rpc.ts";

// Run only against a fresh local Anvil fork. Never point this write test at a remote RPC.
const FORK_BLOCK = 51_684_323;
const FORK_BLOCK_HASH = "0x970d4d23b2ebd87f4be71feea6fabe0945cccb3a38bb2d78310cb3840b88232f";
const HOLDER = "0x498581ff718922c3f8e6a244956af099b2652b2b";
const CUSTODY = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const REFERRER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const FUNDING_ATOMIC = 5_000_000n;
const APPROVAL_ATOMIC = 2_000_000n;

type RpcEnvelope = { jsonrpc: "2.0"; id: number; result?: unknown; error?: unknown };

function localForkUrl(): string {
  const value = process.env.MEGAPOT_BASE_FORK_RPC_URL;
  if (value === undefined) throw new Error("MEGAPOT_BASE_FORK_RPC_URL is required");
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("fork RPC must be an uncredentialed 127.0.0.1 HTTP origin");
  }
  return url.href;
}

function localRpc(url: string) {
  let id = 0;
  return async (method: string, params: readonly unknown[]): Promise<unknown> => {
    id += 1;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    if (!response.ok) throw new Error(`local fork RPC failed: ${method}`);
    const body = (await response.json()) as RpcEnvelope;
    if (body.jsonrpc !== "2.0" || body.id !== id || body.error !== undefined) {
      throw new Error(`local fork RPC rejected: ${method}`);
    }
    return body.result;
  };
}

async function waitForReceipt(client: MegapotV2RpcClient, transactionHash: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const receipt = await client.readReceipt(transactionHash);
    if (receipt !== null) return receipt;
    await Bun.sleep(250);
  }
  throw new Error("local fork receipt did not arrive");
}

const runForkTest = process.env.MEGAPOT_BASE_FORK_RPC_URL === undefined ? test.skip : test;

runForkTest(
  "Base mainnet fork executes Circle USDC approval and Megapot ticket purchase",
  async () => {
    const url = localForkUrl();
    const rpc = localRpc(url);
    const nodeInfo = (await rpc("anvil_nodeInfo", [])) as {
      forkConfig?: { forkBlockNumber?: number; forkUrl?: string };
    };
    expect(nodeInfo.forkConfig?.forkBlockNumber).toBe(FORK_BLOCK);
    expect(new URL(nodeInfo.forkConfig?.forkUrl ?? "http://invalid").protocol).toBe("https:");
    expect(await rpc("eth_chainId", [])).toBe("0x2105");
    const pinnedBlock = (await rpc("eth_getBlockByNumber", [
      `0x${FORK_BLOCK.toString(16)}`,
      false,
    ])) as {
      hash?: string;
    };
    expect(pinnedBlock.hash?.toLowerCase()).toBe(FORK_BLOCK_HASH);
    const currentBlock = BigInt((await rpc("eth_blockNumber", [])) as string);
    expect(currentBlock).toBe(BigInt(FORK_BLOCK));

    const candidate = decodeMegapotMainnetCoreCandidate(
      JSON.parse(
        await readFile(
          new URL(
            "../../../infra/megapot/base-mainnet-v2-deployment-candidate.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ) as unknown,
    );
    const deployment: MegapotV2DeploymentAttestation = {
      environment: "production",
      chainId: candidate.chain_id,
      jackpotAddress: candidate.jackpot_address,
      ticketNftAddress: candidate.ticket_nft_address,
      usdcAddress: candidate.usdc_address,
      custodyAddress: CUSTODY,
      referrerAddress: REFERRER,
      jackpotCodeHash: candidate.jackpot_code_hash,
      ticketNftCodeHash: candidate.ticket_nft_code_hash,
      usdcCodeHash: candidate.usdc_code_hash,
      usdcImplementationAddress: candidate.usdc_implementation_address,
      usdcImplementationCodeHash: candidate.usdc_implementation_code_hash,
      attestationId: "local-base-fork-approval",
    };
    const client = makeMegapotV2RpcClient({ rpcUrl: url, attestation: deployment });
    await client.attestDeployment();
    expect(await client.readUsdcAllowance(CUSTODY, deployment.jackpotAddress)).toBe(0n);
    expect(await client.readUsdcBalance(HOLDER)).toBeGreaterThan(FUNDING_ATOMIC);

    await rpc("anvil_impersonateAccount", [HOLDER]);
    await rpc("anvil_setBalance", [HOLDER, "0x3635c9adc5dea00000"]);
    const fundingHash = (await rpc("eth_sendTransaction", [
      {
        from: HOLDER,
        to: deployment.usdcAddress,
        data: encodeMegapotUsdcTransfer(CUSTODY, FUNDING_ATOMIC),
      },
    ])) as Hex;
    expect((await waitForReceipt(client, fundingHash)).status).toBe("success");
    expect(await client.readUsdcBalance(CUSTODY)).toBe(FUNDING_ATOMIC);

    const approvalHash = (await rpc("eth_sendTransaction", [
      {
        from: CUSTODY,
        to: deployment.usdcAddress,
        data: encodeMegapotUsdcApproval(deployment.jackpotAddress, APPROVAL_ATOMIC),
      },
    ])) as Hex;
    const receipt = await waitForReceipt(client, approvalHash);
    const evidence = validateMegapotUsdcApprovalReceipt({
      deployment,
      receipt,
      approvedAmountAtomic: APPROVAL_ATOMIC,
    });
    expect(evidence.transactionHash).toBe(approvalHash.toLowerCase());
    expect(evidence.approvedAmountAtomic).toBe(APPROVAL_ATOMIC);
    expect(await client.readUsdcAllowance(CUSTODY, deployment.jackpotAddress)).toBe(
      APPROVAL_ATOMIC,
    );

    expect(await client.readTicketPurchasesAllowed()).toBe(true);
    const { drawingId, state } = await client.readCurrentDrawing();
    expect(drawingId).toBe(183n);
    expect(state.ticketPrice).toBe(1_000_000n);
    const ticket: MegapotTicket = { normals: [1, 2, 3, 4, 5], bonusball: 1 };
    const source = keccak256(toBytes("pirate.megapot.local-fork.purchase"));
    const balanceBeforePurchase = await client.readUsdcBalance(CUSTODY);
    const purchaseHash = (await rpc("eth_sendTransaction", [
      {
        from: CUSTODY,
        to: deployment.jackpotAddress,
        data: encodeMegapotBuyTickets({
          tickets: [ticket],
          recipient: CUSTODY,
          referrers: [REFERRER],
          referralSplit: [MEGAPOT_REFERRAL_SPLIT_SCALE],
          source,
        }),
      },
    ])) as Hex;
    const purchaseReceipt = await waitForReceipt(client, purchaseHash);
    const purchaseEvidence = validateMegapotPurchaseReceipt({
      deployment,
      receipt: purchaseReceipt,
      drawingId,
      source,
      tickets: [ticket],
    });
    expect(purchaseEvidence.transactionHash).toBe(purchaseHash.toLowerCase());
    expect(purchaseEvidence.ticketIds).toHaveLength(1);
    const ticketId = purchaseEvidence.ticketIds[0];
    if (ticketId === undefined) throw new Error("local fork purchase did not mint a ticket");
    expect(await client.readTicketOwner(ticketId)).toBe(CUSTODY.toLowerCase());
    expect(balanceBeforePurchase - (await client.readUsdcBalance(CUSTODY))).toBe(state.ticketPrice);
  },
);
