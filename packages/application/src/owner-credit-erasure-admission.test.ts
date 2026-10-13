import { expect, test } from 'bun:test';
import { ControlPlaneStatementFailed } from './ports.ts';
import { Effect } from 'effect';
import { makeOwnerAwareAccountErasureAdmission, type OwnerCreditErasureAdmissionStore } from './owner-credit-erasure-admission.ts';
import type { AccountErasureAdmissionSnapshot } from './use-cases/account-erasure-orchestration.ts';
const clear: AccountErasureAdmissionSnapshot = { community_ownership:'clear', hns_authority:'clear', operator_principal:'clear', persona_wallet_custody:'clear', financial_effects:'clear', required_authorities:'clear' };
const store = (outcome: 'clear' | 'blocked'): OwnerCreditErasureAdmissionStore => ({ read: () => Effect.succeed({ outcome, financialHistoryRetained:true }) });
test('original unbound owner credit blocks erasure even when prior account checks are clear', async () => {
 const evaluate=makeOwnerAwareAccountErasureAdmission({readSnapshot:()=>Effect.succeed(clear),ownerCredits:store('blocked')});
 expect(await Effect.runPromise(evaluate('account'))).toEqual({outcome:'conflict',conflicts:[{category:'financial_effect_pending',owners:['financial_effects']}]});
});
test('unknown native census remains unknown and retains every unrelated original blocker', async () => {
 const evaluate=makeOwnerAwareAccountErasureAdmission({readSnapshot:()=>Effect.succeed({...clear,community_ownership:'blocked'}),ownerCredits:{read:()=>Effect.fail(new ControlPlaneStatementFailed({label:'census',sqlState:null,constraint:null,outcomeCertainty:'not-started'}))}});
 const result=await Effect.runPromise(evaluate('account'));
 expect(result).toEqual({outcome:'conflict',conflicts:[{category:'community_owner_transfer_required',owners:['community_ownership']},{category:'custody_status_unknown',owners:['financial_effects']}]});
});
test('paid original debt can clear the credit census but never clears existing custody or financial holds',async()=>{
 const evaluate=makeOwnerAwareAccountErasureAdmission({readSnapshot:()=>Effect.succeed({...clear,financial_effects:'blocked'}),ownerCredits:store('clear')});
 expect(await Effect.runPromise(evaluate('account'))).toEqual({outcome:'conflict',conflicts:[{category:'financial_effect_pending',owners:['financial_effects']}]});
});
