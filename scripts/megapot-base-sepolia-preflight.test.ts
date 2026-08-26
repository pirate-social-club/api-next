import { describe, expect, test } from "bun:test";
import type { MegapotV2DrawingState } from "../packages/platform-cf/src/megapot-v2.ts";
import type { MegapotV2RpcClient } from "../packages/platform-cf/src/megapot-v2-rpc.ts";
import {
  type MegapotBaseSepoliaAttestation,
  type MegapotBaseSepoliaPreflightDependencies,
  MegapotBaseSepoliaPreflightFailed,
  runMegapotBaseSepoliaPreflight,
} from "./megapot-base-sepolia-preflight.ts";

const address = (byte: string): string => `0x${byte.repeat(40)}`;
const hash = (byte: string): string => `0x${byte.repeat(64)}`;

const authority: MegapotBaseSepoliaAttestation = {
  deployment: {
    environment: "staging",
    chainId: 84_532,
    jackpotAddress: address("1"),
    ticketNftAddress: address("2"),
    usdcAddress: address("3"),
    custodyAddress: address("4"),
    referrerAddress: address("5"),
    jackpotCodeHash: hash("a"),
    ticketNftCodeHash: hash("b"),
    usdcCodeHash: hash("c"),
    attestationId: "megapot-base-sepolia-v2",
  },
  sourceTag: hash("d"),
  attestationBlockNumber: 100n,
  attestationBlockHash: hash("e"),
  verifiedAt: "2026-08-26T00:00:00.000Z",
};

const drawing: MegapotV2DrawingState = {
  prizePool: 5_000_000_000n,
  ticketPrice: 10_000n,
  edgePerTicket: 2_000n,
  referralWinShare: 100_000_000_000_000_000n,
  referralFee: 100_000_000_000_000_000n,
  globalTicketsBought: 0n,
  lpEarnings: 0n,
  drawingTime: 2_000n,
  winningTicket: 0n,
  ballMax: 25,
  bonusballMax: 13,
  payoutCalculator: address("6"),
  jackpotLock: false,
};

function dependencies(overrides?: {
  readonly headTimestamp?: bigint;
  readonly purchasesAllowed?: boolean;
  readonly nativeBalance?: bigint;
  readonly usdcBalance?: bigint;
  readonly allowance?: bigint;
  readonly drawing?: MegapotV2DrawingState;
  readonly anchorHash?: string;
}): MegapotBaseSepoliaPreflightDependencies {
  const rpc = {
    attestDeployment: async () => ({
      jackpotCodeHash: authority.deployment.jackpotCodeHash,
      ticketNftCodeHash: authority.deployment.ticketNftCodeHash,
      usdcCodeHash: authority.deployment.usdcCodeHash,
    }),
    readHead: async () => ({
      blockNumber: 200n,
      blockHash: hash("f"),
      blockTimestamp: overrides?.headTimestamp ?? 1_000n,
    }),
    readBlock: async () => ({
      blockNumber: authority.attestationBlockNumber,
      blockHash: overrides?.anchorHash ?? authority.attestationBlockHash,
      blockTimestamp: 900n,
    }),
    readCurrentDrawing: async () => ({ drawingId: 8_341n, state: overrides?.drawing ?? drawing }),
    readTicketPurchasesAllowed: async () => overrides?.purchasesAllowed ?? true,
    readNativeBalance: async () => overrides?.nativeBalance ?? 2_000n,
    readUsdcBalance: async () => overrides?.usdcBalance ?? 4_000n,
    readUsdcAllowance: async () => overrides?.allowance ?? 0n,
  } as unknown as MegapotV2RpcClient;
  return {
    loadAttestation: async () => authority,
    makeRpc: () => rpc,
  };
}

const input = {
  runtimeConnectionString: "postgres://runtime.invalid/db",
  rpcUrl: "https://base-sepolia.example.invalid",
  attestationId: authority.deployment.attestationId,
  purchaseSafetyMarginSeconds: 120,
  nativeGasReserveFloorWei: 1_000n,
  requireReady: true,
} as const;

describe("Base Sepolia Megapot preflight", () => {
  test("proves the attested chain anchor and reports funding and approval needs", async () => {
    const result = await runMegapotBaseSepoliaPreflight(input, dependencies());

    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.attestation.ticketNftAddress).toBe(authority.deployment.ticketNftAddress);
    expect(result.chain).toMatchObject({
      chainId: 84_532,
      headBlockNumber: "200",
      headTimestamp: "1000",
      ticketPurchasesAllowed: true,
    });
    expect(result.drawing).toMatchObject({
      id: "8341",
      ticketPriceAtomic: "10000",
      secondsUntilDrawing: "1000",
      locked: false,
    });
    expect(result.custody).toMatchObject({
      nativeBalanceWei: "2000",
      usdcBalanceAtomic: "4000",
      fundingShortfallAtomic: "6000",
      jackpotAllowanceAtomic: "0",
      approvalRequired: true,
    });
  });

  test("reports every transient readiness blocker without mutating staging", async () => {
    const lockedDrawing = { ...drawing, jackpotLock: true, drawingTime: 1_050n };
    const result = await runMegapotBaseSepoliaPreflight(
      { ...input, requireReady: false },
      dependencies({
        purchasesAllowed: false,
        nativeBalance: 999n,
        drawing: lockedDrawing,
      }),
    );

    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual([
      "ticket-purchases-disabled",
      "drawing-locked",
      "purchase-window-too-short",
      "custody-gas-below-floor",
    ]);

    await expect(
      runMegapotBaseSepoliaPreflight(input, dependencies({ purchasesAllowed: false })),
    ).rejects.toBeInstanceOf(MegapotBaseSepoliaPreflightFailed);
  });

  test("rejects an attestation anchor that is not on the live chain", async () => {
    await expect(
      runMegapotBaseSepoliaPreflight(input, dependencies({ anchorHash: hash("9") })),
    ).rejects.toMatchObject({ code: "staging-state-invalid" });
  });
});
