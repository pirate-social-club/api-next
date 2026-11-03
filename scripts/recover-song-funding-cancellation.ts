/** Exceptional Base Sepolia recovery. The default only inspects one original
 * cancellation. --apply freshly verifies finalized nonce consumption, then
 * closes its held reservation once under the paused/no-live-run SQL guard.
 * This command cannot prepare, grant, sign, send, or replace a contribution.
 *
 * API_NEXT_ENV=staging SAFE_POOL_RPC_URL=... CONTROL_PLANE_POSTGRES_ADMIN_URL=...
 * bun scripts/recover-song-funding-cancellation.ts --contribution <id> --transaction <hash>
 * Add --apply --expected-revision <n> --brake-revision <n> to commit completion.
 */
import { Effect, Schema } from "effect";
import { Client } from "pg";
import * as C from "../packages/contracts/src/rewards-song-contributions-v2.ts";
import { makeControlPlaneMegapotDrawingObservationStore } from "../packages/platform-cf/src/megapot-drawing-observation-repository.ts";
import { makeMegapotV2RpcClient } from "../packages/platform-cf/src/megapot-v2-rpc.ts";
import { makeDirectPostgresControlPlaneLayer } from "../packages/platform-cf/src/postgres.ts";
import {
  cancellationOriginalSchema,
  type FundingCancellationProof,
  fundingCancellationProofSchema,
  verifyFundingCancellation,
} from "../packages/platform-cf/src/song-funding-cancellation-proof.ts";
import { normalizePostgresConnectionString } from "./postgres-connection-string.ts";

const positive = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const natural = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const packetSchema = Schema.Struct({
  original: cancellationOriginalSchema,
  revision: natural,
  brakeRevision: Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]*)$/u)),
  policy: Schema.Struct({
    policyHash: C.HashV2,
    requiredConfirmations: positive,
    maximumObservationAgeMs: positive,
    maximumClockSkewMs: natural,
  }),
});
const completionSchema = Schema.Struct({
  proof_id: C.IdV2,
  contribution_id: C.IdV2,
  nonce_lease_id: C.IdV2,
  chain_id: Schema.Literal(84532),
  sender_address: C.AddressV2,
  nonce: C.UIntV2,
  transaction_hash: C.TxHashV2,
  evidence: fundingCancellationProofSchema,
  created_at: Schema.String,
});
function checkedCompletion(value: unknown, proof: FundingCancellationProof) {
  const packet = Schema.decodeUnknownSync(completionSchema)(value),
    stored = packet.evidence;
  const frozen = [
    "proofId",
    "contributionId",
    "nonceLeaseId",
    "instructionHash",
    "cancellationInstructionHash",
    "preparationId",
    "grantId",
    "chainId",
    "sender",
    "nonce",
    "transactionHash",
    "blockNumber",
    "blockHash",
    "blockTimestamp",
    "policyHash",
    "requiredConfirmations",
  ] as const;
  if (
    packet.proof_id !== proof.proofId ||
    packet.contribution_id !== proof.contributionId ||
    packet.nonce_lease_id !== proof.nonceLeaseId ||
    packet.sender_address !== proof.sender ||
    packet.nonce !== proof.nonce ||
    packet.transaction_hash !== proof.transactionHash ||
    frozen.some((key) => stored[key] !== proof[key]) ||
    BigInt(stored.confirmedNonce) <= BigInt(proof.nonce) ||
    BigInt(stored.checkpointBlock) < BigInt(stored.blockNumber)
  )
    throw Error("cancellation_completion_mismatch");
  return packet;
}

type Sql = Pick<Client, "query">;
export type CancellationRecoveryOptions = Readonly<{
  contributionId: string;
  transactionHash: string;
  apply: boolean;
  expectedRevision?: string;
  brakeRevision?: string;
}>;

export function cancellationRecoveryOptions(args: readonly string[]): CancellationRecoveryOptions {
  const values = new Map<string, string>();
  let apply = false;
  for (let n = 0; n < args.length; n++) {
    const name = args[n];
    if (name === "--apply" && !apply) {
      apply = true;
      continue;
    }
    if (
      !name ||
      !["--contribution", "--transaction", "--expected-revision", "--brake-revision"].includes(
        name,
      ) ||
      values.has(name)
    )
      throw Error("cancellation_arguments_invalid");
    const value = args[++n];
    if (!value || value.startsWith("--")) throw Error("cancellation_arguments_invalid");
    values.set(name, value);
  }
  const contributionId = Schema.decodeUnknownSync(C.IdV2)(values.get("--contribution"));
  const transactionHash = Schema.decodeUnknownSync(C.TxHashV2)(values.get("--transaction"));
  const expectedRevision = values.get("--expected-revision"),
    brakeRevision = values.get("--brake-revision");
  if (
    apply !== (expectedRevision !== undefined && brakeRevision !== undefined) ||
    (!apply && (expectedRevision !== undefined || brakeRevision !== undefined)) ||
    [expectedRevision, brakeRevision].some(
      (x) => x !== undefined && !/^(0|[1-9][0-9]{0,15})$/u.test(x),
    )
  )
    throw Error("cancellation_arguments_invalid");
  return {
    contributionId,
    transactionHash,
    apply,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    ...(brakeRevision === undefined ? {} : { brakeRevision }),
  };
}

