import { Data, Effect, Schema } from "effect";
import { canonicalBodyHash } from "../use-cases/content/common.ts";

/** Named native-USDC exception for this separate, operator-Safe pilot.
 * This is not arbitrary-token admission or authority to activate a runtime. */
const FIXED_BONUS_BASE_CHAIN_ID = 8453;
export const FIXED_BONUS_BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const MAX_UINT256 = (1n << 256n) - 1n;
const Id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u));
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const BlockHash = Schema.String.check(Schema.isPattern(/^0x[a-f0-9]{64}$/u));
const Address = Schema.String.check(
  Schema.isPattern(/^0x[0-9a-f]{40}$/u),
  Schema.makeFilter((v) => v !== `0x${"0".repeat(40)}` || "Zero address"),
);
const Natural = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const Positive = Natural.check(Schema.isGreaterThan(0));
const Atomic = Schema.String.check(
  Schema.isPattern(/^(0|[1-9][0-9]{0,77})$/u),
  Schema.makeFilter((v) => BigInt(v) <= MAX_UINT256 || "Atomic amount exceeds uint256"),
);
const PositiveAtomic = Atomic.check(
  Schema.makeFilter((v) => BigInt(v) > 0n || "Positive amount required"),
);

export const FixedUsdcBonusCustodyPolicy = Schema.Struct({
  version: Schema.Literal("fixed-usdc-bonus-custody-v1"),
  custody_id: Id,
  chain_id: Schema.Literal(FIXED_BONUS_BASE_CHAIN_ID),
  token_address: Schema.Literal(FIXED_BONUS_BASE_USDC),
  token_decimals: Schema.Literal(6),
  asset_policy_version: Schema.Literal("base-native-usdc-fixed-bonus-v1"),
  safe_address: Address,
  /** Hash of the separately reviewed Safe code, implementation, owners and
   * threshold binding. A caller-supplied hash is not an admission decision. */
  safe_binding_hash: Hash,
  funded_cap_atomic: PositiveAtomic,
  maximum_budget_count: Positive.check(Schema.isLessThanOrEqualTo(10000)),
  minimum_confirmations: Positive,
  maximum_observation_age_ms: Positive,
  valid_from_ms: Natural,
  valid_until_ms: Positive,
  accepted_by: Id,
  acceptance_ref: Id,
  acceptance_hash: Hash,
}).check(
  Schema.makeFilter(
    (p) =>
      (p.valid_until_ms > p.valid_from_ms && p.safe_address !== p.token_address) ||
      "Invalid custody interval or Safe",
  ),
);
export type FixedUsdcBonusCustodyPolicy = Schema.Schema.Type<typeof FixedUsdcBonusCustodyPolicy>;

export const FixedUsdcBonusSolvencyObservation = Schema.Struct({
  version: Schema.Literal("fixed-usdc-bonus-solvency-v1"),
  observation_id: Id,
  custody_id: Id,
  chain_id: Schema.Literal(FIXED_BONUS_BASE_CHAIN_ID),
  token_address: Schema.Literal(FIXED_BONUS_BASE_USDC),
  token_decimals: Schema.Literal(6),
  safe_address: Address,
  safe_binding_hash: Hash,
  block_number: Atomic,
  block_hash: BlockHash,
  head_block_number: Atomic,
  block_timestamp_ms: Natural,
  observed_at_ms: Natural,
  balance_atomic: Atomic,
}).check(
  Schema.makeFilter(
    (o) =>
      (BigInt(o.head_block_number) >= BigInt(o.block_number) &&
        o.block_timestamp_ms <= o.observed_at_ms) ||
      "Invalid chain observation",
  ),
);
export type FixedUsdcBonusSolvencyObservation = Schema.Schema.Type<
  typeof FixedUsdcBonusSolvencyObservation
>;

export const FixedUsdcBonusBudgetCommand = Schema.Struct({
  version: Schema.Literal("fixed-usdc-bonus-budget-v1"),
  idempotency_key: Id,
  budget_id: Id,
  custody_id: Id,
  community_id: Id,
  song_post_id: Id,
  audio_revision: Positive,
  amount_per_account_atomic: PositiveAtomic,
  maximum_accounts: Positive,
  starts_at_ms: Natural,
  ends_at_ms: Positive,
}).check(
  Schema.makeFilter(
    (c) =>
      (c.ends_at_ms > c.starts_at_ms &&
        BigInt(c.amount_per_account_atomic) * BigInt(c.maximum_accounts) <= MAX_UINT256) ||
      "Invalid budget interval or amount",
  ),
);
export type FixedUsdcBonusBudgetCommand = Schema.Schema.Type<typeof FixedUsdcBonusBudgetCommand>;

export class FixedUsdcBonusFundingFailed extends Data.TaggedError("FixedUsdcBonusFundingFailed")<{
  readonly reason:
    | "invalid-input"
    | "invalid-row"
    | "unavailable"
    | "outcome-unknown"
    | "idempotency-conflict"
    | "capacity"
    | "custody-unavailable"
    | "song-unavailable";
}> {}

const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(input),
    catch: () => new FixedUsdcBonusFundingFailed({ reason: "invalid-input" }),
  });
