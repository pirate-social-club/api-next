import {expect,test} from 'bun:test';
import {ControlPlaneTransactionOutcomeUnknown,StudyV2CommandRejected} from '@pirate/application';
import {PERSONA_WALLET_SETUP_SESSION_SCOPE} from '@pirate/application/use-cases/identity-registration-handler';
import {AuthError,BadRequest,GuestPendingConflict} from '@pirate/contracts';
import type {OwnerAccountStudyFacade} from '@pirate/platform-cf/owner-account-study-facade';
import {Effect} from 'effect';
import {makeOwnerAccountStudyHandlers} from './owner-account-study-handlers.ts';
import {ownerSession,publicPrepared} from './owner-account-study-test-fixture.ts';
import type {Principal} from './transport.ts';
const body={idempotency_key:'start-original',persona_id:'persona-1',target_language:null,learner_band:null,timezone:'UTC',reward_preview_terms_hash:'c'.repeat(64),disclosure:{version:'disclosure-v1',accepted:true as const}};
function fixture(unknownStart=false){
 const calls:unknown[]=[];
 const unavailable=()=>Effect.fail(new StudyV2CommandRejected({reason:'provider-unavailable'}));
 const facade:OwnerAccountStudyFacade={
  publicPrepared:input=>Effect.sync(()=>{calls.push(input);return publicPrepared;}),
  preview:input=>Effect.sync(()=>{calls.push(input);return{reward_terms:ownerSession.reward_terms,reward_preview_terms_hash:'c'.repeat(64)};}),
  start:input=>{calls.push(input);return unknownStart?Effect.fail(new ControlPlaneTransactionOutcomeUnknown({phase:'commit',label:'owner-account-fixture',limitMs:1,elapsedMs:1})):Effect.succeed(ownerSession);},
  findStart:input=>Effect.sync(()=>{calls.push(input);return{state:'completed' as const,result:ownerSession};}),
  getSession:input=>Effect.sync(()=>{calls.push(input);return ownerSession;}),
  submitChoice:unavailable,submitAudio:unavailable,
 };
 return{handlers:makeOwnerAccountStudyHandlers(facade),calls};
}
test('public V2 preparation remains anonymous and contains no fabricated account/Guest proof',async()=>{
 const f=fixture();expect((await f.handlers.GetPublicGuestStudyPreparedContentV2({principal:null,params:{communityId:'community-1',postId:'post-1'},query:{},body:undefined})).body).toEqual(publicPrepared);
 expect(f.calls).toEqual([{communityId:'community-1',postId:'post-1',targetLanguage:null,learnerBand:null}]);
});
test('ordinary account and explicit persona are source inputs; actual full session remains nested without Guest reshaping',async()=>{
 const f=fixture();expect((await f.handlers.GetAccountStudyRewardPreviewV1({principal:{kind:'user',subject:'account-1'},params:{communityId:'community-1',postId:'post-1'},query:{persona_id:'persona-1'},body:undefined})).body).toEqual({reward_terms:ownerSession.reward_terms,reward_preview_terms_hash:'c'.repeat(64)});
 expect(f.calls[0]).toEqual({accountId:'account-1',communityId:'community-1',postId:'post-1',personaId:'persona-1',targetLanguage:null,learnerBand:null});
 const result=await f.handlers.GetOwnerAccountStudySessionV1({principal:{kind:'user',subject:'account-1'},params:{communityId:'community-1',sessionId:'session-1'},query:{},body:undefined});expect(result.body).toEqual(ownerSession);
});
test('setup/admin/device/anonymous reject before malformed body or private callback',async()=>{
 const principals:readonly(Principal|null)[]=[null,{kind:'admin',subject:'operator'},{kind:'device',subject:'device'},{kind:'user',subject:'setup',scopes:[PERSONA_WALLET_SETUP_SESSION_SCOPE]}];
 for(const principal of principals){const f=fixture();await expect(Promise.resolve().then(()=>f.handlers.StartOwnerAccountStudySessionV1({principal,params:{},query:{},body:{invented:true}}))).rejects.toBeInstanceOf(AuthError);expect(f.calls).toEqual([]);}
});
test('client ownership/margin/drawing fields and missing explicit consent are refused',async()=>{
 for(const changed of[{...body,account_id:'foreign'},{...body,purchase_safety_margin_seconds:1},{...body,original_drawing_id:'8'},{...body,disclosure:{version:'disclosure-v1',accepted:false}}]){
  const f=fixture();await expect(Promise.resolve().then(()=>f.handlers.StartOwnerAccountStudySessionV1({principal:{kind:'user',subject:'account-1'},params:{communityId:'community-1',postId:'post-1'},query:{},body:changed}))).rejects.toBeInstanceOf(BadRequest);expect(f.calls).toEqual([]);
 }
});
test('COMMIT unknown retains exact original start key in typed pending result rather than inventing an operation ID',async()=>{
 const f=fixture(true);
 await expect(Promise.resolve().then(()=>f.handlers.StartOwnerAccountStudySessionV1({principal:{kind:'user',subject:'account-1'},params:{communityId:'community-1',postId:'post-1'},query:{},body}))).rejects.toMatchObject({_tag:'GuestPendingConflict',details:{operation:{operation_kind:'study_start',idempotency_key:'start-original',operation_id:null}}});
 expect(GuestPendingConflict.detailsRequired).toBe(true);
});
test('strict119 original start lookup forwards original key without body/config/Guest proof',async()=>{
 const f=fixture();expect((await f.handlers.GetOwnerAccountStudyStartOperationV1({principal:{kind:'user',subject:'account-1'},params:{communityId:'community-1',postId:'post-1',idempotencyKey:'start-original'},query:{},body:undefined})).body).toEqual({state:'completed',result:ownerSession});
 expect(f.calls).toEqual([{accountId:'account-1',communityId:'community-1',postId:'post-1',idempotencyKey:'start-original'}]);
});
