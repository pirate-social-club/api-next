import { Effect, Schema } from "effect";
import { digestFundingPreimageV2 } from "../../application/src/rewards/song-megapot-contributions.ts";
import * as C from "../../contracts/src/rewards-song-contributions-v2.ts";
import type { MegapotV2FullRpcClient } from "./megapot-v2-rpc.ts";
import type { FundingReceiptPolicy } from "./reward-funding-receipt-discovery.ts";

export const cancellationOriginalSchema = Schema.Struct({
  receipt: C.ContributionReceiptV2,
  anchorBlockHash: C.TxHashV2,
  cancellationHead: C.CancellationReceiptV2,
  cancellationGrant: C.SubmissionClaimReceiptV2,
});
type Original = typeof cancellationOriginalSchema.Type;

export const fundingCancellationProofSchema = Schema.Struct({
  proofId: C.IdV2,
  contributionId: C.IdV2,
  nonceLeaseId: C.IdV2,
  instructionHash: C.HashV2,
  cancellationInstructionHash: C.HashV2,
  preparationId: C.IdV2,
  grantId: C.IdV2,
  chainId: Schema.Literal(84532),
  sender: C.AddressV2,
  nonce: C.UIntV2,
  transactionHash: C.TxHashV2,
  blockNumber: C.UIntV2,
  blockHash: C.TxHashV2,
  blockTimestamp: C.InstantV2,
  checkpointBlock: C.UIntV2,
  checkpointHash: C.TxHashV2,
  confirmedNonce: C.UIntV2,
  policyHash: C.HashV2,
  requiredConfirmations: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  observedAt: C.InstantV2,
});
export type FundingCancellationProof = typeof fundingCancellationProofSchema.Type;

/** Exceptional operator evidence only. This reader cannot sign, broadcast,
 * grant a purpose, release work or decide that a missing transaction failed. */
