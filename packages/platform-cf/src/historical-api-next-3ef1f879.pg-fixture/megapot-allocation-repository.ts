import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  type MegapotAllocationCandidate,
  type MegapotAllocationFailure,
  MegapotAllocationRejected,
  type MegapotAllocationResult,
  MegapotAllocationStorageFailed,
  type MegapotAllocationStore,
  type MegapotPreparedAllocation,
} from "@pirate/application";
import { Effect, type Layer } from "effect";
import { keccak256, toBytes } from "viem";
import { mapMegapotStorageFailure } from "./control-plane-error-classification.ts";

type Row = Readonly<Record<string, unknown>>;

const storage = (reason: MegapotAllocationStorageFailed["reason"]) =>
  new MegapotAllocationStorageFailed({ reason });
const rejected = (reason: MegapotAllocationRejected["reason"]) =>
  new MegapotAllocationRejected({ reason });

const mapped = <A, E, R>(effect: Effect.Effect<A, E | ControlPlaneError, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      mapMegapotStorageFailure<E, MegapotAllocationStorageFailed>(error, storage),
    ),
  );

function text(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${field}`);
  return value;
}

function nullableText(row: Row, field: string): string | null {
  const value = row[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${field}`);
  return value;
}

function integer(row: Row, field: string): number {
  const value = row[field];
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`invalid ${field}`);
  return parsed;
}

function bigint(row: Row, field: string): bigint {
  const value = row[field];
  if (
    (typeof value !== "string" && typeof value !== "bigint" && typeof value !== "number") ||
    !/^[0-9]+$/u.test(String(value))
  ) {
    throw new Error(`invalid ${field}`);
  }
  return BigInt(value);
}

function bool(row: Row, field: string): boolean {
  const value = row[field];
  if (typeof value !== "boolean") throw new Error(`invalid ${field}`);
  return value;
}

const CANDIDATE_SELECT = `
  SELECT drawing.pool_leg_id, drawing.drawing_id, drawing.version AS drawing_version,
         drawing.status AS drawing_status, drawing.snapshot_id,
         drawing.claim_effect_id, drawing.net_winnings_atomic,
         snapshot.algorithm_version, snapshot.fallback,
         leg.chain_id, leg.token_address, leg.funding_source,
         leg.fallback_beneficiary_account_id, leg.fallback_payout_persona_id
    FROM megapot_pool_drawings drawing
    JOIN megapot_pool_beneficiary_snapshots snapshot
      ON snapshot.snapshot_id=drawing.snapshot_id
    JOIN song_reward_offer_legs leg ON leg.leg_id=drawing.pool_leg_id
    JOIN megapot_claim_effects claim ON claim.claim_effect_id=drawing.claim_effect_id`;

function candidateHeaderFromRow(row: Row): Omit<MegapotAllocationCandidate, "leaves"> {
  const drawingStatus = text(row, "drawing_status");
  const algorithmVersion = text(row, "algorithm_version");
  const fundingSource = text(row, "funding_source");
  if (
    (drawingStatus !== "claimed" &&
      drawingStatus !== "allocated" &&
      drawingStatus !== "credited") ||
    algorithmVersion !== "equal_v1" ||
    (fundingSource !== "leg_budget" && fundingSource !== "shared_sponsor_budget")
  ) {
    throw new Error("invalid allocation candidate");
  }
  return {
    poolLegId: text(row, "pool_leg_id"),
    drawingId: bigint(row, "drawing_id"),
    drawingVersion: integer(row, "drawing_version"),
    drawingStatus,
    snapshotId: text(row, "snapshot_id"),
    claimEffectId: text(row, "claim_effect_id"),
    algorithmVersion,
    netWinningsAtomic: bigint(row, "net_winnings_atomic"),
    chainId: integer(row, "chain_id"),
    tokenAddress: text(row, "token_address"),
    fallback: bool(row, "fallback"),
    fundingSource,
    fallbackBeneficiaryAccountId: nullableText(row, "fallback_beneficiary_account_id"),
    fallbackPayoutPersonaId: nullableText(row, "fallback_payout_persona_id"),
  };
}

