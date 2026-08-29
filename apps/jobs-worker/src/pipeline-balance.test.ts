import { describe, expect, test } from "bun:test";
import { ControlPlaneDb } from "@pirate/application";
import { Effect, Layer } from "effect";
import type { AlertSink, PipelineLogFields } from "../../../packages/platform-cf/src/alerts.ts";
import {
  DATA_REGISTRATION_BLOCKED_BALANCE_WEI,
  DATA_REGISTRATION_RESERVE_FLOOR_WEI,
  makeDataRegistrationBalanceConfig,
  runPipelineBalanceSnapshots,
} from "./pipeline-balance";

const dataAddress = `0x${"1".repeat(40)}`;
const custodyAddress = `0x${"2".repeat(40)}`;
const contractAddress = (digit: string) => `0x${digit.repeat(40)}`;
const codeHash = (digit: string) => `0x${digit.repeat(64)}`;

const runtime = Layer.succeed(ControlPlaneDb, {
  execute: () => Effect.die("balance fixture must not query PostgreSQL"),
  withTransaction: () => Effect.die("balance fixture must not open a transaction"),
} as unknown as ControlPlaneDb["Service"]);

function recordingSink() {
  const logs: PipelineLogFields[] = [];
  const marks = new Set<string>();
  const sink: AlertSink = {
    log: (_event, fields) => logs.push(fields),
    delivery: {
      markSent: (key) =>
        Effect.sync(() => {
          if (marks.has(key)) return false;
          marks.add(key);
          return true;
        }),
      compensate: (key) => Effect.sync(() => void marks.delete(key)),
    },
  };
  return { logs, sink };
}

