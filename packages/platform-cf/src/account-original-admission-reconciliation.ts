import {
  type ControlPlaneDb,
  type ControlPlaneError,
  ControlPlaneStatementFailed,
  type ControlPlaneTransaction,
} from "@pirate/application";
import { Effect, type Layer, Schema } from "effect";
import { boundedLearnerAudioTransaction } from "./bounded-audio-transaction.ts";

const Identity = {
  mainOperationId: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  sourceOwnerId: Schema.String.check(Schema.isPattern(/^owner_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)),
  attemptNumber: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  attemptFence: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
};
const Candidate = Schema.Struct(Identity);
const Candidates = Schema.Array(Candidate).check(Schema.isMaxLength(8), Schema.makeFilter(rows =>
  new Set(rows.map(row => row.mainOperationId)).size === rows.length ? undefined : "Unique original operations required",
));
const Result = Schema.Union([
  Schema.Struct({ ...Identity, state: Schema.Literal("completed") }),
  Schema.Struct({ ...Identity, state: Schema.Literal("stale") }),
  Schema.Struct({ ...Identity, state: Schema.Literal("reconciled_no_commit"), changed: Schema.Boolean,
    participation: Schema.Struct({ state: Schema.Literals(["entry_closed", "unavailable"]) }),
  }),
]);
const Maximum = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 }));
const failed = (label: string) => new ControlPlaneStatementFailed({
  label, sqlState: null, constraint: null, outcomeCertainty: "completed",
});
/** Actual Account CONTROL_PLANE cron only. No browser/Guest proof, current
 * provider/configuration or grading authority. Every acknowledged result is
 * returned after its bounded owning transaction's COMMIT. */
export function makeControlPlaneAccountOriginalAdmissionReconciliation(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
) {
  const call = Effect.fn("AccountOriginalAdmissionReconciliation.call")(function* <S extends Schema.ConstraintDecoder<unknown>>(
    label: string, text: string, values: readonly unknown[], schema: S,
  ): Effect.fn.Return<S["Type"], ControlPlaneError> {
    const inTransaction = Effect.fn("AccountOriginalAdmissionReconciliation.transaction")(function* (tx: ControlPlaneTransaction) {
      const response = yield* tx.execute<unknown>({ label, text, values, readonly: false });
      return yield* Effect.try({
        try: () => {
          if (response.rows.length !== 1) throw new Error();
          const envelope = Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Unknown }), { onExcessProperty: "error" })(response.rows[0]);
          return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(envelope.result);
        }, catch: () => failed(label),
      });
    });
    return yield* boundedLearnerAudioTransaction(inTransaction).pipe(Effect.provide(runtime));
  });
  const recover = Effect.fn("AccountOriginalAdmissionReconciliation.recover")(function* (maximum: number) {
    const limit = yield* Effect.try({ try: () => Schema.decodeUnknownSync(Maximum)(maximum), catch: () => failed("account-original-admission.maximum") });
    const BoundedCandidates = Candidates.check(Schema.makeFilter(rows => rows.length <= limit ? undefined : "Bounded original list required"));
    const candidates = yield* call("account-original-admission.list",
      "SELECT list_account_owner_admission_reconciliation_due_v1($1::integer) AS result", [limit], BoundedCandidates);
    let completed = 0;
    let reconciled = 0;
    let stale = 0;
    for (const candidate of candidates) {
      const Matching = Result.check(Schema.makeFilter(result =>
        result.mainOperationId === candidate.mainOperationId && result.sourceOwnerId === candidate.sourceOwnerId
          && result.attemptNumber === candidate.attemptNumber && result.attemptFence === candidate.attemptFence
          ? undefined : "Exact original attempt receipt required",
      ));
      const result = yield* call("account-original-admission.reconcile",
        "SELECT reconcile_account_owner_admission_attempt_v1($1,$2,$3,$4::integer) AS result",
        [candidate.mainOperationId, candidate.sourceOwnerId, candidate.attemptFence, candidate.attemptNumber], Matching);
      if (result.state === "completed") completed++;
      else if (result.state === "stale") stale++;
      else reconciled++;
    }
    return { examined: candidates.length, completed, reconciled, stale };
  });
  return { recover };
}
