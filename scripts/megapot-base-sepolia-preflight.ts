import { ControlPlaneDb } from "@pirate/application";
import { Effect, Schema } from "effect";
import type { MegapotV2DeploymentAttestation } from "../packages/platform-cf/src/megapot-v2.ts";
import {
  type MegapotV2RpcClient,
  makeMegapotV2RpcClient,
} from "../packages/platform-cf/src/megapot-v2-rpc.ts";
import { makeDirectPostgresControlPlaneLayer } from "../packages/platform-cf/src/postgres.ts";
import { normalizePostgresConnectionString } from "./postgres-migrations.ts";

const Address = Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{40}$/u));
const Hash = Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{64}$/u));
const NonNegativeInteger = Schema.String.check(Schema.isPattern(/^(?:0|[1-9][0-9]*)$/u));

const ActiveAttestationRow = Schema.Struct({
  attestation_id: Schema.NonEmptyString,
  environment: Schema.Literal("staging"),
  chain_id: Schema.Literal("84532"),
  jackpot_address: Address,
  usdc_address: Address,
  ticket_nft_address: Address,
  custody_address: Address,
  referrer_address: Address,
  source_tag: Hash,
  jackpot_code_hash: Hash,
  usdc_code_hash: Hash,
  ticket_nft_code_hash: Hash,
  attestation_block_number: NonNegativeInteger,
  attestation_block_hash: Hash,
  abi_version: Schema.Literal("megapot_v2"),
  verified_at: Schema.NonEmptyString,
  token_decimals: Schema.Literal("6"),
});

type ActiveAttestationRow = Schema.Schema.Type<typeof ActiveAttestationRow>;

export type MegapotBaseSepoliaAttestation = Readonly<{
  deployment: MegapotV2DeploymentAttestation;
  sourceTag: string;
  attestationBlockNumber: bigint;
  attestationBlockHash: string;
  verifiedAt: string;
}>;

export type MegapotBaseSepoliaPreflightInput = Readonly<{
  runtimeConnectionString: string;
  rpcUrl: string;
  attestationId: string;
  purchaseSafetyMarginSeconds: number;
  nativeGasReserveFloorWei: bigint;
  requireReady: boolean;
}>;

export type MegapotBaseSepoliaPreflightResult = Readonly<{
  ready: boolean;
  blockers: readonly string[];
  attestation: Readonly<{
    id: string;
    verifiedAt: string;
    anchorBlockNumber: string;
    anchorBlockHash: string;
    jackpotAddress: string;
    ticketNftAddress: string;
    usdcAddress: string;
    custodyAddress: string;
    referrerAddress: string;
    sourceTag: string;
    codeHashes: Readonly<{ jackpot: string; ticketNft: string; usdc: string }>;
  }>;
  chain: Readonly<{
    chainId: 84_532;
    headBlockNumber: string;
    headBlockHash: string;
    headTimestamp: string;
    ticketPurchasesAllowed: boolean;
  }>;
  drawing: Readonly<{
    id: string;
    ticketPriceAtomic: string;
    drawingTime: string;
    secondsUntilDrawing: string;
    locked: boolean;
    ballMax: number;
    bonusballMax: number;
    referralFeeWei: string;
    referralWinShareWei: string;
  }>;
  custody: Readonly<{
    nativeBalanceWei: string;
    nativeGasReserveFloorWei: string;
    usdcBalanceAtomic: string;
    fundingShortfallAtomic: string;
    jackpotAllowanceAtomic: string;
    approvalRequired: boolean;
  }>;
}>;

export type MegapotBaseSepoliaPreflightDependencies = Readonly<{
  loadAttestation: (
    connectionString: string,
    attestationId: string,
  ) => Promise<MegapotBaseSepoliaAttestation>;
  makeRpc: (input: {
    readonly rpcUrl: string;
    readonly attestation: MegapotV2DeploymentAttestation;
  }) => MegapotV2RpcClient;
}>;

