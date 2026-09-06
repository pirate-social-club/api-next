import type { ControlPlaneDb, ControlPlaneError } from "@pirate/application";
import { Cause, Effect, Fiber, type Layer } from "effect";
import {
  type AlertSink,
  type PipelineLogEvent,
  type PipelineLogFields,
  writeOperationsBalanceSnapshot,
} from "../../../packages/platform-cf/src/alerts.ts";
import { makeJsonRpcTransport } from "../../../packages/platform-cf/src/data/registration-aeneid-chain.ts";
import { makeControlPlaneMegapotDrawingObservationStore } from "../../../packages/platform-cf/src/megapot-drawing-observation-repository.ts";
import type { MegapotV2DeploymentAttestation } from "../../../packages/platform-cf/src/megapot-v2.ts";
import { makeMegapotV2RpcClient } from "../../../packages/platform-cf/src/megapot-v2-rpc.ts";
import { readNativeBalance } from "../../../packages/platform-cf/src/native-balance.ts";
import type { JobsWorkerEnv } from "./index";

const PIPELINE_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
export const DATA_REGISTRATION_BLOCKED_BALANCE_WEI = 7_500_000_000_000_000n;
export const DATA_REGISTRATION_RESERVE_FLOOR_WEI = 200_000_000_000_000_000n;

export type DataRegistrationBalanceConfig = Readonly<{
  rpcUrl: string;
  publicAddress: string;
  reserveFloorWei: bigint;
}>;

export type MegapotBalanceConfig = Readonly<{
  attestationId: string;
  rpcUrl: string;
  chainId: number;
  reserveFloorWei: bigint;
}>;

export type DataBalanceReader = (config: DataRegistrationBalanceConfig) => Promise<bigint>;
export type MegapotDeploymentLoader = (
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  attestationId: string,
) => Promise<MegapotV2DeploymentAttestation>;
export type MegapotBalanceReader = (
  rpcUrl: string,
  deployment: MegapotV2DeploymentAttestation,
) => Promise<bigint>;

function isPipelineSnapshotBoundary(scheduledTime: number): boolean {
  return (
    Number.isSafeInteger(scheduledTime) &&
    Math.floor(scheduledTime / 60_000) % (PIPELINE_SNAPSHOT_INTERVAL_MS / 60_000) === 0
  );
}

const claimSnapshot = Effect.fn("pipelineBalance.claimSnapshot")(function* (
  sink: AlertSink,
  role: "data" | "megapot",
  scheduledTime: number,
): Effect.fn.Return<boolean, unknown> {
  if (!isPipelineSnapshotBoundary(scheduledTime)) return false;
  if (sink.delivery === undefined) return true;
  const key = `pipeline-balance:${role}:window-${Math.floor(
    scheduledTime / PIPELINE_SNAPSHOT_INTERVAL_MS,
  )}`;
  const delivery = sink.delivery;
  return yield* Effect.uninterruptible(Effect.suspend(() => delivery.markSent(key))).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.failCause(cause)
        : Effect.sync(() => {
            console.error("pipeline balance snapshot claim unavailable");
            return false;
          }),
    ),
  );
});

const compensateSnapshot = Effect.fn("pipelineBalance.compensateSnapshot")(function* (
  sink: AlertSink,
  key: string,
): Effect.fn.Return<void, unknown> {
  const delivery = sink.delivery;
  if (delivery === undefined) return;
  yield* Effect.uninterruptible(Effect.suspend(() => delivery.compensate(key))).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.failCause(cause)
        : Effect.sync(() => {
            console.error("pipeline balance snapshot compensation unavailable");
          }),
    ),
  );
});

const runClaimedSnapshot = Effect.fn("pipelineBalance.runClaimedSnapshot")(function* (
  sink: AlertSink,
  key: string,
  emit: Effect.Effect<boolean, unknown>,
): Effect.fn.Return<void, unknown> {
  const result = yield* Effect.exit(Effect.suspend(() => emit));
  if (result._tag === "Failure") {
    if (Cause.hasInterrupts(result.cause)) return yield* Effect.failCause(result.cause);
    yield* Effect.sync(() => console.error("pipeline balance snapshot log unavailable"));
  } else if (result.value) {
    return;
  } else {
    yield* Effect.sync(() => console.error("pipeline balance snapshot input invalid"));
  }
  yield* compensateSnapshot(sink, key);
});

const settleObservation = Effect.fn("pipelineBalance.settleObservation")(function* (
  sink: AlertSink,
  key: string,
  emit: Effect.Effect<boolean, unknown>,
): Effect.fn.Return<void, unknown> {
  const result = yield* Effect.exit(runClaimedSnapshot(sink, key, emit));
  if (result._tag === "Failure" && Cause.hasInterrupts(result.cause)) {
    return yield* Effect.failCause(result.cause);
  }
});

