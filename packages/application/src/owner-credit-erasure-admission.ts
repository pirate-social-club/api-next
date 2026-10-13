import type { ControlPlaneError } from './ports.ts';
import { Effect } from 'effect';
import {
  evaluateAccountErasureAdmission,
  type AccountErasureAdmissionDecision,
  type AccountErasureAdmissionSnapshot,
} from './use-cases/account-erasure-orchestration.ts';
/** Actual native owner-credit census augments, and never replaces, the complete
 * retained erasure snapshot. Other funding/custody/provider authorities stay required. */
export interface OwnerCreditErasureAdmissionStore {
 readonly read: (accountId: string) => Effect.Effect<Readonly<{
  outcome: 'clear' | 'blocked'; financialHistoryRetained: boolean;
 }>, ControlPlaneError>;
}
export function makeOwnerAwareAccountErasureAdmission(deps: Readonly<{
 readSnapshot: (accountId: string) => Effect.Effect<AccountErasureAdmissionSnapshot, ControlPlaneError>;
 ownerCredits: OwnerCreditErasureAdmissionStore;
}>) {
 return Effect.fn('AccountErasure.ownerFinancialAdmission')(function* (accountId: string): Effect.fn.Return<AccountErasureAdmissionDecision, ControlPlaneError> {
  const original = yield* deps.readSnapshot(accountId);
  const owner = yield* deps.ownerCredits.read(accountId).pipe(
   Effect.match({ onFailure: () => 'unknown' as const, onSuccess: value => value.outcome }),
  );
  const financial_effects = original.financial_effects === 'blocked' || owner === 'blocked'
   ? 'blocked' : original.financial_effects === 'unknown' || owner === 'unknown' ? 'unknown' : 'clear';
  return evaluateAccountErasureAdmission({ ...original, financial_effects });
 });
}
