import { Effect, Schema } from "effect";
import {
  type ContributionState,
  digestFundingPreimageV2,
  SongContributionFailure,
} from "../../application/src/rewards/song-megapot-contributions.ts";
import type { ReceiptEvidenceV2 } from "../../contracts/src/rewards-song-contributions-v2.ts";
import * as C from "../../contracts/src/rewards-song-contributions-v2.ts";
import type { MegapotV2DeploymentAttestation } from "./megapot-v2.ts";
import { MegapotV2AttestationMismatch, type MegapotV2FullRpcClient } from "./megapot-v2-rpc.ts";

type Rpc = Pick<
  MegapotV2FullRpcClient,
  | "readTransaction"
  | "readReceipt"
  | "readHead"
  | "readBlock"
  | "readFinalizedHead"
  | "readTransactionCount"
>;
/** Selected, attested policy inputs. No finality/skew/page/gas defaults. */
export type FundingReceiptPolicy = Readonly<{
  policyHash: string;
  requiredConfirmations: number;
  maximumClockSkewMs: number;
  maximumObservationAgeMs: number;
}>;
export type FundingPrincipalEvidence = Readonly<{
  receiptId: string;
  contributionId: string;
  category: "pool_principal" | "late_principal";
  evidence: ReceiptEvidenceV2;
  senderAddress: string;
  recipientAddress: string;
  tokenAddress: string;
  instructionHash: string;
  attestationHash: string;
  policyHash: string;
  checkpointBlock: string;
  checkpointHash: string;
  observedConfirmedNonce: string;
  exactInstruction: boolean;
}>;
const failure = (code: SongContributionFailure["code"]) => new SongContributionFailure({ code });
const attestationFailure = (error: unknown) =>
  failure(
    error instanceof MegapotV2AttestationMismatch ? "attestation_unavailable" : "outcome_unknown",
  );
const topic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const addressTopic = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;

/** Incoming attribution only. No signing/refund/nonce allocator. A supplied hash
 * is a locator; actual transaction, canonical receipt/log, timestamp, historical
 * deployment and finality evidence are checked independently. Cancellation has
 * no Transfer evidence and cannot enter this principal path.
 */
