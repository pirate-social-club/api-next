/**
 * Settles an owner-executed Safe ticket purchase that executed after its ticket-first
 * drawing had closed unexecuted. Settlement holds such a purchase with its reservation,
 * and the custody solvency observation counts that reservation although the Safe
 * already paid for the ticket, which can refuse every payout.
 *
 * Without --apply it only reads: for every held Safe purchase on the attestation, or
 * the one --effect names, it re-verifies the chain evidence and prints what recovery
 * would do. With --apply it re-verifies the one --effect names and settles it through
 * the owner-only database function: the effect is confirmed, the ticket is kept as a
 * held asset whose winnings nobody is assigned, and its cost moves from reserved to
 * spent, once. The function refuses unless reward operations are paused at
 * --brake-revision and no run holds a live lease. The closed drawing never changes.
 * The command never signs or sends.
 *
 *   SAFE_POOL_RPC_URL=... MEGAPOT_REQUIRED_CONFIRMATIONS=... \
 *   CONTROL_PLANE_POSTGRES_ADMIN_URL=... [SAFE_POOL_PRODUCTION_ENABLED=true] \
 *     bun scripts/safe-pool-recover-late-purchase.ts --attestation <id> [--effect <id>]
 *     bun scripts/safe-pool-recover-late-purchase.ts --attestation <id> --effect <id> \
 *       --apply --brake-revision <n>
 */
import type { ControlPlaneDb, ControlPlaneError } from "@pirate/application";
import { Effect, type Layer } from "effect";
import { makeControlPlaneMegapotDrawingObservationStore } from "../packages/platform-cf/src/megapot-drawing-observation-repository.ts";
import {
  type MegapotV2RpcClient,
  makeMegapotV2RpcClient,
} from "../packages/platform-cf/src/megapot-v2-rpc.ts";
import { makeDirectPostgresControlPlaneLayer } from "../packages/platform-cf/src/postgres.ts";
import { makeRewardSafeLatePurchaseRecovery } from "../packages/platform-cf/src/reward-safe-late-purchase-recovery.ts";
import { normalizePostgresConnectionString } from "./postgres-connection-string.ts";

type RecoveryInput = Readonly<{
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>;
  rpc: MegapotV2RpcClient;
  attestationId: string;
  requiredConfirmations: number;
  productionEnabled: boolean;
  now?: () => number;
}>;

function recovery(input: RecoveryInput) {
  return makeRewardSafeLatePurchaseRecovery({
    layer: input.layer,
    rpc: input.rpc,
    requiredConfirmations: input.requiredConfirmations,
    productionEnabled: input.productionEnabled,
    maximumScanBlocks: 200,
    maximumScanLogs: 200,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}

/** What recovery would do for each held Safe purchase on the attestation; writes nothing. */
export function inspectLateSafePurchases(input: RecoveryInput & { readonly effectId?: string }) {
  return Effect.runPromise(
    recovery(input).inspect({
      attestationId: input.attestationId,
      ...(input.effectId === undefined ? {} : { effectId: input.effectId }),
    }),
  );
}

/** Re-verify one held purchase of the attestation and settle it, or say why not. */
export function recoverLateSafePurchase(
  input: RecoveryInput & { readonly effectId: string; readonly brakeRevision: bigint },
) {
  return Effect.runPromise(
    recovery(input).recover({
      attestationId: input.attestationId,
      effectId: input.effectId,
      brakeRevision: input.brakeRevision,
    }),
  );
}

const json = (value: unknown) =>
  JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item), 2);

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  try {
    const apply = args.includes("--apply");
    const attestationId = option(args, "--attestation");
    const effectId = option(args, "--effect");
    const brakeRevision = option(args, "--brake-revision");
    const expectedLength =
      2 +
      (effectId === undefined ? 0 : 2) +
      (apply ? 1 : 0) +
      (brakeRevision === undefined ? 0 : 2);
    if (
      attestationId === undefined ||
      args.length !== expectedLength ||
      apply !== (brakeRevision !== undefined) ||
      (apply && effectId === undefined) ||
      (brakeRevision !== undefined && !/^[0-9]+$/u.test(brakeRevision))
    ) {
      throw new Error(
        "usage: --attestation <id> [--effect <id>] | --attestation <id> --effect <id> --apply --brake-revision <n>",
      );
    }
    const rpcUrl = new URL(required("SAFE_POOL_RPC_URL"));
    if (rpcUrl.protocol !== "https:" || rpcUrl.username || rpcUrl.password) {
      throw new Error("SAFE_POOL_RPC_URL must be a credential-free HTTPS URL");
    }
    const requiredConfirmations = Number(required("MEGAPOT_REQUIRED_CONFIRMATIONS"));
    const layer = makeDirectPostgresControlPlaneLayer(
      normalizePostgresConnectionString(required("CONTROL_PLANE_POSTGRES_ADMIN_URL")),
    );
    const deployment = await Effect.runPromise(
      makeControlPlaneMegapotDrawingObservationStore(layer).loadCandidate(attestationId),
    );
    const rpc = makeMegapotV2RpcClient({
      rpcUrl: rpcUrl.toString(),
      attestation: {
        attestationId: deployment.attestationId,
        environment: deployment.environment,
        chainId: deployment.chainId,
        jackpotAddress: deployment.jackpotAddress,
        ticketNftAddress: deployment.ticketNftAddress,
        usdcAddress: deployment.usdcAddress,
        custodyAddress: deployment.custodyAddress,
        referrerAddress: deployment.referrerAddress,
        jackpotCodeHash: deployment.jackpotCodeHash,
        ticketNftCodeHash: deployment.ticketNftCodeHash,
        usdcCodeHash: deployment.usdcCodeHash,
      },
    });
    // The chain's contracts must still be the attested ones before any read counts.
    await rpc.attestDeployment();
    const input = {
      layer,
      rpc,
      attestationId,
      requiredConfirmations,
      productionEnabled: process.env.SAFE_POOL_PRODUCTION_ENABLED === "true",
    };
    if (!apply) {
      const assessed = await inspectLateSafePurchases({
        ...input,
        ...(effectId === undefined ? {} : { effectId }),
      });
      console.log(json({ action: "dry-run", assessed }));
    } else {
      const result = await recoverLateSafePurchase({
        ...input,
        effectId: effectId ?? "",
        brakeRevision: BigInt(brakeRevision ?? ""),
      });
      console.log(json({ action: result.kind === "recovered" ? "applied" : "refused", result }));
      if (result.kind !== "recovered") process.exitCode = 2;
    }
  } catch (error) {
    // Driver causes can include connection details; only our own codes are printed.
    const reason =
      typeof error === "object" && error !== null && "reason" in error
        ? String(error.reason)
        : undefined;
    console.error(
      json({
        action: "failed",
        code:
          reason ??
          (error instanceof Error && !error.message.includes("://")
            ? error.message
            : "safe_pool_late_purchase_recovery_failed"),
      }),
    );
    process.exitCode = 1;
  }
}