export class MegapotBaseSepoliaPreflightFailed extends Error {
  readonly code: "invalid-config" | "not-ready" | "staging-state-invalid";

  constructor(code: MegapotBaseSepoliaPreflightFailed["code"], message: string) {
    super(message);
    this.name = "MegapotBaseSepoliaPreflightFailed";
    this.code = code;
  }
}

function decodeAttestationRow(value: unknown): ActiveAttestationRow {
  try {
    return Schema.decodeUnknownSync(ActiveAttestationRow, { onExcessProperty: "error" })(value);
  } catch {
    throw new MegapotBaseSepoliaPreflightFailed(
      "staging-state-invalid",
      "The active staging Megapot attestation is invalid.",
    );
  }
}

export async function loadMegapotBaseSepoliaAttestation(
  connectionString: string,
  attestationId: string,
): Promise<MegapotBaseSepoliaAttestation> {
  const row = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<Readonly<Record<string, unknown>>>({
          label: "megapot.base-sepolia.preflight.attestation",
          text: `SELECT attestation.attestation_id, attestation.environment,
                        attestation.chain_id::text AS chain_id,
                        attestation.jackpot_address, attestation.usdc_address,
                        attestation.ticket_nft_address, attestation.custody_address,
                        attestation.referrer_address, attestation.source_tag,
                        attestation.jackpot_code_hash, attestation.usdc_code_hash,
                        attestation.ticket_nft_code_hash,
                        attestation.attestation_block_number::text AS attestation_block_number,
                        attestation.attestation_block_hash, attestation.abi_version,
                        attestation.verified_at::text AS verified_at,
                        asset.decimals::text AS token_decimals
                   FROM megapot_deployment_attestations attestation
                   JOIN reward_asset_whitelist asset
                     ON asset.chain_id=attestation.chain_id
                    AND asset.token_address=attestation.usdc_address
                    AND asset.asset_kind='settlement_usdc'
                    AND asset.environment='staging' AND asset.status='active'
                  WHERE attestation.attestation_id=$1
                    AND attestation.environment='staging'
                    AND attestation.status='active'`,
          values: [attestationId],
          readonly: true,
        });
        if (result.rows.length !== 1 || result.rows[0] === undefined) {
          return yield* Effect.fail(
            new MegapotBaseSepoliaPreflightFailed(
              "staging-state-invalid",
              "Exactly one active staging Megapot attestation and USDC whitelist row are required.",
            ),
          );
        }
        return result.rows[0];
      }).pipe(
        Effect.provide(
          makeDirectPostgresControlPlaneLayer(normalizePostgresConnectionString(connectionString)),
        ),
      ),
    ),
  );
  const decoded = decodeAttestationRow(row);
  const verifiedAt = new Date(decoded.verified_at);
  if (!Number.isFinite(verifiedAt.getTime())) {
    throw new MegapotBaseSepoliaPreflightFailed(
      "staging-state-invalid",
      "The active staging Megapot attestation timestamp is invalid.",
    );
  }
  return {
    deployment: {
      environment: decoded.environment,
      chainId: 84_532,
      jackpotAddress: decoded.jackpot_address,
      ticketNftAddress: decoded.ticket_nft_address,
      usdcAddress: decoded.usdc_address,
      custodyAddress: decoded.custody_address,
      referrerAddress: decoded.referrer_address,
      jackpotCodeHash: decoded.jackpot_code_hash,
      ticketNftCodeHash: decoded.ticket_nft_code_hash,
      usdcCodeHash: decoded.usdc_code_hash,
      attestationId: decoded.attestation_id,
    },
    sourceTag: decoded.source_tag,
    attestationBlockNumber: BigInt(decoded.attestation_block_number),
    attestationBlockHash: decoded.attestation_block_hash,
    verifiedAt: verifiedAt.toISOString(),
  };
}