export function makeRewardFundingReceiptDiscovery(input: {
  readonly rpc: Rpc;
  readonly policy: FundingReceiptPolicy | null;
  readonly now: () => string;
  readonly verifyHistoricalAttestation:
    | ((state: ContributionState, block: bigint) => Effect.Effect<boolean, SongContributionFailure>)
    | null;
}) {
  const read = <A>(f: () => Promise<A>) =>
    Effect.tryPromise({ try: f, catch: () => failure("outcome_unknown") });
  return Effect.fn("RewardFundingReceiptDiscovery.readCandidate")(function* (
    state: ContributionState,
    transactionHash: string,
  ): Effect.fn.Return<FundingPrincipalEvidence | null, SongContributionFailure> {
    const p = input.policy;
    if (
      p === null ||
      !/^[a-f0-9]{64}$/u.test(p.policyHash) ||
      !Number.isSafeInteger(p.requiredConfirmations) ||
      p.requiredConfirmations <= 0 ||
      !Number.isSafeInteger(p.maximumClockSkewMs) ||
      p.maximumClockSkewMs < 0 ||
      !Number.isSafeInteger(p.maximumObservationAgeMs) ||
      p.maximumObservationAgeMs <= 0 ||
      input.verifyHistoricalAttestation === null
    )
      return yield* failure("policy_unavailable");
    if (!/^0x[a-f0-9]{64}$/u.test(transactionHash)) return yield* failure("invalid_request");
    const observedAt = input.now();
    const observedMs = Date.parse(observedAt);
    if (!Number.isSafeInteger(observedMs)) return yield* failure("observation_stale");
    const i = state.receipt.instruction;
    const tx = yield* read(() => input.rpc.readTransaction(transactionHash));
    const receipt = yield* read(() => input.rpc.readReceipt(transactionHash));
    if (tx === null || receipt === null) return null;
    if (
      tx.transactionHash !== transactionHash ||
      receipt.transactionHash !== transactionHash ||
      tx.chainId !== i.chain_id ||
      receipt.chainId !== i.chain_id ||
      tx.from !== i.from ||
      tx.nonce.toString() !== i.nonce ||
      tx.blockNumber !== receipt.blockNumber ||
      receipt.from !== i.from ||
      receipt.to !== tx.to ||
      receipt.status !== "success"
    )
      return yield* failure("receipt_mismatch");
    const block = yield* read(() => input.rpc.readBlock(receipt.blockNumber));
    const anchor = yield* read(() =>
      input.rpc.readBlock(BigInt(state.receipt.reservation.valid_from_block_exclusive)),
    );
    const head = yield* read(() => input.rpc.readHead());
    const finalized = yield* read(() => input.rpc.readFinalizedHead());
    if (
      block.blockNumber !== receipt.blockNumber ||
      block.blockHash !== receipt.blockHash ||
      anchor.blockHash !== state.anchorBlockHash ||
      receipt.blockNumber <= BigInt(state.receipt.reservation.valid_from_block_exclusive)
    )
      return yield* failure("receipt_mismatch");
    if (
      block.blockTimestamp === undefined ||
      head.blockTimestamp === undefined ||
      finalized.blockTimestamp === undefined
    )
      return yield* failure("attestation_unavailable");
    const inclusionMs = Number(block.blockTimestamp * 1000n);
    const headMs = Number(head.blockTimestamp * 1000n);
    if (
      !Number.isSafeInteger(inclusionMs) ||
      !Number.isSafeInteger(headMs) ||
      inclusionMs > observedMs + p.maximumClockSkewMs ||
      headMs > observedMs + p.maximumClockSkewMs ||
      observedMs - headMs > p.maximumObservationAgeMs
    )
      return yield* failure("observation_stale");
    if (
      receipt.blockNumber > finalized.blockNumber ||
      head.blockNumber - receipt.blockNumber + 1n < BigInt(p.requiredConfirmations)
    )
      return null;
    const finalBlock = yield* read(() => input.rpc.readBlock(finalized.blockNumber));
    if (
      finalBlock.blockHash !== finalized.blockHash ||
      finalBlock.blockTimestamp !== finalized.blockTimestamp
    )
      return yield* failure("receipt_mismatch");
    if (!(yield* input.verifyHistoricalAttestation(state, receipt.blockNumber)))
      return yield* failure("attestation_unavailable");
    const matches = receipt.logs.filter(
      (log) =>
        log.address === i.to_token &&
        log.topics.length === 3 &&
        log.topics[0] === topic &&
        log.topics[1] === addressTopic(i.from) &&
        log.topics[2] === addressTopic(i.recipient_custody),
    );
    if (matches.length !== 1) return yield* failure("receipt_mismatch");
    const log = matches[0];
    if (
      log === undefined ||
      log.removed === true ||
      log.transactionHash !== transactionHash ||
      log.blockHash !== receipt.blockHash ||
      log.blockNumber !== receipt.blockNumber ||
      log.logIndex === undefined ||
      !Number.isSafeInteger(log.logIndex) ||
      log.logIndex < 0 ||
      !/^0x[a-f0-9]{64}$/u.test(log.data)
    )
      return yield* failure("receipt_mismatch");
    const amount = BigInt(log.data);
    if (amount <= 0n) return yield* failure("receipt_mismatch");
    const confirmedNonce = yield* read(() =>
      input.rpc.readTransactionCount(i.from, finalized.blockNumber),
    );
    if (confirmedNonce <= BigInt(i.nonce)) return yield* failure("receipt_mismatch");
    const canonicalAfterProof = yield* read(() => input.rpc.readBlock(receipt.blockNumber));
    if (canonicalAfterProof.blockHash !== receipt.blockHash)
      return yield* failure("receipt_mismatch");
    const exact =
      tx.to === i.to_token &&
      tx.valueWei === 0n &&
      tx.input === i.calldata &&
      amount.toString() === i.amount_atomic;
    const category =
      exact &&
      inclusionMs < Date.parse(state.effectiveDeadline) &&
      inclusionMs < Date.parse(state.receipt.committed_terms.ends_at) &&
      inclusionMs >= Date.parse(state.receipt.committed_terms.starts_at)
        ? "pool_principal"
        : "late_principal";
    return {
      receiptId: `incoming-v2:${i.chain_id}:${transactionHash}:${log.logIndex}`,
      contributionId: state.receipt.contribution_id,
      category,
      evidence: {
        chain_id: i.chain_id,
        transaction_hash: transactionHash,
        transfer_log_index: log.logIndex,
        sender_nonce: i.nonce,
        block_number: receipt.blockNumber.toString(),
        block_hash: receipt.blockHash,
        block_timestamp: new Date(inclusionMs).toISOString(),
        first_observed_at: observedAt,
        finalized_at: observedAt,
        actual_amount_atomic: amount.toString(),
        attestation_id: i.attestation_id,
      },
      senderAddress: i.from,
      recipientAddress: i.recipient_custody,
      tokenAddress: i.to_token,
      instructionHash: i.instruction_hash,
      attestationHash: i.attestation_hash,
      policyHash: p.policyHash,
      checkpointBlock: finalized.blockNumber.toString(),
      checkpointHash: finalized.blockHash,
      observedConfirmedNonce: confirmedNonce.toString(),
      exactInstruction: exact,
    };
  });
}

