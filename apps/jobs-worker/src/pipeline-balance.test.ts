import { describe, expect, test } from "bun:test";
import { ControlPlaneDb } from "@pirate/application";
import { Effect, Fiber, Layer } from "effect";
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

  test("compensates a claimed window when snapshot input is invalid", async () => {
    const { logs, sink } = recordingSink();
    const diagnostics: string[] = [];
    const original = console.error;
    let reads = 0;
    console.error = (message?: unknown) => diagnostics.push(String(message));
    try {
      const options = {
        runtime,
        sink,
        environment: "staging",
        scheduledTime: 5 * 60 * 1000,
        data: {
          rpcUrl: "https://aeneid.storyrpc.io/",
          publicAddress: dataAddress,
          reserveFloorWei: 0n,
        },
        megapot: null,
        readDataBalance: async () => {
          reads += 1;
          return 1n;
        },
      } as const;
      await runPipelineBalanceSnapshots(options);
      await runPipelineBalanceSnapshots(options);
    } finally {
      console.error = original;
    }

    expect(reads).toBe(2);
    expect(logs).toEqual([]);
    expect(diagnostics).toEqual([
      "pipeline balance snapshot input invalid",
      "pipeline balance snapshot input invalid",
    ]);
  });

  test("skips non-boundary observations and permits an absent delivery provider", async () => {
    const logs: PipelineLogFields[] = [];
    let reads = 0;
    const sink: AlertSink = { log: (_event, fields) => logs.push(fields) };
    const options = {
      runtime,
      sink,
      environment: "staging",
      scheduledTime: 60_000,
      data: {
        rpcUrl: "https://aeneid.storyrpc.io/",
        publicAddress: dataAddress,
        reserveFloorWei: 200_000_000_000_000_000n,
      },
      megapot: null,
      readDataBalance: async () => {
        reads += 1;
        return 200_000_000_000_000_000n;
      },
    } as const;

    await runPipelineBalanceSnapshots(options);
    expect(reads).toBe(0);
    expect(logs).toEqual([]);

    await runPipelineBalanceSnapshots({ ...options, scheduledTime: 5 * 60 * 1000 });
    expect(reads).toBe(1);
    expect(logs).toHaveLength(1);
  });

  test("starts DATA observation before claiming Megapot without waiting for the provider", async () => {
    const events: string[] = [];
    const logs: PipelineLogFields[] = [];
    let releaseData!: (balance: bigint) => void;
    const dataBalance = new Promise<bigint>((resolve) => {
      releaseData = resolve;
    });
    let megapotClaimed!: () => void;
    const megapotClaim = new Promise<void>((resolve) => {
      megapotClaimed = resolve;
    });
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
    const pending = runPipelineBalanceSnapshots({
      runtime,
      sink: {
        log: (_event, fields) => logs.push(fields),
        delivery: {
          markSent: (key) =>
            Effect.sync(() => {
              const role = key.includes(":data:") ? "data" : "megapot";
              events.push(`claim:${role}`);
              if (role === "megapot") megapotClaimed();
              return true;
            }),
          compensate: () => Effect.void,
        },
      },
      environment: "staging",
      scheduledTime: 5 * 60 * 1000,
      data: {
        rpcUrl: "https://aeneid.storyrpc.io/",
        publicAddress: dataAddress,
        reserveFloorWei: 200_000_000_000_000_000n,
      },
      megapot: {
        attestationId: deployment.attestationId,
        rpcUrl: "https://base-sepolia.invalid/",
        chainId: deployment.chainId,
        reserveFloorWei: 100n,
      },
      readDataBalance: () => {
        events.push("data:start");
        return dataBalance;
      },
      loadMegapotDeployment: async () => deployment,
      readMegapotBalance: async () => 200n,
    });

    await megapotClaim;
    expect(events).toEqual(["claim:data", "data:start", "claim:megapot"]);
    releaseData(200_000_000_000_000_000n);
    await pending;
    expect(logs).toHaveLength(2);
  });

  test("suppresses observation when the snapshot claim is false or unavailable", async () => {
    for (const [claimSnapshot, shouldDiagnose] of [
      [() => Effect.succeed(false), false],
      [() => Effect.fail("fixture ledger unavailable"), true],
    ] as const) {
      const logs: PipelineLogFields[] = [];
      const diagnostics: string[] = [];
      let reads = 0;
      const original = console.error;
      console.error = (message?: unknown) => diagnostics.push(String(message));
      try {
        await runPipelineBalanceSnapshots({
          runtime,
          sink: {
            log: (_event, fields) => logs.push(fields),
            delivery: {
              markSent: claimSnapshot,
              compensate: () => Effect.die("claim must not compensate"),
            },
          },
          environment: "staging",
          scheduledTime: 5 * 60 * 1000,
          data: {
            rpcUrl: "https://aeneid.storyrpc.io/",
            publicAddress: dataAddress,
            reserveFloorWei: 200_000_000_000_000_000n,
          },
          megapot: null,
          readDataBalance: async () => {
            reads += 1;
            return 200_000_000_000_000_000n;
          },
        });
      } finally {
        console.error = original;
      }

      expect(reads).toBe(0);
      expect(logs).toEqual([]);
      expect(diagnostics).toEqual(
        shouldDiagnose ? ["pipeline balance snapshot claim unavailable"] : [],
      );
    }
  });

  test("retains a successful claim when a provider observation is unavailable", async () => {
    const { logs, sink } = recordingSink();
    let reads = 0;
    const options = {
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
        reads += 1;
        throw new Error("fixture RPC unavailable");
      },
    } as const;

    await runPipelineBalanceSnapshots(options);
    await runPipelineBalanceSnapshots(options);

    expect(reads).toBe(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ observation_status: "unavailable" });
  });

  test("retries unavailable Megapot output after a known writer failure", async () => {
    const diagnostics: string[] = [];
    const original = console.error;
    const marks = new Set<string>();
    let writerCalls = 0;
    let compensationCalls = 0;
    console.error = (message?: unknown) => diagnostics.push(String(message));
    try {
      await runPipelineBalanceSnapshots({
        runtime,
        sink: {
          log: () => {
            writerCalls += 1;
            throw new Error("fixture log unavailable");
          },
          delivery: {
            markSent: (key) =>
              Effect.sync(() => {
                if (marks.has(key)) return false;
                marks.add(key);
                return true;
              }),
            compensate: (key) =>
              Effect.sync(() => {
                compensationCalls += 1;
                marks.delete(key);
              }),
          },
        },
        environment: "staging",
        scheduledTime: 5 * 60 * 1000,
        data: null,
        megapot: {
          attestationId: "megapot-base-sepolia-v2",
          rpcUrl: "https://base-sepolia.invalid/",
          chainId: 84_532,
          reserveFloorWei: 100n,
        },
        loadMegapotDeployment: async () => ({
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
        }),
        readMegapotBalance: async () => 200n,
      });
    } finally {
      console.error = original;
    }

    expect(writerCalls).toBe(2);
    expect(compensationCalls).toBe(1);
    expect(diagnostics).toEqual(["pipeline balance snapshot log unavailable"]);
  });

  test("swallows compensation failure while retaining the claimed window", async () => {
    const diagnostics: string[] = [];
    const original = console.error;
    const marks = new Set<string>();
    let writerCalls = 0;
    let compensationCalls = 0;
    console.error = (message?: unknown) => diagnostics.push(String(message));
    try {
      const options = {
        runtime,
        sink: {
          log: () => {
            writerCalls += 1;
            throw new Error("fixture log unavailable");
          },
          delivery: {
            markSent: (key: string) =>
              Effect.sync(() => {
                if (marks.has(key)) return false;
                marks.add(key);
                return true;
              }),
            compensate: () =>
              Effect.sync(() => {
                compensationCalls += 1;
                throw new Error("fixture compensation unavailable");
              }),
          },
        },
        environment: "staging",
        scheduledTime: 5 * 60 * 1000,
        data: {
          rpcUrl: "https://aeneid.storyrpc.io/",
          publicAddress: dataAddress,
          reserveFloorWei: 200_000_000_000_000_000n,
        },
        megapot: null,
        readDataBalance: async () => 200_000_000_000_000_000n,
      } as const;

      await runPipelineBalanceSnapshots(options);
      await runPipelineBalanceSnapshots(options);
    } finally {
      console.error = original;
    }

    expect(writerCalls).toBe(1);
    expect(compensationCalls).toBe(1);
    expect(diagnostics).toEqual([
      "pipeline balance snapshot log unavailable",
      "pipeline balance snapshot compensation unavailable",
    ]);
  });

  test("propagates interruption without compensating an uncertain claim", async () => {
    const diagnostics: string[] = [];
    const original = console.error;
    let interrupt: (() => Promise<unknown>) | undefined;
    let releaseClaim!: (claimed: boolean) => void;
    let compensations = 0;
    let reads = 0;
    console.error = (message?: unknown) => diagnostics.push(String(message));
    try {
      const pending = runPipelineBalanceSnapshots({
        runtime,
        sink: {
          delivery: {
            markSent: () =>
              Effect.withFiber((fiber) =>
                Effect.tryPromise({
                  try: () =>
                    new Promise<boolean>((resolve) => {
                      interrupt = () => Effect.runPromise(Fiber.interrupt(fiber));
                      releaseClaim = resolve;
                    }),
                  catch: (error) => error,
                }),
              ),
            compensate: () =>
              Effect.sync(() => {
                compensations += 1;
              }),
          },
        },
        environment: "staging",
        scheduledTime: 5 * 60 * 1000,
        data: {
          rpcUrl: "https://aeneid.storyrpc.io/",
          publicAddress: dataAddress,
          reserveFloorWei: 200_000_000_000_000_000n,
        },
        megapot: null,
        readDataBalance: async () => {
          reads += 1;
          return 200_000_000_000_000_000n;
        },
      });

      for (let attempt = 0; attempt < 100 && interrupt === undefined; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (interrupt === undefined) throw new Error("claim fiber was not captured");
      const rejected = pending.then(
        () => false,
        () => true,
      );
      let interruptionSettled = false;
      const interruption = interrupt().then(() => {
        interruptionSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(interruptionSettled).toBe(false);
      releaseClaim(true);
      await interruption;
      expect(await rejected).toBe(true);
    } finally {
      console.error = original;
    }

    expect(compensations).toBe(0);
    expect(reads).toBe(0);
    expect(diagnostics).toEqual([]);
  });

  test("settles an in-flight compensation before honoring interruption", async () => {
    const diagnostics: string[] = [];
    const original = console.error;
    let interrupt: (() => Promise<unknown>) | undefined;
    let releaseCompensation!: () => void;
    let compensations = 0;
    let reads = 0;
    console.error = (message?: unknown) => diagnostics.push(String(message));
    try {
      const pending = runPipelineBalanceSnapshots({
        runtime,
        sink: {
          log: () => {
            throw new Error("fixture log unavailable");
          },
          delivery: {
            markSent: () =>
              Effect.withFiber((fiber) =>
                Effect.sync(() => {
                  interrupt = () => Effect.runPromise(Fiber.interrupt(fiber));
                  return true;
                }),
              ),
            compensate: () =>
              Effect.tryPromise({
                try: () =>
                  new Promise<void>((resolve) => {
                    compensations += 1;
                    releaseCompensation = resolve;
                  }),
                catch: (error) => error,
              }),
          },
        },
        environment: "staging",
        scheduledTime: 5 * 60 * 1000,
        data: {
          rpcUrl: "https://aeneid.storyrpc.io/",
          publicAddress: dataAddress,
          reserveFloorWei: 200_000_000_000_000_000n,
        },
        megapot: null,
        readDataBalance: async () => {
          reads += 1;
          return 200_000_000_000_000_000n;
        },
      });

      for (
        let attempt = 0;
        attempt < 100 && (interrupt === undefined || releaseCompensation === undefined);
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (interrupt === undefined || releaseCompensation === undefined) {
        throw new Error("compensation was not captured");
      }
      const rejected = pending.then(
        () => false,
        () => true,
      );
      const interruption = interrupt();
      let interruptionSettled = false;
      interruption.then(() => {
        interruptionSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(interruptionSettled).toBe(false);
      releaseCompensation();
      await interruption;
      expect(await rejected).toBe(true);
    } finally {
      console.error = original;
    }

    expect(compensations).toBe(1);
    expect(reads).toBe(1);
    expect(diagnostics).toEqual(["pipeline balance snapshot log unavailable"]);
  });
});