function requiredString(value: string | undefined, name: string): string {
  const result = value?.trim();
  if (result === undefined || result.length === 0) {
    throw new Error(`${name} is required when DATA registration is enabled`);
  }
  return result;
}

function positiveBigint(value: string | undefined, name: string): bigint {
  const text = requiredString(value, name);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(text)) {
    throw new Error(`${name} is invalid`);
  }
  const result = BigInt(text);
  if (result <= 0n) throw new Error(`${name} is invalid`);
  return result;
}

export function makeDataRegistrationBalanceConfig(
  env: Pick<
    JobsWorkerEnv,
    | "DATA_REGISTRATION_ENABLED"
    | "DATA_REGISTRATION_RPC_URL"
    | "DATA_REGISTRATION_SIGNER_ADDRESS"
    | "DATA_REGISTRATION_NATIVE_BALANCE_FLOOR_WEI"
  >,
): DataRegistrationBalanceConfig | null {
  if (env.DATA_REGISTRATION_ENABLED !== "true") return null;
  const rpcUrl = requiredString(env.DATA_REGISTRATION_RPC_URL, "DATA_REGISTRATION_RPC_URL");
  let parsed: URL;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    throw new Error("DATA_REGISTRATION_RPC_URL is invalid");
  }
  if (parsed.protocol !== "https:") throw new Error("DATA_REGISTRATION_RPC_URL is invalid");
  const publicAddress = requiredString(
    env.DATA_REGISTRATION_SIGNER_ADDRESS,
    "DATA_REGISTRATION_SIGNER_ADDRESS",
  ).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/u.test(publicAddress)) {
    throw new Error("DATA_REGISTRATION_SIGNER_ADDRESS is invalid");
  }
  const reserveFloorWei = positiveBigint(
    env.DATA_REGISTRATION_NATIVE_BALANCE_FLOOR_WEI,
    "DATA_REGISTRATION_NATIVE_BALANCE_FLOOR_WEI",
  );
  if (reserveFloorWei !== DATA_REGISTRATION_RESERVE_FLOOR_WEI) {
    throw new Error("DATA_REGISTRATION_NATIVE_BALANCE_FLOOR_WEI must match policy");
  }
  return {
    rpcUrl: parsed.toString(),
    publicAddress,
    reserveFloorWei,
  };
}

function writerFor(sink: AlertSink): (event: PipelineLogEvent, fields: PipelineLogFields) => void {
  return sink.log ?? ((event, fields) => console.info(event, fields));
}

const emitDataBalance = Effect.fn("pipelineBalance.emitDataBalance")(function* (
  config: DataRegistrationBalanceConfig,
  environment: string,
  scheduledTime: number,
  writer: (event: PipelineLogEvent, fields: PipelineLogFields) => void,
  reader: DataBalanceReader,
): Effect.fn.Return<boolean, unknown> {
  const balance = yield* Effect.tryPromise({
    try: () => reader(config),
    catch: (error) => error,
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.succeed(null),
    ),
  );
  return yield* Effect.sync(() =>
    writeOperationsBalanceSnapshot(
      {
        environment,
        emitted_at: new Date(scheduledTime).toISOString(),
        wallet_role: "data_registration_signer",
        chain_id: 1315,
        public_address: config.publicAddress,
        balance_wei: balance as bigint | null,
        reserve_floor_wei: config.reserveFloorWei,
        blocked_floor_wei: DATA_REGISTRATION_BLOCKED_BALANCE_WEI,
      },
      writer,
    ),
  );
});

const emitMegapotBalance = Effect.fn("pipelineBalance.emitMegapotBalance")(function* (
  config: MegapotBalanceConfig,
  environment: string,
  scheduledTime: number,
  writer: (event: PipelineLogEvent, fields: PipelineLogFields) => void,
  loadDeployment: Effect.Effect<MegapotV2DeploymentAttestation, unknown>,
  readBalance: MegapotBalanceReader,
): Effect.fn.Return<boolean, unknown> {
  const unavailable = Effect.sync(() =>
    writeOperationsBalanceSnapshot(
      {
        environment,
        emitted_at: new Date(scheduledTime).toISOString(),
        wallet_role: "megapot_custody",
        chain_id: null,
        public_address: null,
        balance_wei: null,
        reserve_floor_wei: config.reserveFloorWei,
        blocked_floor_wei: 1n,
      },
      writer,
    ),
  );
  const observed = Effect.gen(function* () {
    const deployment = yield* loadDeployment;
    if (deployment.environment !== environment || deployment.chainId !== config.chainId) {
      return yield* unavailable;
    }
    const balance = yield* Effect.tryPromise({
      try: () => readBalance(config.rpcUrl, deployment),
      catch: (error) => error,
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.succeed(null),
      ),
    );
    return yield* Effect.sync(() =>
      writeOperationsBalanceSnapshot(
        {
          environment,
          emitted_at: new Date(scheduledTime).toISOString(),
          wallet_role: "megapot_custody",
          chain_id: deployment.chainId,
          public_address: deployment.custodyAddress,
          balance_wei: balance as bigint | null,
          reserve_floor_wei: config.reserveFloorWei,
          blocked_floor_wei: 1n,
        },
        writer,
      ),
    );
  });
  return yield* observed.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause) ? Effect.failCause(cause) : unavailable,
    ),
  );
});