function loadCandidateIn(
  transaction: ControlPlaneTransaction,
  input: { readonly poolLegId: string; readonly drawingId: bigint; readonly lock: boolean },
): Effect.Effect<MegapotAllocationCandidate, MegapotAllocationFailure | ControlPlaneError> {
  return Effect.gen(function* () {
    const headerResult = yield* transaction.execute<Row>({
      label: "megapot-allocation.candidate.read",
      text: `${CANDIDATE_SELECT}
              WHERE drawing.pool_leg_id=$1 AND drawing.drawing_id=$2
                AND drawing.status IN ('claimed','allocated','credited')
                AND claim.received_atomic IS NOT NULL
                AND claim.received_atomic=drawing.net_winnings_atomic
              ${input.lock ? "FOR UPDATE OF drawing" : ""}`,
      values: [input.poolLegId, input.drawingId.toString()],
      readonly: !input.lock,
    });
    if (headerResult.rows.length === 0) return yield* rejected("not-found");
    if (headerResult.rows.length !== 1) return yield* storage("invalid-row");
    const header = yield* Effect.try({
      try: () => candidateHeaderFromRow(headerResult.rows[0] as Row),
      catch: () => storage("invalid-row"),
    });
    const leavesResult = yield* transaction.execute<Row>({
      label: "megapot-allocation.leaves.read",
      text: `SELECT ordinal, account_id, persona_id
               FROM megapot_pool_snapshot_private_leaves
              WHERE snapshot_id=$1 ORDER BY ordinal`,
      values: [header.snapshotId],
      readonly: !input.lock,
    });
    const leaves = yield* Effect.try({
      try: () =>
        leavesResult.rows.map((leaf) => ({
          ordinal: integer(leaf, "ordinal"),
          accountId: text(leaf, "account_id"),
          personaId: text(leaf, "persona_id"),
        })),
      catch: () => storage("invalid-row"),
    });
    if (leaves.length === 0) return yield* storage("invalid-row");
    return { ...header, leaves };
  });
}

function allocationFromRow(row: Row): MegapotPreparedAllocation {
  const allocationKind = text(row, "allocation_kind");
  if (
    allocationKind !== "participant" &&
    allocationKind !== "external_fallback" &&
    allocationKind !== "platform_sponsorship"
  ) {
    throw new Error("invalid allocation kind");
  }
  const creditId = nullableText(row, "credit_id");
  return {
    ordinal: integer(row, "ordinal"),
    accountId: text(row, "account_id"),
    personaId: text(row, "persona_id"),
    amountAtomic: bigint(row, "amount_atomic"),
    allocationKind,
    creditId,
    creditSourceReference: nullableText(row, "source_reference"),
  };
}

function findResultIn(
  transaction: ControlPlaneTransaction,
  allocationBatchId: string,
): Effect.Effect<
  MegapotAllocationResult | null,
  MegapotAllocationStorageFailed | ControlPlaneError
> {
  return Effect.gen(function* () {
    const batchResult = yield* transaction.execute<Row>({
      label: "megapot-allocation.result.read",
      text: `SELECT allocation_batch_id, pool_leg_id, drawing_id, snapshot_id,
                    claim_effect_id, net_winnings_atomic, allocation_hash, state
               FROM megapot_allocation_batches
              WHERE allocation_batch_id=$1`,
      values: [allocationBatchId],
      readonly: true,
    });
    if (batchResult.rows.length === 0) return null;
    if (batchResult.rows.length !== 1) return yield* storage("invalid-row");
    const batch = batchResult.rows[0] as Row;
    if (text(batch, "state") !== "credited") return yield* storage("invalid-row");
    const allocationResult = yield* transaction.execute<Row>({
      label: "megapot-allocation.result-rows.read",
      text: `SELECT allocation.ordinal, allocation.account_id, allocation.persona_id,
                    allocation.amount_atomic, allocation.allocation_kind,
                    allocation.credit_id, credit.source_reference
               FROM megapot_allocations allocation
               LEFT JOIN reward_ledger_credits credit ON credit.credit_id=allocation.credit_id
              WHERE allocation.allocation_batch_id=$1 ORDER BY allocation.ordinal`,
      values: [allocationBatchId],
      readonly: true,
    });
    return yield* Effect.try({
      try: () => ({
        allocationBatchId: text(batch, "allocation_batch_id"),
        poolLegId: text(batch, "pool_leg_id"),
        drawingId: bigint(batch, "drawing_id"),
        snapshotId: text(batch, "snapshot_id"),
        claimEffectId: text(batch, "claim_effect_id"),
        netWinningsAtomic: bigint(batch, "net_winnings_atomic"),
        allocationHash: text(batch, "allocation_hash"),
        allocations: allocationResult.rows.map(allocationFromRow),
        state: "credited" as const,
      }),
      catch: () => storage("invalid-row"),
    });
  });
}

