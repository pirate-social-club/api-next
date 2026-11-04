import {
  ControlPlaneDb,
  type ControlPlaneError,
  ControlPlaneStatementFailed,
  type ControlPlaneTransaction,
} from "@pirate/application";
import {
  type RewardSafeAuthorizationV1,
  type RewardSafeCandidateV1,
  type RewardSafePolicyV1,
  type RewardSafeRecordV1,
  RewardSafeSettlementFailedV1,
  type RewardSafeSettlementStoreV1,
} from "@pirate/application/rewards/safe-settlement-v1";
import { Effect, type Layer } from "effect";

type Row = Readonly<Record<string, unknown>>;
export const safeSettlementJsonV1 = (value: unknown): string =>
  JSON.stringify(value, (_key, item) => {
    if (typeof item === "bigint") return item.toString();
    if (item !== null && typeof item === "object" && !Array.isArray(item))
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
    return item;
  });
const failure = () => new RewardSafeSettlementFailedV1({ reason: "conflict" });
function policyFrom(value: unknown): RewardSafePolicyV1 {
  const p = value as RewardSafePolicyV1;
  if (
    p.version !== "safe_credit_v1" ||
    p.posture !== "local_only" ||
    !p.policyId ||
    !p.attestationId
  )
    throw failure();
  for (const field of [
    p.collectionRoot,
    p.safeRoot,
    p.token,
    p.module,
    p.relayer,
    p.creditAuthority,
    p.safeSingleton,
  ]) {
    if (!/^0x[0-9a-f]{40}$/.test(field)) throw failure();
  }
  for (const hash of [p.moduleCodeHash, p.safeCodeHash, p.safeSingletonCodeHash])
    if (!/^0x[0-9a-f]{64}$/.test(hash)) throw failure();
  if (
    p.collectionRoot === p.safeRoot ||
    p.creditAuthority === p.relayer ||
    p.creditAuthority === p.collectionRoot ||
    p.creditAuthority === p.safeRoot ||
    BigInt(p.aggregateCapAtomic) <= 0n
  )
    throw failure();
  return { ...p, aggregateCapAtomic: BigInt(p.aggregateCapAtomic) };
}
function candidateFrom(value: unknown): RewardSafeCandidateV1 {
  const c = value as RewardSafeCandidateV1;
  if (
    !c.creditId ||
    !c.accountId ||
    !c.personaId ||
    !c.walletAssignmentId ||
    !/^0x[0-9a-f]{40}$/.test(c.recipient) ||
    BigInt(c.amountAtomic) <= 0n
  )
    throw failure();
  return { ...c, amountAtomic: BigInt(c.amountAtomic) };
}
function recordFrom(row: Row): RewardSafeRecordV1 {
  const a = row.credit_authorization as RewardSafeAuthorizationV1;
  return {
    candidate: candidateFrom(row.candidate),
    policy: policyFrom(row.configuration),
    authorization: { ...a, validUntil: BigInt(a.validUntil) },
    state: row.state as RewardSafeRecordV1["state"],
    preparationOwner: row.preparation_owner===null ? null : String(row.preparation_owner),
    unsigned: row.unsigned_transaction as RewardSafeRecordV1["unsigned"],
    signed:
      row.raw_transaction === null
        ? null
        : {
            rawTransaction: String(row.raw_transaction),
            transactionHash: String(row.transaction_hash),
          },
  };
}
const select = `SELECT s.*,p.configuration FROM reward_safe_settlements_v1 s JOIN reward_safe_policies_v1 p USING(policy_id)`;
const candidateSelect = `SELECT c.credit_id AS "creditId",c.account_id AS "accountId",c.payout_persona_id AS "personaId",
  w.assignment_id AS "walletAssignmentId",w.address AS recipient,c.amount_atomic::text AS "amountAtomic"
  FROM reward_ledger_credits c
  JOIN megapot_allocations a ON a.credit_id=c.credit_id
  JOIN megapot_allocation_batches b ON b.allocation_batch_id=a.allocation_batch_id
  JOIN song_reward_offer_legs l ON l.leg_id=b.pool_leg_id
  JOIN reward_safe_policies_v1 p ON p.policy_id=$2 AND p.attestation_id=l.attestation_id
  JOIN megapot_deployment_attestations pin ON pin.attestation_id=l.attestation_id AND pin.chain_id=8453
    AND pin.custody_address=p.configuration->>'collectionRoot' AND pin.usdc_address=p.configuration->>'token'
  JOIN persona_wallet_assignments w ON w.account_id=c.account_id AND w.persona_id=c.payout_persona_id
    AND w.status='active' AND w.chain_account_kind='evm'
  WHERE c.credit_id=$1 AND c.chain_id=8453 AND c.token_address=p.configuration->>'token'
    AND c.state='credited' AND c.reserved_atomic=0 AND c.paid_atomic=0
    AND ((c.source_kind='megapot_allocation' AND EXISTS(SELECT 1 FROM megapot_participant_claims pc WHERE pc.credit_id=c.credit_id AND pc.status='accepted'))
      OR c.source_kind='external_fallback')
    AND NOT EXISTS(SELECT 1 FROM reward_payout_effects d WHERE d.credit_id=c.credit_id)`;

