import {
  type ControlPlaneError,
  type ControlPlaneTransaction,
  type RewardWinnerSendNonceReader,
  RewardWinnerSendRejected,
  RewardWinnerSendStorageFailed,
} from "@pirate/application";
import { Effect, Schema } from "effect";
import { AddressV2, HashV2, IdV2 } from "../../contracts/src/rewards-song-contributions-v2.ts";

// This subset deliberately retains the existing PostgreSQL BIGINT representation.
// It is not an economic cap, gas policy or a second custody-signer allocator.
const Nonce = Schema.BigInt.check(
  Schema.makeFilter((n) => (n >= 0n && n <= 9223372036854775807n ? undefined : "Invalid nonce")),
);
const Natural = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const Positive = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));
const Sender = Schema.Struct({ chainId: Positive, senderAddress: AddressV2 });
type Sender = typeof Sender.Type;

export class RewardWalletNonceUnavailable extends Schema.TaggedError<RewardWalletNonceUnavailable>()(
  "RewardWalletNonceUnavailable",
  {
    code: Schema.Literals([
      "invalid_input",
      "policy_unavailable",
      "witness_stale",
      "witness_incoherent",
      "wallet_nonce_busy",
      "nonce_not_consumed",
      "foreign_owner",
      "invalid_row",
    ]),
  },
) {}
const refuse = (code: RewardWalletNonceUnavailable["code"]) =>
  new RewardWalletNonceUnavailable({ code });
const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown) =>
  Effect.try({
    try: () =>
      Schema.decodeUnknownSync(schema, {
        onExcessProperty: "error",
      })(input),
    catch: () => refuse("invalid_input"),
  });

/** Same transaction/lock namespace as the original winner repository. */
export const lockRewardWalletNonceSenderIn = Effect.fn("RewardWalletNonceAuthority.lockSenderIn")(
  function* (transaction: ControlPlaneTransaction, input: Sender) {
    const sender = yield* decode(Sender, input);
    yield* transaction.execute({
      label: "reward-wallet-nonce.sender.lock",
      text: "SELECT lock_reward_wallet_nonce_sender_v2($1,$2)",
      values: [sender.chainId, sender.senderAddress],
      readonly: false,
    });
  },
);

const Head = Schema.Struct({
  highest_nonce: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[0-9]+$/u))),
  blocked_reason: Schema.NullOr(
    Schema.Literals(["unknown_v1_funding", "other_instruction", "outstanding_nonce"]),
  ),
});
const readHeadIn = Effect.fn("RewardWalletNonceAuthority.readHeadIn")(function* (
  transaction: ControlPlaneTransaction,
  sender: Sender,
) {
  const result = yield* transaction.execute({
    label: "reward-wallet-nonce.history.read",
    text: `SELECT highest_nonce::text AS highest_nonce, blocked_reason
               FROM reward_wallet_nonce_context_v2($1,$2,NULL)`,
    values: [sender.chainId, sender.senderAddress],
    readonly: false,
  });
  if (result.rows.length !== 1) return yield* refuse("invalid_row");
  const head = yield* decode(Head, result.rows[0]).pipe(
    Effect.mapError(() => refuse("invalid_row")),
  );
  const highest = head.highest_nonce === null ? null : BigInt(head.highest_nonce);
  if (highest !== null && !Schema.is(Nonce)(highest)) return yield* refuse("invalid_row");
  return { highest, blockedReason: head.blocked_reason };
});

/** Original winner API: one bigint reader under the lock, strictly above history.
 * This is NOT a coherent confirmed/pending V2 funding witness. SQL records the
 * exact lease atomically when the guarded winner attempt is inserted. Original
 * credit/account/attempt/payment guards continue to run without replacement.
 */
export const reserveRewardWinnerWalletNonceIn = Effect.fn(
  "RewardWalletNonceAuthority.reserveWinnerIn",
)(
  function* (
    transaction: ControlPlaneTransaction,
    input: Sender & { readonly readNonce: RewardWinnerSendNonceReader },
  ) {
    yield* lockRewardWalletNonceSenderIn(transaction, {
      chainId: input.chainId,
      senderAddress: input.senderAddress,
    });
    const head = yield* readHeadIn(transaction, input);
    if (head.blockedReason !== null)
      return yield* new RewardWinnerSendRejected({ reason: "sender-busy" });
    const nonce = yield* input.readNonce;
    if (!Schema.is(Nonce)(nonce) || (head.highest !== null && nonce <= head.highest))
      return yield* new RewardWinnerSendRejected({ reason: "nonce-not-consumed" });
    return nonce;
  },
  Effect.catchTag("RewardWalletNonceUnavailable", () =>
    Effect.fail(new RewardWinnerSendStorageFailed({ reason: "invalid-row" })),
  ),
);

