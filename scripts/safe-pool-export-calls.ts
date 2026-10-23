/**
 * Writes one Safe Transaction Builder file for each call Pirate has prepared for
 * the owner's Safe and has not yet seen executed. It only reads: it never signs,
 * sends or changes a row.
 *
 * Execute each file as its own Safe transaction. Reconciliation binds a direct call
 * by its target and calldata, so a call executed inside a batch is not recognized.
 *
 *   CONTROL_PLANE_POSTGRES_ADMIN_URL=... \
 *     bun scripts/safe-pool-export-calls.ts --attestation <id> --out <new directory>
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import { Data, Effect, type Layer } from "effect";
import { makeDirectPostgresControlPlaneLayer } from "../packages/platform-cf/src/postgres.ts";
import {
  rewardSafeCall,
  rewardSafeTransactionBuilderFile,
} from "../packages/platform-cf/src/reward-safe-command.ts";
import { makeControlPlaneRewardSafeWorkStore } from "../packages/platform-cf/src/reward-safe-work-repository.ts";
import { normalizePostgresConnectionString } from "./postgres-connection-string.ts";

class SafePoolExportRefused extends Data.TaggedError("SafePoolExportRefused")<{
  readonly reason: "safe_custody_not_found";
}> {}

export async function exportSafePoolCalls(input: {
  readonly attestationId: string;
  readonly outDirectory: string;
  readonly layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>;
  readonly now?: () => number;
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
    const file = rewardSafeTransactionBuilderFile({
      safeAddress: custody.safeAddress,
      call: rewardSafeCall({ effectId: call.effectId, to: call.to, data: call.data }),
      name: `Pirate ${call.kind} ${call.effectId}`,
      description: `Prepared ${call.kind}. Execute this file alone, not inside a batch.`,
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