/** This is the existing accepted deployment at the original instruction, not a
 * new signing authority. SQL supplies/rechecks acceptance, retirement and wallet
 * scope; uncached RPC proves code/config at the exact observation block. */
export type FundingRecoverySource = Readonly<{
  profileId: string;
  profileHash: string;
  validUntil: string;
  policy: C.CancellationRecoveryPolicyV2 | null;
  noncePolicy: { readonly hash: string; readonly maxAgeMs: number };
  deployment: MegapotV2DeploymentAttestation;
  attestationBlock: string;
  attestationBlockHash: string;
}>;
export const FundingRecoveryEvidence = Schema.Struct({
  kind: Schema.Literal("cancellation_recovery_v2"),
  contributionId: C.IdV2,
  stateRevision: C.RevisionV2,
  profileId: C.IdV2,
  profileHash: C.HashV2,
  policyHash: C.HashV2,
  instructionHash: C.HashV2,
  attestationId: C.IdV2,
  attestationHash: C.HashV2,
  chainId: C.ChainV2,
  sender: C.AddressV2,
  walletAssignmentId: C.IdV2,
  token: C.AddressV2,
  custody: C.AddressV2,
  observedAt: C.InstantV2,
  validUntil: C.InstantV2,
  noncePolicyHash: C.HashV2,
  blockNumber: C.UIntV2,
  blockHash: C.TxHashV2,
  blockTimestamp: C.InstantV2,
  confirmedNonce: C.UIntV2,
  pendingNonce: C.UIntV2,
  witnessHash: C.HashV2,
});
export type FundingRecoveryEvidence = typeof FundingRecoveryEvidence.Type;
export const recoveryEvidencePreimage = (e: Omit<FundingRecoveryEvidence, "witnessHash">) =>
  C.fundingHashPreimageV2("pirate.song-megapot-current-recovery.v1", [
    e.kind,
    e.contributionId,
    e.stateRevision,
    e.profileId,
    e.profileHash,
    e.policyHash,
    e.instructionHash,
    e.attestationId,
    e.attestationHash,
    e.chainId,
    e.sender,
    e.walletAssignmentId,
    e.token,
    e.custody,
    e.observedAt,
    e.validUntil,
    e.noncePolicyHash,
    e.blockNumber,
    e.blockHash,
    e.blockTimestamp,
    e.confirmedNonce,
    e.pendingNonce,
  ]);

export function makeMegapotFundingHistoricalVerifier(
  rpc: MegapotV2FullRpcClient,
  attestationBlock: bigint,
  attestationBlockHash: string,
) {
  return Effect.fn("FundingHistoricalAttestation.verify")(function* (
    state: ContributionState,
    block: bigint,
  ) {
    const i = state.receipt.instruction,
      d = rpc.deployment;
    const attest = rpc.attestDeploymentAt;
    if (
      d === undefined ||
      attest === undefined ||
      block < attestationBlock ||
      d.attestationId !== i.attestation_id ||
      d.chainId !== i.chain_id ||
      d.usdcAddress !== i.to_token ||
      d.custodyAddress !== i.recipient_custody
    )
      return false;
    const anchor = yield* Effect.tryPromise({
      try: () => rpc.readBlock(attestationBlock),
      catch: () => failure("outcome_unknown"),
    });
    if (anchor.blockHash !== attestationBlockHash) return false;
    yield* Effect.tryPromise({
      try: () => attest(block),
      catch: attestationFailure,
    });
    return true;
  });
}

/** No I/O is performed by construction. Call outside the database transaction;
 * the resulting immutable evidence is admitted only by the fenced Jobs writer. */