function readIn(tx: ControlPlaneTransaction, creditId: string, lock = false) {
  return Effect.gen(function* () {
    const result = yield* tx.execute<Row>({
      label: "reward-safe-v1.read",
      text: `${select} WHERE s.credit_id=$1 ${lock ? "FOR UPDATE OF s" : ""}`,
      values: [creditId],
      readonly: !lock,
    });
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) return yield* failure();
    return yield* Effect.try({ try: () => recordFrom(result.rows[0] as Row), catch: failure });
  });
}
function candidateIn(tx: ControlPlaneTransaction, creditId: string, policyId: string) {
  return Effect.gen(function* () {
    const result = yield* tx.execute<Row>({
      label: "reward-safe-v1.candidate",
      text: candidateSelect,
      values: [creditId, policyId],
      readonly: true,
    });
    if (result.rows.length !== 1) return yield* failure();
    return yield* Effect.try({ try: () => candidateFrom(result.rows[0]), catch: failure });
  });
}
function eventIn(tx: ControlPlaneTransaction, creditId: string, state: string, evidence: unknown) {
  return tx.execute({
    label: "reward-safe-v1.event",
    text: "INSERT INTO reward_safe_settlement_events_v1(credit_id,state,evidence) VALUES($1,$2,$3::jsonb)",
    values: [creditId, state, safeSettlementJsonV1(evidence)],
    readonly: false,
  });
}

