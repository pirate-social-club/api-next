import {Schema} from 'effect';
import {AuthError,BadRequest,GetAccountStudyRewardPreviewV1,GetOwnerAccountStudySessionV1,GetOwnerAccountStudyStartOperationV1,GetPublicGuestStudyPreparedContentV2,ProviderUnavailable,StartOwnerAccountStudySessionV1,SubmitOwnerAccountStudyAnswerV1} from '@pirate/contracts';
import type {OwnerAccountStudyFacade} from '@pirate/platform-cf/owner-account-study-facade';
import type {makeGuestAuthorityComposition} from './guest-authority-controller-composition.ts';
import {makeOwnerAccountStudyHandlers,type OwnerAccountStudyHandlerName} from './owner-account-study-handlers.ts';
import type {VerifiedHnsCommunityAppApiRequest} from './hns-community-app-api-transport.ts';
import type {DecodedRequest,EndpointHandlerResult} from './transport.ts';
export type {OwnerAccountStudyHandlerName} from './owner-account-study-handlers.ts';
export const isOwnerAccountStudyHandlerName=Schema.is(Schema.Literals(['GetPublicGuestStudyPreparedContentV2','GetAccountStudyRewardPreviewV1','StartOwnerAccountStudySessionV1','GetOwnerAccountStudySessionV1','GetOwnerAccountStudyStartOperationV1','SubmitOwnerAccountStudyAnswerV1']));
const definitions={GetPublicGuestStudyPreparedContentV2,GetAccountStudyRewardPreviewV1,StartOwnerAccountStudySessionV1,GetOwnerAccountStudySessionV1,GetOwnerAccountStudyStartOperationV1,SubmitOwnerAccountStudyAnswerV1} as const;
/** Cookie's independently reviewed actual ordinary classifier successor is a
 * required source dependency, never a void admission callback/generic principal. */
export function makeOwnerAccountStudyComposition(deps:Readonly<{authority:ReturnType<typeof makeGuestAuthorityComposition>;facade:OwnerAccountStudyFacade}>){
 const controllers=makeOwnerAccountStudyHandlers(deps.facade);
 return Object.freeze({controllers,
  async handleOwnerStudy119Operation(input:Readonly<{
   name:OwnerAccountStudyHandlerName;request:Request;verifiedHns?:VerifiedHnsCommunityAppApiRequest;
   decodeRequestLocations:()=>Promise<Omit<DecodedRequest,'principal'|'browserParticipation'>>;
  }>):Promise<EndpointHandlerResult>{
   const definition=definitions[input.name];
   if('implementation' in definition&&definition.implementation==='disabled')throw new ProviderUnavailable({message:'Study interface is unavailable'});
   if(input.request.method!==definition.method)throw new BadRequest({message:'Study request method is invalid'});
   if(input.name==='GetPublicGuestStudyPreparedContentV2'){
    const locations=await input.decodeRequestLocations();return controllers[input.name]({...locations,principal:null});
   }
   // Purpose/canonical account/exact Origin+ordinary CSRF before any body decode,
   // hash, selected birth, provider or paid reserve. No Guest credential lookup.
   const authenticated=await deps.authority.requestAuthentication.authenticateOrdinaryAccount({
    request:input.request,purpose:'ordinary_account',unsafe:definition.method==='POST',
    ...(input.verifiedHns===undefined?{}:{verifiedHns:input.verifiedHns}),
   });
   if(authenticated.account.kind!=='ordinary_account')throw new AuthError({message:'Ordinary browser authentication required'});
   const locations=await input.decodeRequestLocations();
   // This principal comes ONLY from the actual verified classifier; protected
   // sessionBinding stays in that private value and is never sent to a handler/DB.
   return controllers[input.name]({...locations,principal:{kind:'user',subject:authenticated.account.accountId}});
  },
 });
}
