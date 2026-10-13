import {expect,test} from 'bun:test';
import {Cause,Effect,Exit,Option,Schema} from 'effect';
import {OwnerRewardCreditV1} from '@pirate/contracts';
import {makeDirectPostgresControlPlaneLayer,type PostgresClientLike,type PostgresQueryConfig} from './postgres.ts';
import {makeControlPlaneOwnerRecipientStores} from './owner-recipient-store.ts';
const owner='owner_00000000-0000-0000-0000-000000000001';
const operation={sourceOwnerId:owner,kind:'owner_claim' as const,idempotencyKey:'claim-1',requestHash:'a'.repeat(64)};
const account={kind:'ordinary_account' as const,accountId:'account-1',sessionBinding:'b'.repeat(64)};
const input={account,creditId:'credit-1',selectionRevision:null,operation};
const credit=Schema.decodeUnknownSync(OwnerRewardCreditV1)({
 object:'owner_reward_credit_v1',credit_id:'credit-1',identity_version:'owner_v1',owner_id:owner,community_id:'community-1',pool_leg_id:'leg-1',original_drawing_id:'7',chain_id:1,token_address:`0x${'1'.repeat(40)}`,token_decimals:6,
 amount_atomic:'5',available_atomic:'5',reserved_atomic:'0',paid_atomic:'0',source_kind:'megapot_allocation',state:'credited',created_at:'2026-10-13T00:00:00.000Z',updated_at:'2026-10-13T00:00:00.000Z',settled_at:null,claim:{status:'accepted',payout_status:'pending'},send:null,
 recipient:{kind:'account_owner',original_persona_id:'persona-1',selection:null,binding:{persona_id:'persona-1',bound_at:'2026-10-13T00:00:00.000Z',selection_revision:null}},
});
const completed={state:'completed',operation,outcomeId:'command-1',result:{outcome:'accepted',credit}};
function fixture(reply:unknown=completed,commitLoss=false,sqlState:string|null=null){
 const queries:PostgresQueryConfig[]=[];const logs:unknown[]=[];let commitAcknowledged=false;
 const client:PostgresClientLike={connect:async()=>{},end:async()=>{},query:async q=>{
  queries.push(q);
  if(q.text==='COMMIT'){if(commitLoss)throw new Error('lost acknowledgement');commitAcknowledged=true;}
  if(q.text.startsWith('SELECT claim_owner_reward_credit_v1')){
   if(sqlState!==null)throw Object.assign(new Error('private database detail must not escape'),{code:sqlState});
   return {rows:[{result:reply}],rowCount:1};
  }
  return {rows:[],rowCount:0};
 }};
 const layer=makeDirectPostgresControlPlaneLayer('postgres://fixture.invalid/owner-credit',{clientFactory:()=>client,logger:{info:(event,fields)=>logs.push({event,fields}),error:(event,fields)=>logs.push({event,fields})}});
 return{store:makeControlPlaneOwnerRecipientStores(layer),queries,logs,acknowledged:()=>commitAcknowledged};
}
function failure(exit:Awaited<ReturnType<typeof Effect.runPromiseExit>>){
 if(!Exit.isFailure(exit))throw new Error('expected refusal');
 const result=Cause.findErrorOption(exit.cause);if(!Option.isSome(result))throw new Error('expected typed failure');return result.value;
}
test('claim result becomes observable only after acknowledged whole transaction COMMIT',async()=>{
 const f=fixture();const result=await Effect.runPromise(f.store.claims.claim(input));
 expect(f.acknowledged()).toBe(true);expect(result).toEqual(completed);
 expect(f.queries.at(-1)?.text).toBe('COMMIT');
});
test('sent COMMIT uncertainty stays typed and supplies no completed claim/recipient effect',async()=>{
 const f=fixture(completed,true);const exit=await Effect.runPromiseExit(f.store.claims.claim(input));
 expect(failure(exit)).toMatchObject({_tag:'ControlPlaneTransactionOutcomeUnknown'});
 expect(f.acknowledged()).toBe(false);expect(f.queries.some(q=>q.text==='COMMIT')).toBe(true);
});
test('malformed/excess/wrong credit/original-owner receipts roll back before COMMIT',async()=>{
 for(const raw of[{...completed,private_digest:'c'.repeat(64)},{...completed,operation:{...operation,sourceOwnerId:'foreign'}},{...completed,result:{...completed.result,credit:{...credit,credit_id:'foreign'}}},{...completed,result:{...completed.result,credit:{...credit,owner_id:'foreign'}}}]){
  const f=fixture(raw);const exit=await Effect.runPromiseExit(f.store.claims.claim(input));
  expect(failure(exit)).toMatchObject({_tag:'ControlPlaneStatementFailed',label:'owner-credit.claim.decode'});
  expect(f.queries.some(q=>q.text==='ROLLBACK')).toBe(true);expect(f.queries.some(q=>q.text==='COMMIT')).toBe(false);
  expect(JSON.stringify(failure(exit))).not.toContain('private_digest');expect(JSON.stringify(f.logs)).not.toContain('c'.repeat(64));
 }
});
test('only exact private SQLSTATE codes map; unknown server errors retain structured privacy',async()=>{
 const mappings:readonly [string,string][]=[['GP001','proof-revoked'],['GP002','owner-mismatch'],['GP003','authority-conflict'],['GP005','idempotency-conflict'],['GP006','intent-expired'],['GP008','target-changed'],['GP009','not-found'],['GP013','recipient-selection-conflict']];
 for(const [state,reason] of mappings){
  const f=fixture(completed,false,state);const exit=await Effect.runPromiseExit(f.store.claims.claim(input));
  expect(failure(exit)).toMatchObject({_tag:'GuestParticipationStoreRejected',reason});
 }
 for(const state of ['P0001','42702']){
  const exit=await Effect.runPromiseExit(fixture(completed,false,state).store.claims.claim(input));
  expect(failure(exit)).toMatchObject({_tag:'ControlPlaneStatementFailed',sqlState:state});expect(JSON.stringify(failure(exit))).not.toContain('private database detail');
 }
});
test('account-owner NULL revision is mandatory and guest revision cannot be silently substituted',async()=>{
 const f=fixture();const exit=await Effect.runPromiseExit(f.store.claims.claim({...input,selectionRevision:1}));
 expect(failure(exit)).toMatchObject({_tag:'ControlPlaneStatementFailed',label:'owner-credit.claim.decode'});
 expect(f.queries.some(q=>q.text==='COMMIT')).toBe(false);
});