const FundingOwner = Schema.Struct({
  leaseId: IdV2,
  ownerId: IdV2,
  commandId: IdV2,
  accountId: IdV2,
  personaId: IdV2,
  walletAssignmentId: IdV2,
  chainId: Positive,
  senderAddress: AddressV2,
  requestHash: HashV2,
});
export type RewardFundingNonceOwner = typeof FundingOwner.Type;

const FundingReservation = Schema.Struct({
  owner: FundingOwner,
  nonce: Nonce,
  nowMs: Natural,
  policy: Schema.NullOr(Schema.Struct({ hash: HashV2, maxAgeMs: Positive })),
  witness: Schema.Struct({
    id: HashV2,
    chainId: Positive,
    senderAddress: AddressV2,
    observedAtMs: Natural,
    confirmed: Schema.Struct({ nonce: Nonce, blockNumber: Nonce, blockHash: HashV2 }),
    pending: Schema.Struct({ nonce: Nonce, baseBlockNumber: Nonce, baseBlockHash: HashV2 }),
  }),
});
export type RewardFundingNonceReservation = typeof FundingReservation.Type;

const LeaseRow = Schema.Struct({
  lease_id: IdV2,
  owner_id: IdV2,
  command_id: IdV2,
  account_id: IdV2,
  persona_id: IdV2,
  wallet_assignment_id: IdV2,
  chain_id: Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/u)),
  sender_address: AddressV2,
  request_hash: HashV2,
  nonce: Schema.String.check(Schema.isPattern(/^[0-9]+$/u)),
});
const LEASE_COLUMNS = `lease_id, owner_id, command_id, account_id, persona_id,
  wallet_assignment_id, chain_id::text, sender_address, request_hash, nonce::text`;

const decodeLease = Effect.fn("RewardWalletNonceAuthority.decodeLease")(function* (
  row: unknown,
  expected: RewardFundingNonceOwner,
) {
  const lease = yield* decode(LeaseRow, row).pipe(Effect.mapError(() => refuse("invalid_row")));
  if (
    lease.lease_id !== expected.leaseId ||
    lease.owner_id !== expected.ownerId ||
    lease.command_id !== expected.commandId ||
    lease.account_id !== expected.accountId ||
    lease.persona_id !== expected.personaId ||
    lease.wallet_assignment_id !== expected.walletAssignmentId ||
    lease.chain_id !== String(expected.chainId) ||
    lease.sender_address !== expected.senderAddress ||
    lease.request_hash !== expected.requestHash
  )
    return yield* refuse("foreign_owner");
  const nonce = BigInt(lease.nonce);
  if (!Schema.is(Nonce)(nonce)) return yield* refuse("invalid_row");
  return { owner: expected, nonce, authority: "nonce_ownership_only" as const };
});

const mapSqlRefusal = <A, R>(effect: Effect.Effect<A, ControlPlaneError, R>) =>
  effect.pipe(
    Effect.mapError((error) => {
      if (error._tag !== "ControlPlaneStatementFailed") return error;
      const code = {
        PWN01: "foreign_owner",
        PWN02: "wallet_nonce_busy",
        PWN03: "nonce_not_consumed",
        PWN04: "witness_stale",
      } as const;
      const known = error.sqlState === null ? undefined : code[error.sqlState as keyof typeof code];
      return known === undefined ? error : refuse(known);
    }),
  );

/** Allocation only, on the caller's existing transaction. Owned immutable
 * command replay precedes this function. The witness and freshness policy
 * must come from accepted server-owned ports, never browser assertions.
 * There is no policy default, provider read, signature, fee or grant here.
 * SQL repeats freshness/ownership/history validation after the sender lock.
 */
