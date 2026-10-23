import { Effect, type Layer, Schema } from "effect";
import {
  type ControlPlaneDb,
  type ControlPlaneError,
  ControlPlaneOperationTimedOut,
  ControlPlaneStatementFailed,
  ControlPlaneTransactionOutcomeUnknown,
} from "../../application/src/ports.ts";
import {
  FixedUsdcBonusBudgetReceipt,
  FixedUsdcBonusCustodyReceipt,
  FixedUsdcBonusFundingFailed,
  type FixedUsdcBonusFundingStore,
  FixedUsdcBonusObservationReceipt,
} from "../../application/src/rewards/fixed-usdc-bonus-funding.ts";
import { withRetainedControlPlaneCommandTransaction } from "./control-plane-command-transaction.ts";

const failure = (reason: FixedUsdcBonusFundingFailed["reason"]) =>
  new FixedUsdcBonusFundingFailed({ reason });
function classify(error: unknown) {
  if (error instanceof FixedUsdcBonusFundingFailed) return error;
  if (
    error instanceof ControlPlaneTransactionOutcomeUnknown ||
    (error instanceof ControlPlaneOperationTimedOut && error.outcomeCertainty === "unknown")
  )
    return failure("outcome-unknown");
  if (error instanceof ControlPlaneStatementFailed) {
    switch (error.sqlState) {
      case "FUB00":
        return failure("invalid-input");
      case "FUB01":
        return failure("idempotency-conflict");
      case "FUB02":
        return failure("capacity");
      case "FUB03":
        return failure("custody-unavailable");
      case "FUB04":
        return failure("song-unavailable");
    }
  }
  return failure("unavailable");
}

/** Private operator-purpose persistence, not a participant funding endpoint.
 * No command is retried here, and no chain operation or activation is dispatched.
 * The caller must retain the original prepared packet before attempting it. */
export function makeFixedUsdcBonusFundingStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError>,
): FixedUsdcBonusFundingStore {
  const call = <S extends Schema.ConstraintDecoder<unknown>>(
    procedure:
      | "admit_fixed_usdc_bonus_custody_v1"
      | "observe_fixed_usdc_bonus_solvency_v1"
      | "allocate_fixed_usdc_bonus_budget_v1",
    document: unknown,
    hash: string,
    schema: S,
    bound: (receipt: S["Type"]) => boolean,
  ) =>
    withRetainedControlPlaneCommandTransaction((tx) =>
      Effect.gen(function* () {
        const result = yield* tx.execute<{ receipt: unknown }>({
          label: `fixed-usdc-bonus.${procedure}`,
          text: `SELECT ${procedure}($1::jsonb,$2) AS receipt`,
          values: [JSON.stringify(document), hash],
          readonly: false,
        });
        if (
          result.rows.length !== 1 ||
          result.rows[0] === undefined ||
          !Object.hasOwn(result.rows[0], "receipt")
        )
          return yield* failure("outcome-unknown");
        const receipt = yield* Effect.try({
          try: () =>
            Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(
              result.rows[0]?.receipt,
            ),
          catch: () => failure("invalid-row"),
        });
        if (!bound(receipt)) return yield* failure("invalid-row");
        return receipt;
      }),
    ).pipe(Effect.provide(runtime), Effect.mapError(classify));
  return {
    admitCustody: ({ policy, policyHash }) =>
      call(
        "admit_fixed_usdc_bonus_custody_v1",
        policy,
        policyHash,
        FixedUsdcBonusCustodyReceipt,
        (r) => r.custody_id === policy.custody_id && r.policy_hash === policyHash,
      ),
    observe: ({ observation, observationHash }) =>
      call(
        "observe_fixed_usdc_bonus_solvency_v1",
        observation,
        observationHash,
        FixedUsdcBonusObservationReceipt,
        (r) =>
          r.custody_id === observation.custody_id &&
          r.observation_id === observation.observation_id &&
          r.observation_hash === observationHash,
      ),
    allocateBudget: ({ command, requestHash }) =>
      call(
        "allocate_fixed_usdc_bonus_budget_v1",
        command,
        requestHash,
        FixedUsdcBonusBudgetReceipt,
        (r) =>
          r.custody_id === command.custody_id &&
          r.budget_id === command.budget_id &&
          r.request_hash === requestHash &&
          r.amount_per_account_atomic === command.amount_per_account_atomic &&
          r.maximum_accounts === command.maximum_accounts &&
          r.ends_at_ms === command.ends_at_ms &&
          r.participation_starts_at_ms >= command.starts_at_ms,
      ),
  };
}
