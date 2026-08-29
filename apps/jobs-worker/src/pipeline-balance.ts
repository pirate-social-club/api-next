import type { ControlPlaneDb, ControlPlaneError } from "@pirate/application";
import { Effect, type Layer } from "effect";
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

export const PIPELINE_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
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

export function isPipelineSnapshotBoundary(scheduledTime: number): boolean {
  return Number.isSafeInteger(scheduledTime) && scheduledTime % PIPELINE_SNAPSHOT_INTERVAL_MS === 0;
}

async function claimSnapshot(sink: AlertSink, role: "data" | "megapot", scheduledTime: number) {
  if (!isPipelineSnapshotBoundary(scheduledTime)) return false;
  if (sink.delivery === undefined) return true;
  try {
    return await Effect.runPromise(
      sink.delivery.markSent(
        `pipeline-balance:${role}:window-${Math.floor(scheduledTime / PIPELINE_SNAPSHOT_INTERVAL_MS)}`,
      ),
    );
  } catch {
    return false;
  }
}

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

async function emitDataBalance(
  config: DataRegistrationBalanceConfig,
  environment: string,
  scheduledTime: number,
  writer: (event: PipelineLogEvent, fields: PipelineLogFields) => void,
  reader: DataBalanceReader,
): Promise<void> {
  let balance: bigint | null = null;
  try {
    balance = await reader(config);
  } catch {
    // Balance observation is diagnostic and must not reject DATA maintenance.
  }
  writeOperationsBalanceSnapshot(
    {
      environment,
      emitted_at: new Date(scheduledTime).toISOString(),
      wallet_role: "data_registration_signer",
      chain_id: 1315,
      public_address: config.publicAddress,
      balance_wei: balance,
      reserve_floor_wei: config.reserveFloorWei,
      blocked_floor_wei: DATA_REGISTRATION_BLOCKED_BALANCE_WEI,
    },
    writer,
  );
}

async function emitMegapotBalance(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  config: MegapotBalanceConfig,
  environment: string,
  scheduledTime: number,
  writer: (event: PipelineLogEvent, fields: PipelineLogFields) => void,
  loadDeployment: MegapotDeploymentLoader,
  readBalance: MegapotBalanceReader,
): Promise<void> {
  const unavailable = () =>
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
    );
  try {
    const deployment = await loadDeployment(runtime, config.attestationId);
    if (deployment.environment !== environment || deployment.chainId !== config.chainId) {
      unavailable();
      return;
    }
    let balance: bigint | null = null;
    try {
      balance = await readBalance(config.rpcUrl, deployment);
    } catch {
      // Balance observation is diagnostic and must not reject rewards work.
    }
    writeOperationsBalanceSnapshot(
      {
        environment,
        emitted_at: new Date(scheduledTime).toISOString(),
        wallet_role: "megapot_custody",
        chain_id: deployment.chainId,
        public_address: deployment.custodyAddress,
        balance_wei: balance,
        reserve_floor_wei: config.reserveFloorWei,
        blocked_floor_wei: 1n,
      },
      writer,
    );
  } catch {
    unavailable();
  }
}

export async function runPipelineBalanceSnapshots(
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
  if (!isPipelineSnapshotBoundary(options.scheduledTime)) return;
  const writer = writerFor(options.sink);
  const observations: Promise<void>[] = [];
  if (options.data !== null && (await claimSnapshot(options.sink, "data", options.scheduledTime))) {
    observations.push(
      emitDataBalance(
        options.data,
        options.environment,
        options.scheduledTime,
        writer,
        options.readDataBalance ??
          ((config) =>
            readNativeBalance(makeJsonRpcTransport(config.rpcUrl), config.publicAddress)),
      ),
    );
  }
  if (
    options.megapot !== null &&
    (await claimSnapshot(options.sink, "megapot", options.scheduledTime))
  ) {
    observations.push(
      emitMegapotBalance(
        options.runtime,
        {
          attestationId: options.megapot.attestationId,
          rpcUrl: options.megapot.rpcUrl,
          chainId: options.megapot.chainId,
          reserveFloorWei: options.megapot.reserveFloorWei,
        },
        options.environment,
        options.scheduledTime,
        writer,
        options.loadMegapotDeployment ??
          ((runtime, attestationId) =>
            Effect.runPromise(
              makeControlPlaneMegapotDrawingObservationStore(runtime).loadCandidate(attestationId),
            )),
        options.readMegapotBalance ??
          ((rpcUrl, deployment) =>
            makeMegapotV2RpcClient({ rpcUrl, attestation: deployment }).readNativeBalance(
              deployment.custodyAddress,
            )),
      ),
    );
  }
  await Promise.allSettled(observations);
}
