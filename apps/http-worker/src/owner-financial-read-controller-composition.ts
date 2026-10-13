import type {ControlPlaneDb,ControlPlaneError} from '@pirate/application';
import {AuthError,BadRequest,GetMyOwnerParticipationV1,GetMyOwnerRewardCreditV1,InternalError,ListMyOwnerParticipationsV1,ListMyOwnerRewardCreditsV1,ProviderUnavailable} from '@pirate/contracts';
import {makeControlPlaneOwnerParticipationReadStore} from '@pirate/platform-cf/owner-participation-read-store';
import {makeControlPlaneOwnerRewardCreditReads} from '@pirate/platform-cf/owner-reward-credit-read-store';
import {type Layer,Schema} from 'effect';
import type {makeGuestAuthorityComposition} from './guest-authority-controller-composition.ts';
import type {VerifiedHnsCommunityAppApiRequest} from './hns-community-app-api-transport.ts';
import {makeOwnerParticipationReadHandlers} from './owner-participation-read-handlers.ts';
import {makeOwnerRewardCreditReadHandlers} from './owner-reward-credit-read-handlers.ts';
import {type DecodedRequest,type EndpointHandlerResult,withEndpointResult} from './transport.ts';
const names=Schema.Literals(['ListMyOwnerRewardCreditsV1','GetMyOwnerRewardCreditV1','ListMyOwnerParticipationsV1','GetMyOwnerParticipationV1']);
export type OwnerFinancialReadName=Schema.Schema.Type<typeof names>;
export const isOwnerFinancialReadName=Schema.is(names);
const definitions={ListMyOwnerRewardCreditsV1,GetMyOwnerRewardCreditV1,ListMyOwnerParticipationsV1,GetMyOwnerParticipationV1} as const;
/** Called ONLY by the financial graph after real five-principal readiness.
 * The generic principal path cannot admit these names without that graph.
 * Account purposes/canonical identity/exact origin are verified before decoding;
 * no Guest cookie, claimed account, setup identity or session-binding cast. */
export function makeOwnerFinancialReadComposition(deps:Readonly<{
 authority:ReturnType<typeof makeGuestAuthorityComposition>;
 controlPlane:Layer.Layer<ControlPlaneDb,ControlPlaneError,never>;
}>){
 const controllers={
  ...makeOwnerRewardCreditReadHandlers(makeControlPlaneOwnerRewardCreditReads(deps.controlPlane)),
  ...makeOwnerParticipationReadHandlers(makeControlPlaneOwnerParticipationReadStore(deps.controlPlane)),
 };
 const strictResponse=(schema:Schema.ConstraintDecoder<unknown>,value:unknown):unknown=>{
  try{return Schema.decodeUnknownSync(schema,{onExcessProperty:'error'})(value);}
  catch{throw new InternalError({message:'Financial recovery projection is unavailable'});}
 };
 return Object.freeze({
  async handleOwnerFinancialReadOperation(input:Readonly<{
   name:OwnerFinancialReadName;request:Request;verifiedHns?:VerifiedHnsCommunityAppApiRequest;
   decodeRequestLocations:()=>Promise<Omit<DecodedRequest,'principal'|'browserParticipation'>>;
  }>):Promise<EndpointHandlerResult>{
   const definition=definitions[input.name];
   if('implementation' in definition&&definition.implementation==='disabled')throw new ProviderUnavailable({message:'Financial recovery interface is unavailable'});
   if(input.request.method!==definition.method)throw new BadRequest({message:'Financial recovery request method is invalid'});
   const authenticated=await deps.authority.requestAuthentication.authenticateOrdinaryAccount({
    request:input.request,purpose:'ordinary_account',unsafe:false,
    ...(input.verifiedHns===undefined?{}:{verifiedHns:input.verifiedHns}),
   });
   if(authenticated.account.kind!=='ordinary_account')throw new AuthError({message:'Ordinary browser authentication required'});
   const locations=await input.decodeRequestLocations();
   const body=await controllers[input.name]({...locations,principal:{kind:'user',subject:authenticated.account.accountId}});
   return withEndpointResult(strictResponse(definition.response,body),undefined,{'Cache-Control':'private, no-store'});
  },
 });
}