const defaultDependencies: MegapotBaseSepoliaPreflightDependencies = {
  loadAttestation: loadMegapotBaseSepoliaAttestation,
  makeRpc: makeMegapotV2RpcClient,
};

function validateInput(input: MegapotBaseSepoliaPreflightInput): void {
  if (
    input.runtimeConnectionString.trim().length === 0 ||
    input.rpcUrl.trim().length === 0 ||
    input.attestationId.trim().length === 0 ||
    !Number.isSafeInteger(input.purchaseSafetyMarginSeconds) ||
    input.purchaseSafetyMarginSeconds < 1 ||
    input.purchaseSafetyMarginSeconds > 3_600 ||
    input.nativeGasReserveFloorWei < 0n
  ) {
    throw new MegapotBaseSepoliaPreflightFailed(
      "invalid-config",
      "The Base Sepolia preflight configuration is invalid.",
    );
  }
}

export async function runMegapotBaseSepoliaPreflight(
  input: MegapotBaseSepoliaPreflightInput,
  dependencies: MegapotBaseSepoliaPreflightDependencies = defaultDependencies,
): Promise<MegapotBaseSepoliaPreflightResult> {
  validateInput(input);
  const authority = await dependencies.loadAttestation(
    input.runtimeConnectionString,
    input.attestationId,
  );
  const rpc = dependencies.makeRpc({ rpcUrl: input.rpcUrl, attestation: authority.deployment });
  await rpc.attestDeployment();

  const [head, anchor, drawing, ticketPurchasesAllowed, nativeBalance, usdcBalance, allowance] =
    await Promise.all([
      rpc.readHead(),
      rpc.readBlock(authority.attestationBlockNumber),
      rpc.readCurrentDrawing(),
      rpc.readTicketPurchasesAllowed(),
      rpc.readNativeBalance(authority.deployment.custodyAddress),
      rpc.readUsdcBalance(authority.deployment.custodyAddress),
      rpc.readUsdcAllowance(
        authority.deployment.custodyAddress,
        authority.deployment.jackpotAddress,
      ),
    ]);
  if (
    anchor.blockHash !== authority.attestationBlockHash ||
    head.blockTimestamp === undefined ||
    head.blockNumber < anchor.blockNumber
  ) {
    throw new MegapotBaseSepoliaPreflightFailed(
      "staging-state-invalid",
      "The staging attestation anchor does not match the live Base Sepolia chain.",
    );
  }

  const secondsUntilDrawing = drawing.state.drawingTime - head.blockTimestamp;
  const blockers: string[] = [];
  if (!ticketPurchasesAllowed) blockers.push("ticket-purchases-disabled");
  if (drawing.state.jackpotLock) blockers.push("drawing-locked");
  if (secondsUntilDrawing <= BigInt(input.purchaseSafetyMarginSeconds)) {
    blockers.push("purchase-window-too-short");
  }
  if (nativeBalance < input.nativeGasReserveFloorWei) blockers.push("custody-gas-below-floor");

  const fundingShortfall =
    usdcBalance >= drawing.state.ticketPrice ? 0n : drawing.state.ticketPrice - usdcBalance;
  const result: MegapotBaseSepoliaPreflightResult = {
    ready: blockers.length === 0,
    blockers,
    attestation: {
      id: authority.deployment.attestationId,
      verifiedAt: authority.verifiedAt,
      anchorBlockNumber: authority.attestationBlockNumber.toString(),
      anchorBlockHash: authority.attestationBlockHash,
      jackpotAddress: authority.deployment.jackpotAddress,
      ticketNftAddress: authority.deployment.ticketNftAddress,
      usdcAddress: authority.deployment.usdcAddress,
      custodyAddress: authority.deployment.custodyAddress,
      referrerAddress: authority.deployment.referrerAddress,
      sourceTag: authority.sourceTag,
      codeHashes: {
        jackpot: authority.deployment.jackpotCodeHash,
        ticketNft: authority.deployment.ticketNftCodeHash,
        usdc: authority.deployment.usdcCodeHash,
      },
    },
    chain: {
      chainId: 84_532,
      headBlockNumber: head.blockNumber.toString(),
      headBlockHash: head.blockHash,
      headTimestamp: head.blockTimestamp.toString(),
      ticketPurchasesAllowed,
    },
    drawing: {
      id: drawing.drawingId.toString(),
      ticketPriceAtomic: drawing.state.ticketPrice.toString(),
      drawingTime: drawing.state.drawingTime.toString(),
      secondsUntilDrawing: secondsUntilDrawing.toString(),
      locked: drawing.state.jackpotLock,
      ballMax: drawing.state.ballMax,
      bonusballMax: drawing.state.bonusballMax,
      referralFeeWei: drawing.state.referralFee.toString(),
      referralWinShareWei: drawing.state.referralWinShare.toString(),
    },
    custody: {
      nativeBalanceWei: nativeBalance.toString(),
      nativeGasReserveFloorWei: input.nativeGasReserveFloorWei.toString(),
      usdcBalanceAtomic: usdcBalance.toString(),
      fundingShortfallAtomic: fundingShortfall.toString(),
      jackpotAllowanceAtomic: allowance.toString(),
      approvalRequired: allowance < drawing.state.ticketPrice,
    },
  };
  if (input.requireReady && !result.ready) {
    throw new MegapotBaseSepoliaPreflightFailed(
      "not-ready",
      `Base Sepolia Megapot is not ready: ${blockers.join(", ")}.`,
    );
  }
  return result;
}