/** The verifier is always invoked anew, including after an earlier inspection.
 * A lost COMMIT acknowledgement remains unknown; no automatic retry is made. */
export async function completeFundingCancellation(input: {
  db: Sql;
  options: CancellationRecoveryOptions;
  verify: () => Promise<FundingCancellationProof>;
}) {
  const proof = await input.verify();
  if (
    proof.contributionId !== input.options.contributionId ||
    proof.transactionHash !== input.options.transactionHash
  )
    throw Error("cancellation_identity_mismatch");
  if (!input.options.apply) return { action: "dry-run" as const, proof };
  if (input.options.expectedRevision === undefined || input.options.brakeRevision === undefined)
    throw Error("cancellation_arguments_invalid");
  await input.db.query("BEGIN");
  let committing = false;
  try {
    const result = await input.db.query<{ packet: unknown }>(
      "SELECT recover_song_funding_cancellation_v2($1::jsonb,$2::bigint,$3::bigint) AS packet",
      [JSON.stringify(proof), input.options.expectedRevision, input.options.brakeRevision],
    );
    if (result.rows.length !== 1) throw Error("cancellation_completion_failed");
    const packet = checkedCompletion(result.rows[0]?.packet, proof);
    committing = true;
    await input.db.query("COMMIT");
    return { action: "applied" as const, result: packet, proof };
  } catch (error) {
    if (committing) throw Error("cancellation_completion_outcome_unknown");
    try {
      await input.db.query("ROLLBACK");
    } catch {
      throw Error("cancellation_completion_outcome_unknown");
    }
    throw error;
  }
}

if (import.meta.main) {
  let db: Client | undefined;
  try {
    const options = cancellationRecoveryOptions(Bun.argv.slice(2));
    if (process.env.API_NEXT_ENV !== "staging") throw Error("cancellation_staging_only");
    const connection = process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL;
    if (!connection) throw Error("cancellation_database_unavailable");
    const rpcUrl = new URL(process.env.SAFE_POOL_RPC_URL ?? "");
    if (rpcUrl.protocol !== "https:" || rpcUrl.username || rpcUrl.password)
      throw Error("cancellation_rpc_unavailable");
    const connectionString = normalizePostgresConnectionString(connection);
    db = new Client({ connectionString, connectionTimeoutMillis: 10_000, query_timeout: 15_000 });
    await db.connect();
    const loaded = await db.query<{ packet: unknown }>(
      `SELECT jsonb_build_object(
      'original',jsonb_build_object('receipt',c.state->'receipt','anchorBlockHash',c.state->'anchorBlockHash',
        'cancellationHead',c.state->'cancellationHead','cancellationGrant',c.state->'cancellationGrant'),
      'revision',c.state->'revision','brakeRevision',b.revision::text,'policy',p.policy->'reconciliation'->'receipt') packet
      FROM song_megapot_contributions_v2 c JOIN reward_funding_profiles_v2 p ON p.profile_id=c.profile_id
      CROSS JOIN reward_operations_control b WHERE c.contribution_id=$1 AND b.singleton`,
      [options.contributionId],
    );
    if (loaded.rows.length !== 1) throw Error("cancellation_original_unavailable");
    const packet = Schema.decodeUnknownSync(packetSchema)(loaded.rows[0]?.packet);
    const layer = makeDirectPostgresControlPlaneLayer(connectionString);
    const deployment = await Effect.runPromise(
      makeControlPlaneMegapotDrawingObservationStore(layer).loadCandidate(
        packet.original.receipt.instruction.attestation_id,
      ),
    );
    if (deployment.environment !== "staging" || deployment.chainId !== 84532)
      throw Error("cancellation_staging_only");
    const rpc = makeMegapotV2RpcClient({ rpcUrl: rpcUrl.toString(), attestation: deployment });
    await rpc.attestDeployment();
    const result = await completeFundingCancellation({
      db,
      options,
      verify: () =>
        verifyFundingCancellation({
          original: packet.original,
          transactionHash: options.transactionHash,
          rpc,
          policy: packet.policy,
          now: () => new Date().toISOString(),
        }),
    });
    console.log(
      JSON.stringify({
        ...result,
        expectedRevision: packet.revision,
        brakeRevision: packet.brakeRevision,
      }),
    );
  } catch (error) {
    // Driver exceptions and causes can contain credentials. Print only owned codes.
    const message = error instanceof Error ? error.message : "";
    const code = /^cancellation_[a-z_]+$/u.test(message)
      ? message
      : "cancellation_completion_failed";
    console.error(
      JSON.stringify({ action: code.endsWith("outcome_unknown") ? "unknown" : "refused", code }),
    );
    process.exitCode = 1;
  } finally {
    await db?.end().catch(() => undefined);
  }
}
