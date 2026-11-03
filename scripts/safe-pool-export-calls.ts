/**
 * Writes one Safe Transaction Builder file for each call Pirate has prepared for
 * the owner's Safe and has not yet seen executed. It only reads: it never signs,
 * sends or changes a row.
 *
 * Execute each file as its own Safe transaction. Reconciliation binds a direct call
 * by its target and calldata, so a call executed inside a batch is not recognized.
 * Shared-song purchases require SAFE_POOL_RPC_URL and
 * SAFE_POOL_MINIMUM_ENTRY_SECONDS. Recheck each cached file immediately before
 * execution with verifyPreparedSafeCall and the current run controls.
 *
 *   CONTROL_PLANE_POSTGRES_ADMIN_URL=... \
 *     bun scripts/safe-pool-export-calls.ts --attestation <id> --out <new directory>
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import { Data, Effect, type Layer } from "effect";
import type { MegapotV2DeploymentAttestation } from "../packages/platform-cf/src/megapot-v2.ts";
import {
  type MegapotV2RpcClient,
  makeMegapotV2RpcClient,
} from "../packages/platform-cf/src/megapot-v2-rpc.ts";
import { makeDirectPostgresControlPlaneLayer } from "../packages/platform-cf/src/postgres.ts";
import {
  rewardSafeCall,
  rewardSafeTransactionBuilderFile,
} from "../packages/platform-cf/src/reward-safe-command.ts";
import { makeControlPlaneRewardSafeWorkStore } from "../packages/platform-cf/src/reward-safe-work-repository.ts";
import { verifyPreparedSafeCall } from "../packages/platform-cf/src/shared-song-prepared-purchase.ts";
import { normalizePostgresConnectionString } from "./postgres-connection-string.ts";

class SafePoolExportRefused extends Data.TaggedError("SafePoolExportRefused")<{
  readonly reason: "safe_custody_not_found" | "prepared_call_not_current";
}> {}

export async function exportSafePoolCalls(input: {
  readonly attestationId: string;
  readonly outDirectory: string;
  readonly layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>;
  readonly now?: () => number;
  readonly rpcFor?: (deployment: MegapotV2DeploymentAttestation) => MegapotV2RpcClient;
  readonly minimumEntrySeconds?: number;
}): Promise<readonly string[]> {
  const now = input.now ?? Date.now;
  const { custody, calls } = await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      const attestation = yield* db.execute<Readonly<Record<string, unknown>>>({
        label: "safe-pool-export.attestation.read",
        text: `SELECT attestation.chain_id, attestation.custody_address
                 FROM megapot_deployment_attestations attestation
                 JOIN reward_signer_nonces signer
                   ON signer.chain_id=attestation.chain_id
                  AND signer.signer_address=attestation.custody_address
                WHERE attestation.attestation_id=$1
                  AND signer.nonce_authority='safe_owner_v1'`,
        values: [input.attestationId],
        readonly: true,
      });
      const row = attestation.rows[0];
      if (row === undefined || typeof row.custody_address !== "string") {
        return yield* new SafePoolExportRefused({ reason: "safe_custody_not_found" });
      }
      const custody = {
        attestationId: input.attestationId,
        chainId: Number(row.chain_id),
        safeAddress: row.custody_address,
      };
      const calls = yield* makeControlPlaneRewardSafeWorkStore(input.layer).loadPreparedCalls(
        custody,
      );
      return { custody, calls };
    }).pipe(Effect.provide(input.layer)),
  );
  await mkdir(input.outDirectory, { recursive: true });
  const written: string[] = [];
  for (const [index, call] of calls.entries()) {
    const current = await Effect.runPromise(
      verifyPreparedSafeCall({
        attestationId: input.attestationId,
        call,
        rpcFor: input.rpcFor,
        minimumEntrySeconds: input.minimumEntrySeconds,
        now,
      }).pipe(Effect.provide(input.layer)),
    );
    if (current === null || (current.executeBeforeMs !== null && now() >= current.executeBeforeMs))
      throw new SafePoolExportRefused({ reason: "prepared_call_not_current" });
    const file = rewardSafeTransactionBuilderFile({
      chainId: custody.chainId,
      safeAddress: custody.safeAddress,
      call: rewardSafeCall({ effectId: call.effectId, to: call.to, data: call.data }),
      name: `Pirate ${call.kind} ${call.effectId}`,
      description:
        current.executeBeforeMs === null
          ? `Prepared ${call.kind}. Execute this file alone, not inside a batch.`
          : `Prepared ${call.kind}. Execute this file alone before ${new Date(current.executeBeforeMs).toISOString()}; recheck current drawing and run authority before signing.`,
      createdAtMs: now(),
    });
    const path = join(
      input.outDirectory,
      `${String(index + 1).padStart(3, "0")}-${call.kind}-${call.effectId}.json`,
    );
    // Never overwrite: a second export goes to a new directory.
    await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, { flag: "wx" });
    written.push(path);
  }
  return written;
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const attestationId = args[args.indexOf("--attestation") + 1];
  const outDirectory = args[args.indexOf("--out") + 1];
  const connectionString = process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL;
  if (
    args.length !== 4 ||
    !args.includes("--attestation") ||
    !args.includes("--out") ||
    attestationId === undefined ||
    outDirectory === undefined ||
    !connectionString?.trim()
  ) {
    console.error(
      "usage: CONTROL_PLANE_POSTGRES_ADMIN_URL=... bun scripts/safe-pool-export-calls.ts --attestation <id> --out <new directory>",
    );
    process.exitCode = 1;
  } else {
    try {
      const written = await exportSafePoolCalls({
        attestationId,
        outDirectory,
        layer: makeDirectPostgresControlPlaneLayer(
          normalizePostgresConnectionString(connectionString),
        ),
        ...(process.env.SAFE_POOL_RPC_URL?.trim()
          ? {
              rpcFor: (attestation: MegapotV2DeploymentAttestation) =>
                makeMegapotV2RpcClient({
                  rpcUrl: process.env.SAFE_POOL_RPC_URL?.trim() ?? "",
                  attestation,
                }),
            }
          : {}),
        minimumEntrySeconds: Number(process.env.SAFE_POOL_MINIMUM_ENTRY_SECONDS),
      });
      console.log(JSON.stringify({ written }, null, 2));
    } catch (error) {
      // Driver causes can include connection details. Keep credentials out of output.
      const code =
        typeof error === "object" &&
        error !== null &&
        "reason" in error &&
        error.reason === "safe_custody_not_found"
          ? "safe_custody_not_found"
          : "safe_pool_export_failed";
      console.error(JSON.stringify({ code, success: false }));
      process.exitCode = 1;
    }
  }
}
