import {ControlPlaneDb,type ControlPlaneError,ControlPlaneStatementFailed} from '@pirate/application';
import type {OwnerParticipationReadStore} from '@pirate/application/owner-participation-reads';
import {type GuestParticipationReadStore,GuestParticipationStoreRejected} from '@pirate/application/guest-participation-authority';
import {GuestCredentialIdV1,GuestIdentifierV1,GuestParticipationProjectionV1} from '@pirate/contracts';
import {Effect,type Layer,Schema} from 'effect';
import {boundedLearnerAudioTransaction} from './bounded-audio-transaction.ts';
const Page=Schema.Struct({items:Schema.Array(GuestParticipationProjectionV1).check(Schema.isMaxLength(100)),nextCursor:Schema.NullOr(GuestIdentifierV1)});
const Origin=Schema.String.check(Schema.isMaxLength(2048),Schema.makeFilter(value=>{
 try{const url=new URL(value);return url.protocol==='https:'&&url.origin===value?undefined:'Canonical HTTPS origin required';}catch{return 'Canonical HTTPS origin required';}
}));
const GuestAccess=Schema.Struct({kind:Schema.Literal('guest'),ownerId:GuestIdentifierV1,credentialId:GuestCredentialIdV1,origin:Origin});
const BoundAccess=Schema.Struct({kind:Schema.Literal('bound_account'),accountId:GuestIdentifierV1,sessionBinding:Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))});
const GuestInput=Schema.Struct({access:Schema.Union([GuestAccess,BoundAccess]),cursor:Schema.NullOr(GuestIdentifierV1),limit:Schema.Int.check(Schema.isBetween({minimum:1,maximum:100}))});
const AccountListInput=Schema.Struct({accountId:GuestIdentifierV1,cursor:Schema.NullOr(GuestIdentifierV1),limit:Schema.Int.check(Schema.isBetween({minimum:1,maximum:100}))});
const AccountGetInput=Schema.Struct({accountId:GuestIdentifierV1,participationId:GuestIdentifierV1});
const invalid=(label:string,started:boolean)=>new ControlPlaneStatementFailed({label,sqlState:null,constraint:null,outcomeCertainty:started?'completed':'not-started'});
function page(value:unknown,limit:number){
 const parsed=Schema.decodeUnknownSync(Page,{onExcessProperty:'error'})(value);
 if(parsed.items.length>limit||new Set(parsed.items.map(i=>i.participation_id)).size!==parsed.items.length
  ||parsed.nextCursor!==null&&parsed.items.at(-1)?.participation_id!==parsed.nextCursor)throw new Error();
 return parsed;
}
const mapFailure=(error:ControlPlaneStatementFailed):Effect.Effect<never,ControlPlaneError|GuestParticipationStoreRejected>=>{
 switch(error.sqlState){
  case 'GP001':return Effect.fail(new GuestParticipationStoreRejected({reason:'proof-revoked'}));
  case 'GP002':return Effect.fail(new GuestParticipationStoreRejected({reason:'owner-mismatch'}));
  case 'GP003':return Effect.fail(new GuestParticipationStoreRejected({reason:'authority-conflict'}));
  case 'GP009':return Effect.fail(new GuestParticipationStoreRejected({reason:'not-found'}));
  default:return Effect.fail(error);
 }
};
/** Guest proof recovery (including an actual bound-account context) stays inside
 * its original bounded owning transaction. No token/digest/lease is forwarded. */
export function makeControlPlaneOwnerGuestParticipationReadStore(runtime:Layer.Layer<ControlPlaneDb,ControlPlaneError,never>):GuestParticipationReadStore{
 return{list:Effect.fn('OwnerGuestParticipationReadStore.list')(function*(input:Parameters<GuestParticipationReadStore['list']>[0]){
  const checked=yield* Effect.try({try:()=>Schema.decodeUnknownSync(GuestInput,{onExcessProperty:'error'})(input),catch:()=>invalid('owner-participation.guest.input',false)});
  return yield* boundedLearnerAudioTransaction(transaction=>transaction.execute<unknown>({
   label:'owner-participation.guest.list',
   text:checked.access.kind==='guest'?'SELECT list_guest_owner_participations_v1($1::jsonb,$2,$3) AS result':'SELECT list_account_owner_participations_v1($1,$2,$3) AS result',
   values:[checked.access.kind==='guest'?JSON.stringify(checked.access):checked.access.accountId,checked.cursor,checked.limit],readonly:false,
  }).pipe(Effect.flatMap(response=>Effect.try({try:()=>{
   if(response.rows.length!==1)throw new Error();
   const row=Schema.decodeUnknownSync(Schema.Struct({result:Schema.Unknown}),{onExcessProperty:'error'})(response.rows[0]);
   return page(row.result,checked.limit);
  },catch:()=>invalid('owner-participation.guest.decode',true)}))))
   .pipe(Effect.catchTag('ControlPlaneStatementFailed',mapFailure),Effect.provide(runtime));
 })};
}
export function makeControlPlaneOwnerParticipationReadStore(runtime:Layer.Layer<ControlPlaneDb,ControlPlaneError,never>):OwnerParticipationReadStore{
 const call=Effect.fn('OwnerParticipationReadStore.call')(function*<A>(label:string,text:string,values:readonly unknown[],decode:(value:unknown)=>A):Effect.fn.Return<A,ControlPlaneError,ControlPlaneDb>{
  const db=yield* ControlPlaneDb;
  const response=yield* db.execute<unknown>({label,text,values,readonly:true});
  return yield* Effect.try({try:()=>{
   if(response.rows.length!==1)throw new Error();
   const row=Schema.decodeUnknownSync(Schema.Struct({result:Schema.Unknown}),{onExcessProperty:'error'})(response.rows[0]);
   return decode(row.result);
  },catch:()=>invalid(`${label}.decode`,true)});
 });
 return{
  list:Effect.fn('OwnerParticipationReadStore.list')(function*(input:Parameters<OwnerParticipationReadStore['list']>[0]){
   const checked=yield* Effect.try({try:()=>Schema.decodeUnknownSync(AccountListInput,{onExcessProperty:'error'})(input),catch:()=>invalid('owner-participation.account.input',false)});
   const result=yield* call('owner-participation.account.list','SELECT list_account_owner_participations_v1($1,$2,$3) AS result',[checked.accountId,checked.cursor,checked.limit],value=>page(value,checked.limit)).pipe(Effect.catchTag('ControlPlaneStatementFailed',mapFailure),Effect.provide(runtime));
   return{object:'owner_participation_list_v1' as const,items:result.items,next_cursor:result.nextCursor};
  }),
  get:Effect.fn('OwnerParticipationReadStore.get')(function*(input:Parameters<OwnerParticipationReadStore['get']>[0]){
   const checked=yield* Effect.try({try:()=>Schema.decodeUnknownSync(AccountGetInput,{onExcessProperty:'error'})(input),catch:()=>invalid('owner-participation.account.input',false)});
   return yield* call('owner-participation.account.get','SELECT get_account_owner_participation_v1($1,$2) AS result',[checked.accountId,checked.participationId],value=>{
    const result=Schema.decodeUnknownSync(GuestParticipationProjectionV1,{onExcessProperty:'error'})(value);
    if(result.participation_id!==checked.participationId)throw new Error();return result;
   }).pipe(Effect.catchTag('ControlPlaneStatementFailed',mapFailure),Effect.provide(runtime));
  }),
 };
}
