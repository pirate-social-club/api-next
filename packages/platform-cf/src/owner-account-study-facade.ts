import {Clock,ControlPlaneDb,type ControlPlaneError,ControlPlaneStatementFailed,IdGen,makeStudyV2Service,StudyV2CommandRejected,type StudyBatchTranscriber,canonicalBodyHash} from '@pirate/application';
import {GetAccountStudyRewardPreviewV1,GuestStudyPreparedContentV1,OwnerAccountStudyAnswerResultV1,OwnerAccountStudySessionV1,OwnerAccountStudyStartOperationV1,StartOwnerAccountStudySessionV1,type StudyAnswerSubmissionV2} from '@pirate/contracts';
import {Effect,type Layer,Schema} from 'effect';
import {boundedLearnerAudioTransaction} from './bounded-audio-transaction.ts';
import {makeControlPlaneAccountOwnerRewardHooks,type AccountOwnerRewardBirth} from './account-owner-reward-hooks.ts';
import {makeControlledAccountSpokenComposition} from './controlled-account-spoken-composition.ts';
import type {CapturedStudyAudioBucket} from './learner-audio-captured-io.ts';
import {makeControlPlanePreparedGuestRewardContentStore} from './guest-reward-prepared-content-store.ts';

type StartBody=Schema.Schema.Type<typeof StartOwnerAccountStudySessionV1.request.body>;
type PostInput=Readonly<{accountId:string;communityId:string;postId:string}>;
type SessionInput=Readonly<{accountId:string;communityId:string;sessionId:string}>;
type PreviewInput=PostInput&Readonly<{personaId:string;targetLanguage:string|null;learnerBand:StartBody['learner_band']}>;
type StudyIo=Readonly<{bucket:CapturedStudyAudioBucket;transcriber:StudyBatchTranscriber|null;rerecordEnabled:boolean;retainTask:(task:Promise<unknown>)=>void}>;
interface OwnerAccountStudyConfiguration{
 readonly disclosure:Schema.Schema.Type<typeof GuestStudyPreparedContentV1.fields.disclosure>|null;
 readonly purchaseSafetyMarginSeconds:number|null;
}
const invalid=(label:string)=>new ControlPlaneStatementFailed({label,sqlState:null,constraint:null,outcomeCertainty:'completed'});
const strict=<S extends Schema.ConstraintDecoder<unknown>>(schema:S,value:unknown):S['Type']=>Schema.decodeUnknownSync(schema,{onExcessProperty:'error'})(value);
/** Actual controlled ordinary repository/service + final Account source hooks.
 * No fake ordinary BrowserParticipationContext, Guest source, readiness Boolean
 * or frozen-port mutation. Root owns actual graph/role/config binding. */