export async function verifyFundingCancellation(input: {
  original: Original;
  rpc: Pick<
    MegapotV2FullRpcClient,
    | "readTransaction"
    | "readReceipt"
    | "readHead"
    | "readFinalizedHead"
    | "readBlock"
    | "readTransactionCount"
  >;
  transactionHash: string;
  policy: FundingReceiptPolicy;
  now: () => string;
}): Promise<FundingCancellationProof> {
  const original = Schema.decodeUnknownSync(cancellationOriginalSchema)(input.original);
  const { receipt: r, cancellationHead: plan, cancellationGrant: grant } = original;
  const i = r.instruction;
  function refuse(reason: string): never {
    throw new Error(reason);
  }
  const p = input.policy;
  if (
    i.chain_id !== 84532 ||
    !/^[a-f0-9]{64}$/u.test(p.policyHash) ||
    !Number.isSafeInteger(p.requiredConfirmations) ||
    p.requiredConfirmations <= 0 ||
    !Number.isSafeInteger(p.maximumObservationAgeMs) ||
    p.maximumObservationAgeMs <= 0 ||
    !Number.isSafeInteger(p.maximumClockSkewMs) ||
    p.maximumClockSkewMs < 0
  )
    refuse("cancellation_policy_unavailable");
  const hash = Schema.decodeUnknownSync(C.TxHashV2)(input.transactionHash);
  if (
    plan.contribution_id !== r.contribution_id ||
    plan.original_funding_instruction_hash !== i.instruction_hash ||
    plan.chain_id !== i.chain_id ||
    plan.sender !== i.from ||
    plan.recipient !== i.from ||
    plan.nonce !== i.nonce ||
    plan.value_atomic !== "0" ||
    plan.data !== "0x" ||
    plan.wallet_assignment_id !== i.wallet_assignment_id ||
    plan.wallet_index !== i.wallet_index ||
    grant.purpose !== "nonce_cancellation" ||
    grant.contribution_id !== r.contribution_id ||
    grant.instruction_hash !== plan.instruction_hash ||
    grant.cancellation_preparation_id !== plan.preparation_id ||
    grant.cancellation_preparation_revision !== plan.preparation_revision ||
    grant.valid_until !== plan.dispatch_expires_at ||
    grant.claimed_at < plan.prepared_at ||
    grant.claimed_at >= plan.dispatch_expires_at ||
    (await Effect.runPromise(
      digestFundingPreimageV2(C.cancellationInstructionPreimageV2(plan)),
    )) !== plan.instruction_hash
  )
    refuse("cancellation_identity_mismatch");
  const { rpc } = input;
  const started = Schema.decodeUnknownSync(C.InstantV2)(input.now());
  const tx = await rpc.readTransaction(hash),
    receipt = await rpc.readReceipt(hash);
  if (tx === null || receipt === null) refuse("cancellation_outcome_unknown");
  if (
    tx.transactionHash !== hash ||
    receipt.transactionHash !== hash ||
    tx.chainId !== i.chain_id ||
    receipt.chainId !== i.chain_id ||
    tx.from !== i.from ||
    tx.to !== i.from ||
    tx.nonce.toString() !== i.nonce ||
    tx.valueWei !== 0n ||
    tx.input !== "0x" ||
    receipt.from !== i.from ||
    receipt.to !== i.from ||
    receipt.status !== "success" ||
    tx.blockNumber !== receipt.blockNumber ||
    receipt.logs.length !== 0
  )
    refuse("cancellation_transaction_mismatch");
  const block = await rpc.readBlock(receipt.blockNumber);
  const anchor = await rpc.readBlock(BigInt(r.reservation.valid_from_block_exclusive));
  const head = await rpc.readHead(),
    finalized = await rpc.readFinalizedHead();
  if (
    block.blockNumber !== receipt.blockNumber ||
    block.blockHash !== receipt.blockHash ||
    anchor.blockNumber !== BigInt(r.reservation.valid_from_block_exclusive) ||
    anchor.blockHash !== original.anchorBlockHash ||
    receipt.blockNumber <= anchor.blockNumber ||
    block.blockTimestamp === undefined ||
    head.blockTimestamp === undefined ||
    finalized.blockTimestamp === undefined
  )
    refuse("cancellation_canonicality_unproven");
  if (
    finalized.blockNumber < receipt.blockNumber ||
    head.blockNumber < finalized.blockNumber ||
    head.blockNumber - receipt.blockNumber + 1n < BigInt(p.requiredConfirmations)
  )
    refuse("cancellation_not_finalized");
  const confirmed = await rpc.readTransactionCount(i.from, finalized.blockNumber);
  const finalAfter = await rpc.readBlock(finalized.blockNumber);
  const blockAfter = await rpc.readBlock(receipt.blockNumber);
  const observedAt = Schema.decodeUnknownSync(C.InstantV2)(input.now());
  const observed = Date.parse(observedAt),
    included = Number(block.blockTimestamp * 1000n),
    headAt = Number(head.blockTimestamp * 1000n),
    finalAt = Number(finalized.blockTimestamp * 1000n);
  if (
    confirmed <= BigInt(i.nonce) ||
    finalAfter.blockNumber !== finalized.blockNumber ||
    finalAfter.blockHash !== finalized.blockHash ||
    finalAfter.blockTimestamp !== finalized.blockTimestamp ||
    blockAfter.blockNumber !== block.blockNumber ||
    blockAfter.blockHash !== block.blockHash ||
    blockAfter.blockTimestamp !== block.blockTimestamp
  )
    refuse("cancellation_canonicality_unproven");
  if (
    ![included, headAt, finalAt].every(Number.isSafeInteger) ||
    observedAt < started ||
    included < Date.parse(plan.prepared_at) ||
    included > observed + p.maximumClockSkewMs ||
    finalAt < included ||
    finalAt > headAt ||
    headAt > observed + p.maximumClockSkewMs ||
    observed - headAt > p.maximumObservationAgeMs
  )
    refuse("cancellation_observation_stale");
  // A mined cancellation may be later than the dispatch window. Its actual
  // finalized nonce consumption remains evidence; the grant is never renewed.
  return Schema.decodeUnknownSync(fundingCancellationProofSchema)({
    proofId: `funding-cancel-v2:${i.chain_id}:${hash}`,
    contributionId: r.contribution_id,
    nonceLeaseId: r.reservation.nonce_lease_id,
    instructionHash: i.instruction_hash,
    cancellationInstructionHash: plan.instruction_hash,
    preparationId: plan.preparation_id,
    grantId: grant.grant_id,
    chainId: i.chain_id,
    sender: i.from,
    nonce: i.nonce,
    transactionHash: hash,
    blockNumber: block.blockNumber.toString(),
    blockHash: block.blockHash,
    blockTimestamp: new Date(included).toISOString(),
    checkpointBlock: finalized.blockNumber.toString(),
    checkpointHash: finalized.blockHash,
    confirmedNonce: confirmed.toString(),
    policyHash: p.policyHash,
    requiredConfirmations: p.requiredConfirmations,
    observedAt,
  });
}