function integerSetting(value: string | undefined, name: string): number {
  if (value === undefined || !/^[1-9][0-9]*$/u.test(value)) {
    throw new MegapotBaseSepoliaPreflightFailed("invalid-config", `${name} is required.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new MegapotBaseSepoliaPreflightFailed("invalid-config", `${name} is invalid.`);
  }
  return parsed;
}

function bigintSetting(value: string | undefined, name: string): bigint {
  if (value === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new MegapotBaseSepoliaPreflightFailed("invalid-config", `${name} is required.`);
  }
  return BigInt(value);
}

export async function main(args: readonly string[] = Bun.argv.slice(2)): Promise<void> {
  const unknown = args.filter((argument) => argument !== "--require-ready");
  if (unknown.length > 0) {
    throw new MegapotBaseSepoliaPreflightFailed(
      "invalid-config",
      `Unknown preflight option: ${unknown[0]}.`,
    );
  }
  if (process.env.API_NEXT_ENV !== "staging") {
    throw new MegapotBaseSepoliaPreflightFailed(
      "invalid-config",
      "The Base Sepolia preflight is refused unless API_NEXT_ENV=staging.",
    );
  }
  const result = await runMegapotBaseSepoliaPreflight({
    runtimeConnectionString: process.env.CONTROL_PLANE_POSTGRES_RUNTIME_URL ?? "",
    rpcUrl: process.env.MEGAPOT_V2_RPC_URL ?? "",
    attestationId: process.env.MEGAPOT_ATTESTATION_ID ?? "",
    purchaseSafetyMarginSeconds: integerSetting(
      process.env.MEGAPOT_PURCHASE_SAFETY_MARGIN_SECONDS,
      "MEGAPOT_PURCHASE_SAFETY_MARGIN_SECONDS",
    ),
    nativeGasReserveFloorWei: bigintSetting(
      process.env.MEGAPOT_NATIVE_GAS_RESERVE_FLOOR_WEI,
      "MEGAPOT_NATIVE_GAS_RESERVE_FLOOR_WEI",
    ),
    requireReady: args.includes("--require-ready"),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(
      error instanceof MegapotBaseSepoliaPreflightFailed
        ? error.message
        : "Base Sepolia Megapot preflight failed.",
    );
    process.exitCode = 1;
  });
}