export function makeControlPlaneOwnerAccountStudyFacade(
 runtime:Layer.Layer<ControlPlaneDb,ControlPlaneError,never>,configuration:OwnerAccountStudyConfiguration,io:StudyIo,
 clock:Clock['Service'],ids:IdGen['Service'],
){
 const originalHooks=makeControlPlaneAccountOwnerRewardHooks(runtime,null);
 const compose=(birth:AccountOwnerRewardBirth|null)=>{
  const hooks=birth===null?originalHooks:makeControlPlaneAccountOwnerRewardHooks(runtime,birth);
  const controlled=makeControlledAccountSpokenComposition(runtime,io.bucket,io.transcriber,io.rerecordEnabled,io.retainTask,undefined,hooks);
  return{hooks,controlled,ordinary:makeStudyV2Service(controlled.store)};
 };
 const existing=compose(null);
 const provide=<A,E>(effect:Effect.Effect<A,E,Clock|IdGen>)=>effect.pipe(Effect.provideService(Clock,clock),Effect.provideService(IdGen,ids));
 const project=Effect.fn('OwnerAccountStudy.project')(function*(input:SessionInput,session:Schema.Schema.Type<typeof OwnerAccountStudySessionV1>['session']){
  const metadata=yield* originalHooks.project(input.accountId,input.communityId,input.sessionId);
  return yield* Effect.try({try:()=>strict(OwnerAccountStudySessionV1,{object:'owner_account_study_session_v1',session,reward_terms:metadata.rewardTerms,participation:metadata.participation}),catch:()=>invalid('owner-account-study.session.decode')});
 });
 const get=Effect.fn('OwnerAccountStudy.get')(function*(input:SessionInput){
  const session=yield* existing.ordinary.getSession(input);
  return yield* project(input,session);
 });
 const preview=Effect.fn('OwnerAccountStudy.preview')(function*(input:PreviewInput){
  // Genuine Account availability/persona/media permission remain in their actual
  // store/native source. Public preview is not reshaped into Account authority.
  const available=yield* existing.controlled.store.getAvailability(input);
  if(available.state!=='ready')return yield* new StudyV2CommandRejected({reason:'insufficient-exercises'});
  const disclosure=configuration.disclosure,margin=configuration.purchaseSafetyMarginSeconds;
  if(disclosure===null||margin===null||!Number.isInteger(margin)||margin<1||margin>86400)
   return yield* new StudyV2CommandRejected({reason:'provider-unavailable'});
  const result=yield* boundedLearnerAudioTransaction(transaction=>transaction.execute<unknown>({
   label:'owner-account-study.preview',text:'SELECT read_current_account_study_reward_preview_v1($1,$2,$3,$4,$5,$6,$7,$8) AS result',
   values:[input.accountId,input.personaId,input.communityId,input.postId,disclosure.version,margin,input.targetLanguage,input.learnerBand],readonly:false,
  }).pipe(Effect.flatMap(response=>Effect.try({try:()=>{
   if(response.rows.length!==1)throw new Error();return strict(Schema.Struct({result:Schema.Unknown}),response.rows[0]).result;
  },catch:()=>invalid('owner-account-study.preview.decode')})))).pipe(Effect.provide(runtime));
  if(result===null)return yield* new StudyV2CommandRejected({reason:'provider-unavailable'});
  return yield* Effect.try({try:()=>{
   const decoded=strict(GetAccountStudyRewardPreviewV1.response,result);
   if(decoded.reward_terms.community_id!==input.communityId||decoded.reward_terms.post_id!==input.postId
    ||decoded.reward_terms.disclosure_version!==disclosure.version)throw new Error();return decoded;
  },catch:()=>invalid('owner-account-study.preview.correlation')});
 });
 const findStart=Effect.fn('OwnerAccountStudy.findStart')(function*(input:PostInput&Readonly<{idempotencyKey:string}>){
  const prior=yield* originalHooks.findStart(input.accountId,input.communityId,input.postId,input.idempotencyKey);
  if(prior.state==='not_started')return strict(OwnerAccountStudyStartOperationV1,{state:'not_started',result:null});
  const result=yield* get({accountId:input.accountId,communityId:input.communityId,sessionId:prior.result.sessionId});
  return strict(OwnerAccountStudyStartOperationV1,{state:'completed',result});
 });
 const start=Effect.fn('OwnerAccountStudy.start')(function*(input:PostInput&Readonly<{body:StartBody}>){
  // Actual original-key lock/wait+fresh read before current quote/disclosure,
  // margin/provider configuration. Missing/unknown COMMIT never implies absence.
  const prior=yield* originalHooks.findStart(input.accountId,input.communityId,input.postId,input.body.idempotency_key);
  const requestHash=yield* canonicalBodyHash({accountId:input.accountId,communityId:input.communityId,postId:input.postId,body:input.body});
  const storeInput={accountId:input.accountId,communityId:input.communityId,postId:input.postId,requestHash,
   idempotencyKey:input.body.idempotency_key,personaId:input.body.persona_id,targetLanguage:input.body.target_language,
   learnerBand:input.body.learner_band,timezone:input.body.timezone};
  if(prior.state==='completed'){
   const stored=yield* existing.ordinary.getSession({accountId:input.accountId,communityId:input.communityId,sessionId:prior.result.sessionId});
   // Retained repository replay verifies FULL original119 requestHash, including
   // consent/preview; returning GET metadata alone would lose that correlation.
   const replay=yield* existing.controlled.store.startSession({...storeInput,sessionId:stored.session_id,createdAt:stored.created_at});
   return yield* project({accountId:input.accountId,communityId:input.communityId,sessionId:replay.session_id},replay);
  }
  const disclosure=configuration.disclosure,margin=configuration.purchaseSafetyMarginSeconds;
  if(disclosure===null||margin===null||!Number.isInteger(margin)||margin<1||margin>86400)
   return yield* new StudyV2CommandRejected({reason:'provider-unavailable'});
  if(input.body.disclosure.version!==disclosure.version)return yield* new StudyV2CommandRejected({reason:'idempotency-conflict'});
  const quote=yield* preview({...input,personaId:input.body.persona_id,targetLanguage:input.body.target_language,learnerBand:input.body.learner_band});
  if(quote.reward_preview_terms_hash!==input.body.reward_preview_terms_hash)
   return yield* new StudyV2CommandRejected({reason:'idempotency-conflict'});
  const selected=compose({rewardPreviewTermsHash:input.body.reward_preview_terms_hash,disclosureVersion:input.body.disclosure.version,disclosureAccepted:true,purchaseSafetyMarginSeconds:margin});
  const session=yield* selected.controlled.store.startSession({...storeInput,sessionId:`study_v2_${yield* ids.next}`,createdAt:new Date(yield* clock.now).toISOString()});
  return yield* project({accountId:input.accountId,communityId:input.communityId,sessionId:session.session_id},session);
 });
 const selectedSource=Effect.fn('OwnerAccountStudy.selectedSource')(function*(input:SessionInput){
  yield* boundedLearnerAudioTransaction(transaction=>transaction.execute({
   label:'owner-account-study.selected-source',text:'SELECT require_original_account_owner_study_source_v1($1,$2,$3)',
   values:[input.accountId,input.communityId,input.sessionId],readonly:false,
  })).pipe(Effect.provide(runtime));
 });
 const wrapAnswer=Effect.fn('OwnerAccountStudy.wrapAnswer')(function*(input:SessionInput,answer:Schema.Schema.Type<typeof OwnerAccountStudyAnswerResultV1>['answer']){
  const metadata=yield* originalHooks.project(input.accountId,input.communityId,input.sessionId);
  return yield* Effect.try({try:()=>strict(OwnerAccountStudyAnswerResultV1,{object:'owner_account_study_answer_result_v1',answer,reward_terms:metadata.rewardTerms,participation:metadata.participation}),catch:()=>invalid('owner-account-study.answer.decode')});
 });
 const choice=Effect.fn('OwnerAccountStudy.choice')(function*(input:SessionInput&Readonly<{sessionItemId:string;attemptNumber:number;idempotencyKey:string;answer:StudyAnswerSubmissionV2}>){
  // Confirm genuine selected source before ordinary mutation; no old practice
  // session is promoted merely because this new route was invoked.
  yield* selectedSource(input);
  const answer=yield* existing.ordinary.submitAnswer(input);
  return yield* wrapAnswer(input,answer);
 });
 const spoken=Effect.fn('OwnerAccountStudy.spoken')(function*(input:SessionInput&Readonly<{sessionItemId:string;attemptNumber:number;idempotencyKey:string;audio:Uint8Array;audioContentType:string;audioDurationMs:number}>){
  yield* selectedSource(input);
  // Actual controlled original CP recovery before current provider/context. No
  // plain Study/audio fallback; accepted unknown provider state stays retained.
  const answer=yield* existing.controlled.spoken.submitSpokenAnswer(input);
  return yield* wrapAnswer(input,answer);
 });
 const publicPrepared=makeControlPlanePreparedGuestRewardContentStore(runtime,configuration.disclosure,configuration.purchaseSafetyMarginSeconds);
 return{publicPrepared:publicPrepared.get,preview,start:(input:Parameters<typeof start>[0])=>provide(start(input)),findStart,getSession:get,
  submitChoice:(input:Parameters<typeof choice>[0])=>provide(choice(input)),submitAudio:(input:Parameters<typeof spoken>[0])=>provide(spoken(input))};
}
export type OwnerAccountStudyFacade=ReturnType<typeof makeControlPlaneOwnerAccountStudyFacade>;
