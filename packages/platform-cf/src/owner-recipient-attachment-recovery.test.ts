import {expect,test} from 'bun:test';
import {Cause,Effect,Exit,Option,Schema} from 'effect';
import {GuestAttachmentBindingV1} from '@pirate/contracts';
import {makeDirectPostgresControlPlaneLayer,type PostgresClientLike,type PostgresQueryConfig} from './postgres.ts';
import {makeControlPlaneOwnerRecipientStores} from './owner-recipient-store.ts';
const originalId='gai_'+'C'.repeat(21)+'A';
const binding=Schema.decodeUnknownSync(GuestAttachmentBindingV1)({attachment_id:originalId,owner_id:'original-guest',account_id:'original-A',state:'bound',bound_at:'2026-10-13T00:00:00.000Z'});
const input={account:{kind:'ordinary_account' as const,accountId:'canonical-B',sessionBinding:'b'.repeat(64)},attachmentId:originalId};
function fixture(reply:unknown=binding,commitLoss=false){
 const queries:PostgresQueryConfig[]=[];const logs:unknown[]=[];
 const client:PostgresClientLike={connect:async()=>{},end:async()=>{},query:async q=>{
  queries.push(q);if(q.text==='COMMIT'&&commitLoss)throw new Error('opaque acknowledgement');
  if(q.text.startsWith('SELECT find_bound_guest_attachment_v1'))return{rows:[{result:reply}],rowCount:1};
  return{rows:[],rowCount:0};
 }};
 const runtime=makeDirectPostgresControlPlaneLayer('postgres://fixture.invalid/original-attachment',{clientFactory:()=>client,logger:{info:(event,fields)=>logs.push({event,fields}),error:(event,fields)=>logs.push({event,fields})}});
 return{store:makeControlPlaneOwnerRecipientStores(runtime).attachment,queries,logs};
}
function failure(exit:Awaited<ReturnType<typeof Effect.runPromiseExit>>){
 if(!Exit.isFailure(exit))throw new Error('Expected refusal');const found=Cause.findErrorOption(exit.cause);if(!Option.isSome(found))throw new Error('Expected typed refusal');return found.value;
}
test('canonically authorized B recovers immutable originalA receipt after whole COMMIT without Guest proof',async()=>{
 const f=fixture();expect(await Effect.runPromise(f.store.findBoundAttachment(input))).toEqual(binding);
 expect(f.queries.find(q=>q.text.startsWith('SELECT find_bound_guest_attachment_v1'))?.values).toEqual(['canonical-B',originalId]);
 expect(f.queries.at(-1)?.text).toBe('COMMIT');expect(JSON.stringify(f.queries)).not.toContain(input.account.sessionBinding);
});
test('native inaccessible/not-yet-visible NULL remains NULL, never minted binding or alternate target',async()=>{
 const f=fixture(null);expect(await Effect.runPromise(f.store.findBoundAttachment(input))).toBeNull();
 expect(f.queries.some(q=>q.text.includes('confirm_guest_owner_attachment')||q.text.includes('INSERT'))).toBe(false);
});
test('foreign original locator and private excess fields roll back before durable response',async()=>{
 for(const raw of[{...binding,attachment_id:'gai_'+'D'.repeat(21)+'A'},{...binding,private_proof_digest:'c'.repeat(64)}]){
  const f=fixture(raw);expect(failure(await Effect.runPromiseExit(f.store.findBoundAttachment(input)))).toMatchObject({_tag:'ControlPlaneStatementFailed',label:'guest-attachment.bound.read.decode'});
  expect(f.queries.some(q=>q.text==='ROLLBACK')).toBe(true);expect(f.queries.some(q=>q.text==='COMMIT')).toBe(false);
  expect(JSON.stringify(f.logs)).not.toContain('c'.repeat(64));
 }
});
test('lost lookup COMMIT stays typed unknown; no accepted receipt/side effect inferred',async()=>{
 const f=fixture(binding,true);expect(failure(await Effect.runPromiseExit(f.store.findBoundAttachment(input)))).toMatchObject({_tag:'ControlPlaneTransactionOutcomeUnknown'});
 expect(f.queries.some(q=>q.text.includes('confirm_guest_owner_attachment'))).toBe(false);
});