function sameCandidate(
  left: MegapotAllocationCandidate,
  right: MegapotAllocationCandidate,
): boolean {
  return (
    left.poolLegId === right.poolLegId &&
    left.drawingId === right.drawingId &&
    left.drawingVersion === right.drawingVersion &&
    left.drawingStatus === right.drawingStatus &&
    left.snapshotId === right.snapshotId &&
    left.claimEffectId === right.claimEffectId &&
    left.netWinningsAtomic === right.netWinningsAtomic &&
    left.chainId === right.chainId &&
    left.tokenAddress === right.tokenAddress &&
    left.fallback === right.fallback &&
    left.fundingSource === right.fundingSource &&
    left.fallbackBeneficiaryAccountId === right.fallbackBeneficiaryAccountId &&
    left.fallbackPayoutPersonaId === right.fallbackPayoutPersonaId &&
    left.leaves.length === right.leaves.length &&
    left.leaves.every((leaf, index) => {
      const other = right.leaves[index];
      return (
        other !== undefined &&
        leaf.ordinal === other.ordinal &&
        leaf.accountId === other.accountId &&
        leaf.personaId === other.personaId
      );
    })
  );
}

function sponsorshipBalanceHash(input: {
  readonly sponsorAccountId: string;
  readonly chainId: number;
  readonly tokenAddress: string;
  readonly fundedAtomic: bigint;
  readonly winningsCreditedAtomic: bigint;
  readonly reservedAtomic: bigint;
  readonly spentAtomic: bigint;
  readonly withdrawnAtomic: bigint;
}): string {
  return keccak256(
    toBytes(
      [
        "pirate.platform-sponsorship-budget.v1",
        input.sponsorAccountId,
        input.chainId.toString(10),
        input.tokenAddress,
        input.fundedAtomic.toString(10),
        input.winningsCreditedAtomic.toString(10),
        input.reservedAtomic.toString(10),
        input.spentAtomic.toString(10),
        input.withdrawnAtomic.toString(10),
      ].join("\u0000"),
    ),
  ).slice(2);
}