const hash = (preimage: readonly unknown[]) =>
  canonicalBodyHash(preimage).pipe(
    Effect.mapError(() => new FixedUsdcBonusFundingFailed({ reason: "invalid-input" })),
  );
/** Ordered arrays share the existing canonical financial-array codec with
 * PostgreSQL. No contract depends on JSONB object key ordering. */
const fixedBonusCustodyPreimage = (p: FixedUsdcBonusCustodyPolicy) =>
  [
    p.version,
    p.custody_id,
    p.chain_id,
    p.token_address,
    p.token_decimals,
    p.asset_policy_version,
    p.safe_address,
    p.safe_binding_hash,
    p.funded_cap_atomic,
    p.maximum_budget_count,
    p.minimum_confirmations,
    p.maximum_observation_age_ms,
    p.valid_from_ms,
    p.valid_until_ms,
    p.accepted_by,
    p.acceptance_ref,
    p.acceptance_hash,
  ] as const;
const fixedBonusObservationPreimage = (o: FixedUsdcBonusSolvencyObservation) =>
  [
    o.version,
    o.observation_id,
    o.custody_id,
    o.chain_id,
    o.token_address,
    o.token_decimals,
    o.safe_address,
    o.safe_binding_hash,
    o.block_number,
    o.block_hash,
    o.head_block_number,
    o.block_timestamp_ms,
    o.observed_at_ms,
    o.balance_atomic,
  ] as const;
const fixedBonusBudgetPreimage = (c: FixedUsdcBonusBudgetCommand) =>
  [
    c.version,
    c.idempotency_key,
    c.budget_id,
    c.custody_id,
    c.community_id,
    c.song_post_id,
    c.audio_revision,
    c.amount_per_account_atomic,
    c.maximum_accounts,
    c.starts_at_ms,
    c.ends_at_ms,
  ] as const;

export const prepareFixedUsdcBonusCustody = Effect.fn("prepareFixedUsdcBonusCustody")(function* (
  input: unknown,
) {
  const policy = yield* decode(FixedUsdcBonusCustodyPolicy, input);
  return { policy, policyHash: yield* hash(fixedBonusCustodyPreimage(policy)) };
});
export const prepareFixedUsdcBonusObservation = Effect.fn("prepareFixedUsdcBonusObservation")(
  function* (input: unknown) {
    const observation = yield* decode(FixedUsdcBonusSolvencyObservation, input);
    return {
      observation,
      observationHash: yield* hash(fixedBonusObservationPreimage(observation)),
    };
  },
);
export const prepareFixedUsdcBonusBudget = Effect.fn("prepareFixedUsdcBonusBudget")(function* (
  input: unknown,
) {
  const command = yield* decode(FixedUsdcBonusBudgetCommand, input);
  return { command, requestHash: yield* hash(fixedBonusBudgetPreimage(command)) };
});

export const FixedUsdcBonusCustodyReceipt = Schema.Struct({
  version: Schema.Literal("fixed-usdc-bonus-custody-receipt-v1"),
  custody_id: Id,
  policy_hash: Hash,
  admitted_at_ms: Natural,
});
export const FixedUsdcBonusObservationReceipt = Schema.Struct({
  version: Schema.Literal("fixed-usdc-bonus-observation-receipt-v1"),
  custody_id: Id,
  observation_id: Id,
  observation_hash: Hash,
  solvent: Schema.Boolean,
  recorded_at_ms: Natural,
});
export const FixedUsdcBonusBudgetReceipt = Schema.Struct({
  version: Schema.Literal("fixed-usdc-bonus-budget-receipt-v1"),
  custody_id: Id,
  budget_id: Id,
  request_hash: Hash,
  amount_per_account_atomic: PositiveAtomic,
  maximum_accounts: Positive,
  total_atomic: PositiveAtomic,
  funded_at_ms: Natural,
  participation_starts_at_ms: Natural,
  ends_at_ms: Positive,
}).check(
  Schema.makeFilter(
    (r) =>
      (BigInt(r.total_atomic) ===
        BigInt(r.amount_per_account_atomic) * BigInt(r.maximum_accounts) &&
        r.participation_starts_at_ms >= r.funded_at_ms &&
        r.ends_at_ms > r.participation_starts_at_ms) ||
      "Invalid budget receipt",
  ),
);

export interface FixedUsdcBonusFundingStore {
  readonly admitCustody: (
    packet: Effect.Success<ReturnType<typeof prepareFixedUsdcBonusCustody>>,
  ) => Effect.Effect<
    Schema.Schema.Type<typeof FixedUsdcBonusCustodyReceipt>,
    FixedUsdcBonusFundingFailed
  >;
  readonly observe: (
    packet: Effect.Success<ReturnType<typeof prepareFixedUsdcBonusObservation>>,
  ) => Effect.Effect<
    Schema.Schema.Type<typeof FixedUsdcBonusObservationReceipt>,
    FixedUsdcBonusFundingFailed
  >;
  readonly allocateBudget: (
    packet: Effect.Success<ReturnType<typeof prepareFixedUsdcBonusBudget>>,
  ) => Effect.Effect<
    Schema.Schema.Type<typeof FixedUsdcBonusBudgetReceipt>,
    FixedUsdcBonusFundingFailed
  >;
}