/** Local-only versioned route; historical direct ERC20 stores and receipts stay exact. */
export function makeControlPlaneRewardSafeStoreV1(
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): RewardSafeSettlementStoreV1 {
  const use = <A, E>(body: (db: ControlPlaneDb["Service"]) => Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      return yield* body(yield* ControlPlaneDb);
    }).pipe(
      Effect.provide(layer),
      Effect.mapError((error) =>
        error instanceof RewardSafeSettlementFailedV1
          ? error
          : new RewardSafeSettlementFailedV1({
              reason: "unavailable",
              stage:
                error instanceof ControlPlaneStatementFailed
                  ? `${error.label}:${error.sqlState}`
                  : "storage",
            }),
      ),
    );
  const transaction = <A, E>(body: (tx: ControlPlaneTransaction) => Effect.Effect<A, E>) =>
    use((db) => db.withTransaction(body));
  return {
    recordSolvency: (observation) =>
      transaction((tx) =>
        Effect.gen(function* () {
          const p = yield* tx.execute<Row>({
            label: "reward-safe-v1.solvency.policy",
            text: "SELECT configuration FROM reward_safe_policies_v1 WHERE policy_id=$1 FOR SHARE",
            values: [observation.policyId],
            readonly: false,
          });
          if (p.rows.length !== 1) return yield* failure();
          const policy = yield* Effect.try({
            try: () => policyFrom(p.rows[0]?.configuration),
            catch: failure,
          });
          const result = yield* tx.execute<Row>({
            label: "reward-safe-v1.solvency.liabilities",
            text: `SELECT
        (SELECT coalesce(sum(reserved_atomic),0)::text FROM song_reward_offer_legs WHERE kind='megapot_pool' AND funding_source='leg_budget' AND chain_id=8453 AND token_address=$1) AS purchase,
        (SELECT coalesce(sum(amount_atomic-paid_atomic),0)::text FROM reward_ledger_credits WHERE state<>'sent' AND chain_id=8453 AND token_address=$1) AS credit,
        (SELECT coalesce(sum(funded_atomic-reserved_atomic-spent_atomic-fulfilled_atomic-refunded_atomic),0)::text FROM song_reward_offer_legs WHERE (funding_source='leg_budget' OR kind='asset_bonus') AND chain_id=8453 AND token_address=$1) AS refund,
        (SELECT coalesce(sum(funded_atomic+winnings_credited_atomic-spent_atomic-withdrawn_atomic),0)::text FROM platform_sponsorship_budgets WHERE chain_id=8453 AND token_address=$1) AS sponsorship,
        (SELECT coalesce(sum(amount_atomic),0)::text FROM reward_safe_settlements_v1 WHERE policy_id=$2 AND state<>'confirmed') AS safe_reserved`,
            values: [policy.token, policy.policyId],
            readonly: true,
          });
          const row = result.rows[0];
          if (row === undefined) return yield* failure();
          const totals = {
            reservedPurchaseAtomic: BigInt(String(row.purchase)),
            outstandingCreditAtomic: BigInt(String(row.credit)),
            pendingRefundAtomic: BigInt(String(row.refund)),
            sharedSponsorshipAtomic: BigInt(String(row.sponsorship)),
            reservedSafeAtomic: BigInt(String(row.safe_reserved)),
          };
          const liabilities =
            totals.reservedPurchaseAtomic +
            totals.outstandingCreditAtomic +
            totals.pendingRefundAtomic +
            totals.sharedSponsorshipAtomic;
          const solvent =
            observation.collectionBalanceAtomic >=
              totals.reservedPurchaseAtomic +
                totals.pendingRefundAtomic +
                totals.sharedSponsorshipAtomic &&
            observation.safeBalanceAtomic >= totals.reservedSafeAtomic &&
            observation.collectionBalanceAtomic + observation.safeBalanceAtomic >= liabilities;
          yield* tx.execute({
            label: "reward-safe-v1.solvency.record",
            text: "INSERT INTO reward_safe_solvency_v1(policy_id,block_number,block_hash,collection_balance_atomic,safe_balance_atomic,liabilities,solvent) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)",
            values: [
              policy.policyId,
              observation.blockNumber.toString(),
              observation.blockHash,
              observation.collectionBalanceAtomic.toString(),
              observation.safeBalanceAtomic.toString(),
              safeSettlementJsonV1(totals),
              solvent,
            ],
            readonly: false,
          });
          return { ...observation, ...totals, solvent };
        }),
      ),
    policy: (policyId) =>
      use((db) =>
        Effect.gen(function* () {
          const r = yield* db.execute<Row>({
            label: "reward-safe-v1.policy",
            text: "SELECT configuration FROM reward_safe_policies_v1 WHERE policy_id=$1",
            values: [policyId],
            readonly: true,
          });
          if (r.rows.length !== 1) return yield* failure();
          return yield* Effect.try({
            try: () => policyFrom(r.rows[0]?.configuration),
            catch: failure,
          });
        }),
      ),
    candidate: (creditId, policyId) => use((db) => candidateIn(db, creditId, policyId)),
    find: (creditId) => use((db) => readIn(db, creditId)),
    reserve: (candidate, policy, authorization) =>
      transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.execute({
            label: "reward-safe-v1.authority",
            text: "SELECT require_reward_run_authority_v1()",
            values: [],
            readonly: false,
          });
          const p = yield* tx.execute<Row>({
            label: "reward-safe-v1.policy.lock",
            text: "SELECT configuration FROM reward_safe_policies_v1 WHERE policy_id=$1 FOR UPDATE",
            values: [policy.policyId],
            readonly: false,
          });
          if (
            p.rows.length !== 1 ||
            safeSettlementJsonV1(policyFrom(p.rows[0]?.configuration)) !==
              safeSettlementJsonV1(policy)
          )
            return yield* failure();
          yield* tx.execute({
            label: "reward-safe-v1.credit.lock",
            text: "SELECT credit_id FROM reward_ledger_credits WHERE credit_id=$1 FOR UPDATE",
            values: [candidate.creditId],
            readonly: false,
          });
          const existing = yield* readIn(tx, candidate.creditId, true);
          if (existing !== null) {
            if (
              safeSettlementJsonV1(existing.policy) !== safeSettlementJsonV1(policy) ||
              safeSettlementJsonV1(existing.candidate) !== safeSettlementJsonV1(candidate)
            )
              return yield* failure();
            return existing;
          }
          const current = yield* candidateIn(tx, candidate.creditId, policy.policyId);
          if (safeSettlementJsonV1(current) !== safeSettlementJsonV1(candidate))
            return yield* failure();
          const sum = yield* tx.execute<Row>({
            label: "reward-safe-v1.cap",
            text: "SELECT coalesce(sum(amount_atomic),0)::text AS amount FROM reward_safe_settlements_v1 WHERE policy_id=$1",
            values: [policy.policyId],
            readonly: true,
          });
          if (
            BigInt(String(sum.rows[0]?.amount)) + candidate.amountAtomic >
            policy.aggregateCapAtomic
          )
            return yield* failure();
          yield* tx.execute({
            label: "reward-safe-v1.reserve",
            text: `INSERT INTO reward_safe_settlements_v1(credit_id,policy_id,candidate,credit_authorization,amount_atomic,state,relayer_address) VALUES($1,$2,$3::jsonb,$4::jsonb,$5,'authorized',$6)`,
            values: [
              candidate.creditId,
              policy.policyId,
              safeSettlementJsonV1(candidate),
              safeSettlementJsonV1(authorization),
              candidate.amountAtomic.toString(),
              policy.relayer,
            ],
            readonly: false,
          });
          const r = yield* tx.execute({
            label: "reward-safe-v1.credit.reserve",
            text: "UPDATE reward_ledger_credits SET state='payout_reserved',reserved_atomic=amount_atomic,updated_at=clock_timestamp() WHERE credit_id=$1 AND state='credited' AND reserved_atomic=0 AND paid_atomic=0",
            values: [candidate.creditId],
            readonly: false,
          });
          if (r.rowCount !== 1) return yield* failure();
          yield* eventIn(tx, candidate.creditId, "authorized", { digest: authorization.digest });
          return (yield* readIn(tx, candidate.creditId))!;
        }),
      ),
    prepare: (creditId, unsigned, observedBlock, observedHash, preparationOwner) =>
      transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.execute({
            label: "reward-safe-v1.authority",
            text: "SELECT require_reward_run_authority_v1()",
            values: [],
            readonly: false,
          });
          const current = yield* readIn(tx, creditId, true);
          if (current === null) return yield* failure();
          if (current.state !== "authorized") return {record:current,ownership:"lookup_only" as const};
          if(!/^[0-9a-f-]{36}$/.test(preparationOwner)) return yield* failure();
          if (
            unsigned.chainId !== 8453 ||
            unsigned.signerAddress !== current.policy.relayer ||
            unsigned.targetAddress !== current.policy.module ||
            unsigned.valueWei !== "0"
          )
            return yield* failure();
          const pending = BigInt(unsigned.nonce);
          yield* tx.execute({
            label: "reward-safe-v1.nonce.initialize",
            text: `INSERT INTO reward_signer_nonces(chain_id,signer_address,next_nonce,observed_pending_nonce,observed_block_number,observed_block_hash,observed_at) VALUES(8453,$1,$2,$2,$3,$4,clock_timestamp()) ON CONFLICT DO NOTHING`,
            values: [
              unsigned.signerAddress,
              pending.toString(),
              observedBlock.toString(),
              observedHash,
            ],
            readonly: false,
          });
          const n = yield* tx.execute<Row>({
            label: "reward-safe-v1.nonce.lock",
            text: "SELECT next_nonce::text,observed_block_number::text FROM reward_signer_nonces WHERE chain_id=8453 AND signer_address=$1 FOR UPDATE",
            values: [unsigned.signerAddress],
            readonly: false,
          });
          if (
            n.rows.length !== 1 ||
            BigInt(String(n.rows[0]?.observed_block_number)) > observedBlock
          )
            return yield* failure();
          const nonce =
            BigInt(String(n.rows[0]?.next_nonce)) > pending
              ? BigInt(String(n.rows[0]?.next_nonce))
              : pending;
          yield* tx.execute({
            label: "reward-safe-v1.nonce.reserve",
            text: `UPDATE reward_signer_nonces SET next_nonce=$2,observed_pending_nonce=$3,observed_block_number=$4,observed_block_hash=$5,observed_at=GREATEST(observed_at,clock_timestamp()),fence_version=fence_version+1,updated_at=clock_timestamp() WHERE chain_id=8453 AND signer_address=$1`,
            values: [
              unsigned.signerAddress,
              (nonce + 1n).toString(),
              pending.toString(),
              observedBlock.toString(),
              observedHash,
            ],
            readonly: false,
          });
          yield* tx.execute({
            label: "reward-safe-v1.prepare",
            text: "UPDATE reward_safe_settlements_v1 SET state='signing',nonce=$2,unsigned_transaction=$3::jsonb,preparation_owner=$4,updated_at=clock_timestamp() WHERE credit_id=$1",
            values: [
              creditId,
              nonce.toString(),
              safeSettlementJsonV1({ ...unsigned, nonce: nonce.toString() }),
              preparationOwner,
            ],
            readonly: false,
          });
          yield* eventIn(tx, creditId, "signing", { nonce: nonce.toString() });
          return {record:(yield* readIn(tx, creditId))!,ownership:"acquired" as const};
        }),
      ),
    signed: (creditId, signed) =>
      transaction((tx) =>
        Effect.gen(function* () {
          const current = yield* readIn(tx, creditId, true);
          if (current === null) return yield* failure();
          if (current.state !== "signing") {
            if (safeSettlementJsonV1(current.signed) !== safeSettlementJsonV1(signed))
              return yield* failure();
            return current;
          }
          yield* tx.execute({
            label: "reward-safe-v1.signed",
            text: "UPDATE reward_safe_settlements_v1 SET state='signed',raw_transaction=$2,transaction_hash=$3,updated_at=clock_timestamp() WHERE credit_id=$1",
            values: [creditId, signed.rawTransaction, signed.transactionHash],
            readonly: false,
          });
          yield* eventIn(tx, creditId, "signed", { transactionHash: signed.transactionHash });
          return (yield* readIn(tx, creditId))!;
        }),
      ),
    transition: (creditId, from, to) =>
      transaction((tx) =>
        Effect.gen(function* () {
          if (to === "broadcast_unknown")
            yield* tx.execute({
              label: "reward-safe-v1.authority",
              text: "SELECT require_reward_run_authority_v1()",
              values: [],
              readonly: false,
            });
          const current = yield* readIn(tx, creditId, true);
          if (current === null) return yield* failure();
          if (current.state === to) return yield* failure();
          if (current.state !== from) return yield* failure();
          yield* tx.execute({
            label: "reward-safe-v1.transition",
            text: "UPDATE reward_safe_settlements_v1 SET state=$2,updated_at=clock_timestamp() WHERE credit_id=$1",
            values: [creditId, to],
            readonly: false,
          });
          yield* tx.execute({
            label: "reward-safe-v1.credit.transition",
            text: "UPDATE reward_ledger_credits SET state=$2,updated_at=clock_timestamp() WHERE credit_id=$1 AND state<>$2",
            values: [creditId, to === "submitted" ? "payout_pending" : "reconciliation_required"],
            readonly: false,
          });
          yield* eventIn(tx, creditId, to, {});
          return (yield* readIn(tx, creditId))!;
        }),
      ),
    confirm: (creditId, evidence) =>
      transaction((tx) =>
        Effect.gen(function* () {
          const current = yield* readIn(tx, creditId, true);
          if (current === null || current.signed?.transactionHash !== evidence.transactionHash)
            return yield* failure();
          if (current.state === "confirmed") return current;
          if (current.state !== "broadcast_unknown" && current.state !== "submitted")
            return yield* failure();
          yield* tx.execute({
            label: "reward-safe-v1.confirm",
            text: `UPDATE reward_safe_settlements_v1 SET state='confirmed',module_log_index=$2,transfer_log_index=$3,block_number=$4,block_hash=$5,receipt_hash=$6,updated_at=clock_timestamp() WHERE credit_id=$1`,
            values: [
              creditId,
              evidence.moduleLogIndex,
              evidence.transferLogIndex,
              evidence.blockNumber.toString(),
              evidence.blockHash,
              evidence.receiptHash,
            ],
            readonly: false,
          });
          yield* tx.execute({
            label: "reward-safe-v1.credit.paid",
            text: "UPDATE reward_ledger_credits SET state='sent',reserved_atomic=0,paid_atomic=amount_atomic,settled_at=clock_timestamp(),updated_at=clock_timestamp() WHERE credit_id=$1",
            values: [creditId],
            readonly: false,
          });
          yield* eventIn(tx, creditId, "confirmed", evidence);
          return (yield* readIn(tx, creditId))!;
        }),
      ),
  };
}