export function makeCurrentFundingRecoveryEvidence(rpc: MegapotV2FullRpcClient, now: () => string) {
  const read = <A>(f: () => Promise<A>) =>
    Effect.tryPromise({ try: f, catch: () => failure("outcome_unknown") });
  return Effect.fn("FundingRecovery.observeCurrent")(function* (
    state: ContributionState,
    source: FundingRecoverySource,
  ) {
    const i = state.receipt.instruction,
      p = source.policy,
      d = source.deployment;
    const attest = rpc.attestDeploymentAt;
    const at = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(C.InstantV2)(now()),
      catch: () => failure("cancellation_recovery_unavailable"),
    });
    if (
      p === null ||
      p.attestation_contract_version !== "megapot-v2-current-recovery-v1" ||
      attest === undefined ||
      d.attestationId !== i.attestation_id ||
      d.chainId !== i.chain_id ||
      d.usdcAddress !== i.to_token ||
      d.custodyAddress !== i.recipient_custody ||
      rpc.deployment === undefined ||
      (
        [
          "attestationId",
          "chainId",
          "jackpotAddress",
          "ticketNftAddress",
          "usdcAddress",
          "custodyAddress",
          "jackpotCodeHash",
          "ticketNftCodeHash",
          "usdcCodeHash",
        ] as const
      ).some((k) => rpc.deployment?.[k] !== d[k]) ||
      state.nonceFinalized ||
      p.chain_id !== i.chain_id ||
      at < p.valid_from ||
      at >= p.valid_until ||
      at >= source.validUntil ||
      !Number.isSafeInteger(source.noncePolicy.maxAgeMs) ||
      source.noncePolicy.maxAgeMs <= 0 ||
      (yield* digestFundingPreimageV2(C.cancellationPolicyPreimageV2(p))) !== p.policy_hash
    )
      return yield* failure("cancellation_recovery_unavailable");
    const head = yield* read(() => rpc.readHead());
    const attestationAnchor = yield* read(() => rpc.readBlock(BigInt(source.attestationBlock)));
    if (attestationAnchor.blockHash !== source.attestationBlockHash)
      return yield* failure("cancellation_recovery_unavailable");
    if (head.blockTimestamp === undefined || head.blockNumber < BigInt(source.attestationBlock))
      return yield* failure("cancellation_recovery_unavailable");
    yield* Effect.tryPromise({
      try: () => attest(head.blockNumber),
      catch: attestationFailure,
    });
    const confirmed = yield* read(() => rpc.readTransactionCount(i.from, head.blockNumber));
    const pending = yield* read(() => rpc.readPendingNonce(i.from));
    const after = yield* read(() => rpc.readHead());
    const observed = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(C.InstantV2)(now()),
      catch: () => failure("cancellation_recovery_unavailable"),
    });
    const headMs = Number(head.blockTimestamp * 1000n),
      observedMs = Date.parse(observed);
    if (
      head.blockHash !== after.blockHash ||
      head.blockNumber !== after.blockNumber ||
      head.blockTimestamp !== after.blockTimestamp ||
      confirmed !== BigInt(i.nonce) ||
      pending < confirmed ||
      !Number.isSafeInteger(headMs) ||
      headMs > observedMs ||
      observedMs - headMs > source.noncePolicy.maxAgeMs ||
      observed < at
    )
      return yield* failure("cancellation_recovery_unavailable");
    const validUntil = new Date(
      Math.min(
        Date.parse(source.validUntil),
        Date.parse(p.valid_until),
        observedMs + source.noncePolicy.maxAgeMs,
        headMs + source.noncePolicy.maxAgeMs,
      ),
    ).toISOString();
    if (validUntil <= observed) return yield* failure("cancellation_recovery_unavailable");
    const e = {
      kind: "cancellation_recovery_v2" as const,
      contributionId: state.receipt.contribution_id,
      stateRevision: state.revision,
      profileId: source.profileId,
      profileHash: source.profileHash,
      policyHash: p.policy_hash,
      instructionHash: i.instruction_hash,
      attestationId: i.attestation_id,
      attestationHash: i.attestation_hash,
      chainId: i.chain_id,
      sender: i.from,
      walletAssignmentId: i.wallet_assignment_id,
      token: i.to_token,
      custody: i.recipient_custody,
      observedAt: observed,
      validUntil,
      noncePolicyHash: source.noncePolicy.hash,
      blockNumber: head.blockNumber.toString(),
      blockHash: head.blockHash,
      blockTimestamp: new Date(headMs).toISOString(),
      confirmedNonce: confirmed.toString(),
      pendingNonce: pending.toString(),
    };
    return yield* Effect.try({
      try: () =>
        Schema.decodeUnknownSync(FundingRecoveryEvidence)({ ...e, witnessHash: "0".repeat(64) }),
      catch: () => failure("cancellation_recovery_unavailable"),
    }).pipe(
      Effect.flatMap((parsed) =>
        digestFundingPreimageV2(recoveryEvidencePreimage(parsed)).pipe(
          Effect.map((witnessHash) => ({ ...parsed, witnessHash })),
        ),
      ),
    );
  });
}