describe("pipeline operational balance snapshots", () => {
  test("requires the approved DATA observation bindings only when DATA is enabled", () => {
    expect(makeDataRegistrationBalanceConfig({ DATA_REGISTRATION_ENABLED: "false" })).toBeNull();
    expect(() => makeDataRegistrationBalanceConfig({ DATA_REGISTRATION_ENABLED: "true" })).toThrow(
      "DATA_REGISTRATION_RPC_URL is required",
    );
    expect(() =>
      makeDataRegistrationBalanceConfig({
        DATA_REGISTRATION_ENABLED: "true",
        DATA_REGISTRATION_RPC_URL: "https://aeneid.storyrpc.io",
        DATA_REGISTRATION_SIGNER_ADDRESS: dataAddress,
        DATA_REGISTRATION_NATIVE_BALANCE_FLOOR_WEI: "100000000000000000",
      }),
    ).toThrow("must match policy");

    expect(
      makeDataRegistrationBalanceConfig({
        DATA_REGISTRATION_ENABLED: "true",
        DATA_REGISTRATION_RPC_URL: "https://aeneid.storyrpc.io",
        DATA_REGISTRATION_SIGNER_ADDRESS: dataAddress,
        DATA_REGISTRATION_NATIVE_BALANCE_FLOOR_WEI: "200000000000000000",
      }),
    ).toEqual({
      rpcUrl: "https://aeneid.storyrpc.io/",
      publicAddress: dataAddress,
      reserveFloorWei: DATA_REGISTRATION_RESERVE_FLOOR_WEI,
    });
  });

  test("emits one durable-window DATA record despite cron delivery seconds", async () => {
    const { logs, sink } = recordingSink();
    const data = {
      rpcUrl: "https://aeneid.storyrpc.io/",
      publicAddress: dataAddress,
      reserveFloorWei: 200_000_000_000_000_000n,
    };
    let reads = 0;
    const lowRead = async () => {
      reads += 1;
      return 150_000_000_000_000_000n;
    };

    const options = {
      runtime,
      sink,
      environment: "staging",
      scheduledTime: 5 * 60 * 1000 + 14_000,
      data,
      megapot: null,
      readDataBalance: lowRead,
    } as const;
    await runPipelineBalanceSnapshots(options);
    await runPipelineBalanceSnapshots(options);

    expect(reads).toBe(1);
    expect(logs).toEqual([
      {
        event: "operations.balance.snapshot",
        schema_version: 1,
        emitted_at: "1970-01-01T00:05:14.000Z",
        environment: "staging",
        wallet_role: "data_registration_signer",
        chain_id: 1315,
        public_address: dataAddress,
        balance_wei: "150000000000000000",
        balance_ratio_bps: 7500,
        observation_status: "fresh",
        reserve_status: "low",
        sampled: false,
      },
    ]);

    await runPipelineBalanceSnapshots({
      ...options,
      scheduledTime: 10 * 60 * 1000,
      readDataBalance: async () => DATA_REGISTRATION_BLOCKED_BALANCE_WEI - 1n,
    });
    expect(logs[1]).toMatchObject({
      balance_ratio_bps: 374,
      observation_status: "fresh",
      reserve_status: "blocked",
    });
  });

  test("records unavailable DATA RPC observations without rejecting maintenance", async () => {
    const { logs, sink } = recordingSink();
    await expect(
      runPipelineBalanceSnapshots({
        runtime,
        sink,
        environment: "staging",
        scheduledTime: 5 * 60 * 1000,
        data: {
          rpcUrl: "https://aeneid.storyrpc.io/",
          publicAddress: dataAddress,
          reserveFloorWei: 200_000_000_000_000_000n,
        },
        megapot: null,
        readDataBalance: async () => {
          throw new Error("fixture RPC unavailable");
        },
      }),
    ).resolves.toBeUndefined();
    expect(logs).toEqual([
      expect.objectContaining({
        event: "operations.balance.snapshot",
        balance_wei: null,
        balance_ratio_bps: null,
        observation_status: "unavailable",
        reserve_status: "unknown",
      }),
    ]);
  });

  test("emits only the authoritative Megapot custody wallet", async () => {
    const { logs, sink } = recordingSink();
    const deployment = {
      attestationId: "megapot-base-sepolia-v2",
      environment: "staging",
      chainId: 84_532,
      jackpotAddress: contractAddress("3"),
      usdcAddress: contractAddress("4"),
      ticketNftAddress: contractAddress("5"),
      custodyAddress,
      referrerAddress: contractAddress("6"),
      jackpotCodeHash: codeHash("7"),
      usdcCodeHash: codeHash("8"),
      ticketNftCodeHash: codeHash("9"),
    } as const;

    await runPipelineBalanceSnapshots({
      runtime,
      sink,
      environment: "staging",
      scheduledTime: 5 * 60 * 1000,
      data: null,
      megapot: {
        attestationId: deployment.attestationId,
        rpcUrl: "https://base-sepolia.invalid/",
        chainId: deployment.chainId,
        reserveFloorWei: 100n,
      },
      loadMegapotDeployment: async () => deployment,
      readMegapotBalance: async () => 200n,
    });

    expect(logs).toEqual([
      expect.objectContaining({
        event: "operations.balance.snapshot",
        wallet_role: "megapot_custody",
        chain_id: 84_532,
        public_address: custodyAddress,
        balance_wei: "200",
        balance_ratio_bps: 20_000,
        observation_status: "fresh",
        reserve_status: "sufficient",
      }),
    ]);
  });

  test("records an unavailable Megapot snapshot when deployment authority cannot load", async () => {
    const { logs, sink } = recordingSink();
    await runPipelineBalanceSnapshots({
      runtime,
      sink,
      environment: "staging",
      scheduledTime: 5 * 60 * 1000,
      data: null,
      megapot: {
        attestationId: "megapot-base-sepolia-v2",
        rpcUrl: "https://base-sepolia.invalid/",
        chainId: 84_532,
        reserveFloorWei: 100n,
      },
      loadMegapotDeployment: async () => {
        throw new Error("fixture deployment unavailable");
      },
    });

    expect(logs).toEqual([
      expect.objectContaining({
        event: "operations.balance.snapshot",
        wallet_role: "megapot_custody",
        chain_id: null,
        public_address: null,
        balance_wei: null,
        balance_ratio_bps: null,
        observation_status: "unavailable",
        reserve_status: "unknown",
      }),
    ]);
  });
});