export const reserveRewardFundingWalletNonceIn = Effect.fn(
  "RewardWalletNonceAuthority.reserveFundingIn",
)(function* (transaction: ControlPlaneTransaction, input: RewardFundingNonceReservation) {
  const i = yield* decode(FundingReservation, input);
  if (i.policy === null) return yield* refuse("policy_unavailable");
  const w = i.witness;
  if (
    w.chainId !== i.owner.chainId ||
    w.senderAddress !== i.owner.senderAddress ||
    w.confirmed.blockNumber !== w.pending.baseBlockNumber ||
    w.confirmed.blockHash !== w.pending.baseBlockHash ||
    w.confirmed.nonce !== w.pending.nonce ||
    i.nonce !== w.confirmed.nonce
  )
    return yield* refuse("witness_incoherent");
  if (w.observedAtMs > i.nowMs || i.nowMs - w.observedAtMs > i.policy.maxAgeMs)
    return yield* refuse("witness_stale");
  yield* lockRewardWalletNonceSenderIn(transaction, {
    chainId: i.owner.chainId,
    senderAddress: i.owner.senderAddress,
  });
  const head = yield* readHeadIn(transaction, i.owner);
  if (head.blockedReason !== null) return yield* refuse("wallet_nonce_busy");
  if (head.highest !== null && i.nonce <= head.highest) return yield* refuse("nonce_not_consumed");
  const p = {
    lease_id: i.owner.leaseId,
    owner_id: i.owner.ownerId,
    command_id: i.owner.commandId,
    account_id: i.owner.accountId,
    persona_id: i.owner.personaId,
    wallet_assignment_id: i.owner.walletAssignmentId,
    chain_id: i.owner.chainId,
    sender_address: i.owner.senderAddress,
    request_hash: i.owner.requestHash,
    nonce: i.nonce.toString(),
    witness_id: w.id,
    observed_at_ms: w.observedAtMs,
    confirmed_block: w.confirmed.blockNumber.toString(),
    confirmed_block_hash: w.confirmed.blockHash,
    pending_base_block: w.pending.baseBlockNumber.toString(),
    pending_base_hash: w.pending.baseBlockHash,
    confirmed_nonce: w.confirmed.nonce.toString(),
    pending_nonce: w.pending.nonce.toString(),
    freshness_policy_hash: i.policy.hash,
    max_age_ms: i.policy.maxAgeMs,
  };
  const result = yield* mapSqlRefusal(
    transaction.execute({
      label: "reward-wallet-nonce.funding.reserve",
      text: `SELECT ${LEASE_COLUMNS} FROM reserve_reward_funding_wallet_nonce_v2($1::jsonb)`,
      values: [JSON.stringify(p)],
      readonly: false,
    }),
  );
  if (result.rows.length !== 1) return yield* refuse("invalid_row");
  const lease = yield* decodeLease(result.rows[0], i.owner);
  if (lease.nonce !== i.nonce) return yield* refuse("invalid_row");
  return lease;
});

/** Private original-owner lookup, including for cancellation/replacement.
 * This returns NO submission authorization. A purpose-specific, consumed-once
 * command/grant and its immutable cancellation plan must still be enforced by
 * the later V2 persistence/application integration. Never reserve a new nonce
 * for cancellation, never restore a consumed grant from this read, and never
 * interpret the lease or its age as receipt/payment/nonce-consumption truth.
 */
export const loadRewardFundingWalletNonceOwnerIn = Effect.fn(
  "RewardWalletNonceAuthority.loadFundingOwnerIn",
)(function* (transaction: ControlPlaneTransaction, input: RewardFundingNonceOwner) {
  const owner = yield* decode(FundingOwner, input);
  const result = yield* transaction.execute({
    label: "reward-wallet-nonce.funding-owner.read",
    text: `SELECT ${LEASE_COLUMNS} FROM load_reward_funding_wallet_nonce_owner_v2($1::jsonb)`,
    values: [
      JSON.stringify({
        lease_id: owner.leaseId,
        owner_id: owner.ownerId,
        command_id: owner.commandId,
        account_id: owner.accountId,
        persona_id: owner.personaId,
        wallet_assignment_id: owner.walletAssignmentId,
        chain_id: owner.chainId,
        sender_address: owner.senderAddress,
        request_hash: owner.requestHash,
      }),
    ],
    readonly: true,
  });
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) return yield* refuse("invalid_row");
  return yield* decodeLease(result.rows[0], owner);
});