const runPipelineBalanceSnapshotsEffect = Effect.fn("pipelineBalance.runPipelineBalanceSnapshots")(
  function* (
    options: Readonly<{
      runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>;
      sink: AlertSink;
      environment: string;
      scheduledTime: number;
      data: DataRegistrationBalanceConfig | null;
      megapot: MegapotBalanceConfig | null;
      readDataBalance?: DataBalanceReader;
      loadMegapotDeployment?: MegapotDeploymentLoader;
      readMegapotBalance?: MegapotBalanceReader;
    }>,
  ): Effect.fn.Return<void, unknown> {
    if (!isPipelineSnapshotBoundary(options.scheduledTime)) return;
    const writer = writerFor(options.sink);
    const observationFibers: Fiber.Fiber<void, unknown>[] = [];
    const startObservation = (key: string, emit: Effect.Effect<boolean, unknown>) =>
      Effect.forkChild(settleObservation(options.sink, key, emit), { startImmediately: true });
    const dataKey = `pipeline-balance:data:window-${Math.floor(
      options.scheduledTime / PIPELINE_SNAPSHOT_INTERVAL_MS,
    )}`;
    const data = options.data;
    if (data !== null && (yield* claimSnapshot(options.sink, "data", options.scheduledTime))) {
      const readDataBalance =
        options.readDataBalance ??
        ((config: DataRegistrationBalanceConfig) =>
          readNativeBalance(makeJsonRpcTransport(config.rpcUrl), config.publicAddress));
      observationFibers.push(
        yield* startObservation(
          dataKey,
          emitDataBalance(
            data,
            options.environment,
            options.scheduledTime,
            writer,
            readDataBalance,
          ),
        ),
      );
      yield* Effect.yieldNow;
    }
    const megapotKey = `pipeline-balance:megapot:window-${Math.floor(
      options.scheduledTime / PIPELINE_SNAPSHOT_INTERVAL_MS,
    )}`;
    const megapot = options.megapot;
    if (
      megapot !== null &&
      (yield* claimSnapshot(options.sink, "megapot", options.scheduledTime))
    ) {
      const loadMegapotDeployment = Effect.fn("pipelineBalance.loadMegapotDeployment")(function* (
        runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
        attestationId: string,
      ): Effect.fn.Return<MegapotV2DeploymentAttestation, unknown> {
        const configuredLoader = options.loadMegapotDeployment;
        if (configuredLoader !== undefined) {
          return yield* Effect.tryPromise({
            try: () => configuredLoader(runtime, attestationId),
            catch: (error) => error,
          });
        }
        return yield* Effect.suspend(() =>
          makeControlPlaneMegapotDrawingObservationStore(runtime).loadCandidate(attestationId),
        );
      });
      const readMegapotBalance =
        options.readMegapotBalance ??
        ((rpcUrl: string, deployment: MegapotV2DeploymentAttestation) =>
          makeMegapotV2RpcClient({ rpcUrl, attestation: deployment }).readNativeBalance(
            deployment.custodyAddress,
          ));
      observationFibers.push(
        yield* startObservation(
          megapotKey,
          emitMegapotBalance(
            megapot,
            options.environment,
            options.scheduledTime,
            writer,
            loadMegapotDeployment(options.runtime, megapot.attestationId),
            readMegapotBalance,
          ),
        ),
      );
    }
    yield* Effect.all(
      observationFibers.map((fiber) => Fiber.join(fiber)),
      { concurrency: "unbounded", discard: true },
    );
  },
);

export function runPipelineBalanceSnapshots(
  options: Readonly<{
    runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>;
    sink: AlertSink;
    environment: string;
    scheduledTime: number;
    data: DataRegistrationBalanceConfig | null;
    megapot: MegapotBalanceConfig | null;
    readDataBalance?: DataBalanceReader;
    loadMegapotDeployment?: MegapotDeploymentLoader;
    readMegapotBalance?: MegapotBalanceReader;
  }>,
): Promise<void> {
  return Effect.runPromise(runPipelineBalanceSnapshotsEffect(options));
}