function creditIn(
  transaction: ControlPlaneTransaction,
  input: Parameters<MegapotAllocationStore["credit"]>[0],
): Effect.Effect<MegapotAllocationResult, MegapotAllocationFailure | ControlPlaneError> {
  return Effect.gen(function* () {
    const existing = yield* findResultIn(transaction, input.allocationBatchId);
    if (existing !== null) return existing;

    const locked = yield* loadCandidateIn(transaction, {
      poolLegId: input.candidate.poolLegId,
      drawingId: input.candidate.drawingId,
      lock: true,
    });
    if (!sameCandidate(locked, input.candidate) || locked.drawingStatus !== "claimed") {
      const replay = yield* findResultIn(transaction, input.allocationBatchId);
      if (replay !== null) return replay;
      return yield* rejected("effect-conflict");
    }
    if (
      input.allocations.length !== locked.leaves.length ||
      input.allocations.reduce((sum, allocation) => sum + allocation.amountAtomic, 0n) !==
        locked.netWinningsAtomic
    ) {
      return yield* rejected("allocation-invalid");
    }

    yield* transaction.execute({
      label: "megapot-allocation.batch.create",
      text: `INSERT INTO megapot_allocation_batches (
               allocation_batch_id, pool_leg_id, drawing_id, snapshot_id,
               claim_effect_id, algorithm_version, net_winnings_atomic,
               allocation_count, allocation_hash, state, created_at
             ) VALUES ($1,$2,$3,$4,$5,'equal_v1',$6,$7,$8,'prepared',$9)`,
      values: [
        input.allocationBatchId,
        locked.poolLegId,
        locked.drawingId.toString(),
        locked.snapshotId,
        locked.claimEffectId,
        locked.netWinningsAtomic.toString(),
        input.allocations.length,
        input.allocationHash,
        input.creditedAt,
      ],
      readonly: false,
    });

    for (const allocation of input.allocations) {
      if (allocation.creditId !== null && allocation.creditSourceReference !== null) {
        yield* transaction.execute({
          label: "megapot-allocation.credit.create",
          text: `INSERT INTO reward_ledger_credits (
                   credit_id, account_id, payout_persona_id, chain_id, token_address,
                   amount_atomic, source_kind, source_reference, state
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'credited')`,
          values: [
            allocation.creditId,
            allocation.accountId,
            allocation.personaId,
            locked.chainId,
            locked.tokenAddress,
            allocation.amountAtomic.toString(),
            allocation.allocationKind === "external_fallback"
              ? "external_fallback"
              : "megapot_allocation",
            allocation.creditSourceReference,
          ],
          readonly: false,
        });
      }
      yield* transaction.execute({
        label: "megapot-allocation.row.create",
        text: `INSERT INTO megapot_allocations (
                 allocation_batch_id, ordinal, account_id, persona_id,
                 amount_atomic, allocation_kind, credit_id
               ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        values: [
          input.allocationBatchId,
          allocation.ordinal,
          allocation.accountId,
          allocation.personaId,
          allocation.amountAtomic.toString(),
          allocation.allocationKind,
          allocation.creditId,
        ],
        readonly: false,
      });
    }

    const platformAllocation = input.allocations.find(
      (allocation) => allocation.allocationKind === "platform_sponsorship",
    );
    if (platformAllocation !== undefined) {
      const budgetResult = yield* transaction.execute<Row>({
        label: "megapot-allocation.sponsorship-budget.read",
        text: `SELECT sponsor_account_id, chain_id, token_address, funded_atomic,
                      winnings_credited_atomic, reserved_atomic, spent_atomic, withdrawn_atomic
                 FROM platform_sponsorship_budgets
                WHERE sponsor_account_id=$1 FOR UPDATE`,
        values: [platformAllocation.accountId],
        readonly: false,
      });
      if (budgetResult.rows.length !== 1) return yield* rejected("allocation-invalid");
      const budget = budgetResult.rows[0] as Row;
      const nextWinnings =
        bigint(budget, "winnings_credited_atomic") + platformAllocation.amountAtomic;
      const balanceHash = sponsorshipBalanceHash({
        sponsorAccountId: text(budget, "sponsor_account_id"),
        chainId: integer(budget, "chain_id"),
        tokenAddress: text(budget, "token_address"),
        fundedAtomic: bigint(budget, "funded_atomic"),
        winningsCreditedAtomic: nextWinnings,
        reservedAtomic: bigint(budget, "reserved_atomic"),
        spentAtomic: bigint(budget, "spent_atomic"),
        withdrawnAtomic: bigint(budget, "withdrawn_atomic"),
      });
      const updated = yield* transaction.execute({
        label: "megapot-allocation.sponsorship-budget.credit",
        text: `UPDATE platform_sponsorship_budgets
                  SET winnings_credited_atomic=$2, updated_at=clock_timestamp()
                WHERE sponsor_account_id=$1 AND chain_id=$3 AND token_address=$4`,
        values: [
          platformAllocation.accountId,
          nextWinnings.toString(),
          locked.chainId,
          locked.tokenAddress,
        ],
        readonly: false,
      });
      if (updated.rowCount !== 1) return yield* rejected("allocation-invalid");
      yield* transaction.execute({
        label: "megapot-allocation.sponsorship-entry.create",
        text: `INSERT INTO platform_sponsorship_budget_entries (
                 budget_entry_id, sponsor_account_id, entry_kind, amount_atomic,
                 source_reference, balance_hash
               ) VALUES ($1,$2,'winnings_credited',$3,$4,$5)`,
        values: [
          keccak256(
            toBytes(`pirate.platform-sponsorship-winning.v1\u0000${input.allocationBatchId}`),
          ),
          platformAllocation.accountId,
          platformAllocation.amountAtomic.toString(),
          input.allocationBatchId,
          balanceHash,
        ],
        readonly: false,
      });
    }

    const allocatedVersion = locked.drawingVersion + 1;
    yield* transaction.execute({
      label: "megapot-allocation.allocated-transition.create",
      text: `INSERT INTO megapot_pool_drawing_transitions (
               pool_leg_id, drawing_id, target_version, event_type, event
             ) VALUES ($1,$2,$3,'allocated',jsonb_build_object(
               'allocation_batch_id',$4::text,'allocation_hash',$5::text
             ))`,
      values: [
        locked.poolLegId,
        locked.drawingId.toString(),
        allocatedVersion,
        input.allocationBatchId,
        input.allocationHash,
      ],
      readonly: false,
    });
    const allocated = yield* transaction.execute({
      label: "megapot-allocation.drawing.allocate",
      text: `UPDATE megapot_pool_drawings
                SET status='allocated', version=$3, allocation_batch_id=$4,
                    updated_at=clock_timestamp()
              WHERE pool_leg_id=$1 AND drawing_id=$2 AND status='claimed' AND version=$5`,
      values: [
        locked.poolLegId,
        locked.drawingId.toString(),
        allocatedVersion,
        input.allocationBatchId,
        locked.drawingVersion,
      ],
      readonly: false,
    });
    if (allocated.rowCount !== 1) return yield* rejected("effect-conflict");

    const creditedBatch = yield* transaction.execute({
      label: "megapot-allocation.batch.credit",
      text: `UPDATE megapot_allocation_batches
                SET state='credited', credited_at=$2
              WHERE allocation_batch_id=$1 AND state='prepared'`,
      values: [input.allocationBatchId, input.creditedAt],
      readonly: false,
    });
    if (creditedBatch.rowCount !== 1) return yield* rejected("effect-conflict");

    const creditedVersion = allocatedVersion + 1;
    yield* transaction.execute({
      label: "megapot-allocation.credited-transition.create",
      text: `INSERT INTO megapot_pool_drawing_transitions (
               pool_leg_id, drawing_id, target_version, event_type, event
             ) VALUES ($1,$2,$3,'credited',jsonb_build_object(
               'allocation_batch_id',$4::text
             ))`,
      values: [
        locked.poolLegId,
        locked.drawingId.toString(),
        creditedVersion,
        input.allocationBatchId,
      ],
      readonly: false,
    });
    const creditedDrawing = yield* transaction.execute({
      label: "megapot-allocation.drawing.credit",
      text: `UPDATE megapot_pool_drawings
                SET status='credited', version=$3, updated_at=clock_timestamp(),
                    terminal_at=$4
              WHERE pool_leg_id=$1 AND drawing_id=$2
                AND status='allocated' AND version=$5`,
      values: [
        locked.poolLegId,
        locked.drawingId.toString(),
        creditedVersion,
        input.creditedAt,
        allocatedVersion,
      ],
      readonly: false,
    });
    if (creditedDrawing.rowCount !== 1) return yield* rejected("effect-conflict");

    return {
      allocationBatchId: input.allocationBatchId,
      poolLegId: locked.poolLegId,
      drawingId: locked.drawingId,
      snapshotId: locked.snapshotId,
      claimEffectId: locked.claimEffectId,
      netWinningsAtomic: locked.netWinningsAtomic,
      allocationHash: input.allocationHash,
      allocations: input.allocations,
      state: "credited",
    };
  });
}

export function makeControlPlaneMegapotAllocationRepository() {
  return {
    loadCandidate: (input: Parameters<MegapotAllocationStore["loadCandidate"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* loadCandidateIn(db, { ...input, lock: false });
      }).pipe(mapped),
    findResult: (allocationBatchId: string) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* findResultIn(db, allocationBatchId);
      }).pipe(mapped),
    credit: (input: Parameters<MegapotAllocationStore["credit"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) => creditIn(transaction, input));
      }).pipe(mapped),
  };
}

export const makeControlPlaneMegapotAllocationStore = (
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): MegapotAllocationStore => {
  const repository = makeControlPlaneMegapotAllocationRepository();
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    mapped(Effect.provide(layer)(effect));
  return {
    loadCandidate: (input) => provide(repository.loadCandidate(input)),
    findResult: (allocationBatchId) => provide(repository.findResult(allocationBatchId)),
    credit: (input) => provide(repository.credit(input)),
  };
};
