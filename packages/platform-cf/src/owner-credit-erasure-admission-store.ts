import { ControlPlaneDb, ControlPlaneStatementFailed, type ControlPlaneError } from '@pirate/application';
import type { OwnerCreditErasureAdmissionStore } from '@pirate/application/owner-credit-erasure-admission';
import { Effect, type Layer, Schema } from 'effect';
const Census = Schema.Struct({
 credit_liabilities: Schema.Array(Schema.Struct({
  chain_id: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  token_address: Schema.String,
  credit_count: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  owed_atomic: Schema.String.check(Schema.isPattern(/^[0-9]+$/u)),
  reserved_atomic: Schema.String.check(Schema.isPattern(/^[0-9]+$/u)),
 })),
 financial_history_retained: Schema.Boolean,
});
export function makeControlPlaneOwnerCreditErasureAdmission(layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>): OwnerCreditErasureAdmissionStore {
 const read = Effect.fn('OwnerCreditErasureAdmission.read')(function* (accountId: string) {
  const db = yield* ControlPlaneDb;
  return yield* db.withTransaction(transaction => Effect.gen(function* () {
   const result = yield* transaction.execute({ label: 'owner-credit.erasure.census', text: 'SELECT owner_credit_financial_erasure_holds_private_v1($1) AS result', values: [accountId], readonly: false });
   return yield* Effect.try({ try: () => {
    if (result.rows.length !== 1) throw new Error();
    const row = Schema.decodeUnknownSync(Schema.Struct({ result: Census }), { onExcessProperty: 'error' })(result.rows[0]);
    return { outcome: row.result.credit_liabilities.length > 0 ? 'blocked' as const : 'clear' as const, financialHistoryRetained: row.result.financial_history_retained };
   }, catch: () => new ControlPlaneStatementFailed({ label: 'owner-credit.erasure.census.decode', sqlState: null, constraint: null, outcomeCertainty: 'completed' }) });
  }));
 });
 return { read: accountId => read(accountId).pipe(Effect.provide(layer)) };
}
