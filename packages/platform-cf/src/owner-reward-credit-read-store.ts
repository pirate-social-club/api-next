import {ControlPlaneDb,type ControlPlaneError,ControlPlaneStatementFailed} from '@pirate/application';
import type {OwnerRewardCreditReadStore} from '@pirate/application/owner-reward-credit-reads';
import {GuestParticipationStoreRejected} from '@pirate/application/guest-participation-authority';
import {GuestIdentifierV1,OwnerRewardCreditV1} from '@pirate/contracts';
import {Effect,type Layer,Schema} from 'effect';
const List=Schema.Struct({object:Schema.Literal('owner_reward_credit_list_v1'),items:Schema.Array(OwnerRewardCreditV1).check(Schema.isMaxLength(100)),next_cursor:Schema.NullOr(GuestIdentifierV1)});
export function makeControlPlaneOwnerRewardCreditReads(layer:Layer.Layer<ControlPlaneDb,ControlPlaneError,never>):OwnerRewardCreditReadStore{
 const call=Effect.fn('OwnerRewardCreditReads.call')(function*<A>(label:string,text:string,values:readonly unknown[],schema:Schema.ConstraintDecoder<A>,validate:(result:A)=>void):Effect.fn.Return<A,ControlPlaneError,ControlPlaneDb>{
  const db=yield* ControlPlaneDb;
  const result=yield* db.execute({label,text,values,readonly:true});
  return yield* Effect.try({try:()=>{
   if(result.rows.length!==1)throw new Error();
   const row=Schema.decodeUnknownSync(Schema.Struct({result:schema}),{onExcessProperty:'error'})(result.rows[0]);validate(row.result);return row.result;
  },catch:()=>new ControlPlaneStatementFailed({label:`${label}.decode`,sqlState:null,constraint:null,outcomeCertainty:'completed'})});
 });
 const provide=<A>(effect:Effect.Effect<A,ControlPlaneError,ControlPlaneDb>)=>effect.pipe(Effect.catchTag('ControlPlaneStatementFailed',error=>Effect.fail(error.sqlState==='GP009'?new GuestParticipationStoreRejected({reason:'not-found'}):error)),Effect.provide(layer));
 return{
  list:input=>provide(call('owner-reward-credit.list','SELECT list_owned_reward_credits_v1($1,$2,$3) AS result',[input.accountId,input.cursor,input.limit],List,result=>{
   if(result.items.length>input.limit||new Set(result.items.map(c=>c.credit_id)).size!==result.items.length||result.next_cursor!==null&&result.items.at(-1)?.credit_id!==result.next_cursor)throw new Error();
  })),
  get:input=>provide(call('owner-reward-credit.get','SELECT get_owned_reward_credit_v1($1,$2) AS result',[input.accountId,input.creditId],OwnerRewardCreditV1,result=>{if(result.credit_id!==input.creditId)throw new Error();})),
 };
}
