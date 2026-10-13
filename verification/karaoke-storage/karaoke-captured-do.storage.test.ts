// MUST run alone in its own Bun test process: only Cloudflare base and runtime
// factory are mocked. Actual DO, SQLite journal, ledger and repository execute.
import { afterAll,expect,mock,test } from "bun:test";
import { Effect, Layer } from "effect";
import {
 type ControlPlaneError,ControlPlaneDb,ControlPlaneAcquireFailed,ControlPlaneOperationTimedOut,
 ControlPlaneStatementFailed,ControlPlaneTransactionOutcomeUnknown,type KaraokeSessionAuthority,type KaraokeSessionState,
 buildKaraokeScoringDiagnostics,
} from "@pirate/application";
import { capture,deferred,nativeDriver,sqlite,handled,bounded,succeeded,enteredOrSettled,type Settlement } from "./karaoke-captured-storage.fixture.ts";
import type { CapturedKaraokeMultipartBucket,CapturedKaraokeMultipart } from "../../packages/platform-cf/src/captured-karaoke-multipart.ts";
const actualPostgres=await import("../../packages/platform-cf/src/postgres.ts");
const runtimes=new Map<string,Layer.Layer<ControlPlaneDb,ControlPlaneError,never>>();
mock.module("cloudflare:workers",()=>({DurableObject:class<T>{constructor(_ctx:unknown,_env:T){}}}));
mock.module("../../packages/platform-cf/src/postgres.ts",()=>({...actualPostgres,
 makeHyperdriveControlPlaneLayer:(connection:Parameters<typeof actualPostgres.makeHyperdriveControlPlaneLayer>[0])=>{
  const runtime=runtimes.get(connection.connectionString);if(runtime===undefined)throw new Error("unregistered finite runtime");return runtime;
 },
}));
const {KaraokeAttemptDO}=await import("../../packages/platform-cf/src/karaoke-attempt-do.ts");
afterAll(()=>mock.restore());
const authority:KaraokeSessionAuthority={accountId:"account-original",artifactId:capture.artifactId,attemptId:capture.attemptRef,
 audioRevision:1,communityId:"community-original",createdAt:"2026-10-12T00:00:00.000Z",expiresAt:"2050-10-12T00:30:00.000Z",
 karaokeRevisionId:"revision-original",lines:[{id:"line-original",index:0,kind:"lyric",text:"Hold on",start_ms:0,end_ms:1000,words:[{text:"Hold",start_ms:0,end_ms:400},{text:"on",start_ms:500,end_ms:1000}]}],
 lyricsRevision:1,personaId:"persona-original",playbackKind:"instrumental",postId:"post-original",qualificationPolicyVersionId:"karaoke_qualification_v2@1",
 requestHash:"a".repeat(64),scoringModel:"scribe_v2_realtime",scoringProvider:"elevenlabs",scoringVersion:5,sessionId:capture.commandRef,timezone:"UTC"};
const summary:NonNullable<KaraokeSessionState["summary"]>={finalScore:0,lyricsScore:0,timingScore:null,confidenceMean:null,lineCount:1,scoredLineCount:0,
 noRecognitionLineCount:1,uncertainLineCount:1,phoneticUnavailableLineCount:1,lowConfidenceLineCount:0,timingTrend:"on_time",
 timingCalibration:{state:"uncalibrated",reason:"insufficient_evidence",offsetMs:0,rawOffsetMs:0,residualSpreadMs:0,measuredLineCount:0,matchedWordCount:0},
 strongestLines:[],weakestLines:[],missedWords:[],lineDiagnostics:[]};
let serial=0;
async function fixture(){
 const sql=sqlite(),driver=nativeDriver(),key=`postgres://finite.invalid/karaoke-do-${++serial}`;runtimes.set(key,driver.runtime);
 let barrier:Promise<Settlement<void>>=Promise.resolve({ok:true,value:undefined}),alarm:number|null=null;const parts=new Map<number,Uint8Array>(),calls:string[]=[];
 const remote:CapturedKaraokeMultipart={uploadId:"multipart-original",uploadPart:async(number,bytes)=>{expect(driver.inTransaction()).toBe(false);calls.push("part");parts.set(number,new Uint8Array(bytes));return{partNumber:number,etag:`part-${number}`};},
  complete:async()=>{expect(driver.inTransaction()).toBe(false);calls.push("complete");return{};},abort:async()=>{calls.push("abort");}};
 const bucket:CapturedKaraokeMultipartBucket={createMultipartUpload:async()=>{expect(driver.inTransaction()).toBe(false);calls.push("create");return remote;},resumeMultipartUpload:()=>remote,
  get:async()=>{expect(driver.inTransaction()).toBe(false);calls.push("get");const bytes=Uint8Array.from([...parts.values()].flatMap(part=>Array.from(part)));return{size:bytes.byteLength,body:new ReadableStream<Uint8Array>({start:controller=>{controller.enqueue(bytes);controller.close();}})};},delete:async()=>{calls.push("delete");parts.clear();}};
 const ctx:ConstructorParameters<typeof KaraokeAttemptDO>[0]={id:{toString:()=>"finite-do-original"},storage:{sql:sql.storage.sql,
  transactionSync:sql.storage.transactionSync,get:async()=>undefined,put:async()=>{},getAlarm:async()=>alarm,deleteAlarm:async()=>{alarm=null;},setAlarm:async scheduled=>{alarm=Number(scheduled);}},
  acceptWebSocket:()=>{},getWebSockets:()=>[],blockConcurrencyWhile:<A>(work:()=>Promise<A>)=>{const task=work();barrier=handled(task).then(outcome=>outcome.ok?{ok:true as const,value:undefined}:outcome);return task;}};
 try{
  const object=new KaraokeAttemptDO(ctx,{CONTROL_PLANE:{connectionString:key},ELEVENLABS_API_KEY:"synthetic-provider-not-called",API_NEXT_ENV:"staging",KARAOKE_FINALIZATION_RECOVERY_ENABLED:"true",LEARNER_AUDIO:bucket});
  succeeded(await bounded(barrier,"DO-constructor-barrier"));
  return{...sql,driver,key,object,calls,fail:(error:ControlPlaneError)=>runtimes.set(key,Layer.effect(ControlPlaneDb)(Effect.fail(error))),close:()=>{runtimes.delete(key);sql.db.close();}};
 }catch(error){await bounded(barrier,"DO-constructor-cleanup");runtimes.delete(key);sql.db.close();throw error;}
}
test("concurrent actual DO initialize uses one cached binding/serializer and one later CREATE",async()=>{
 const f=await fixture(),entered=deferred<void>(),release=deferred<void>();
 type Initialized=Awaited<ReturnType<typeof f.object.initialize>>;
 let one:Promise<Settlement<Initialized>>|null=null,two:Promise<Settlement<Initialized>>|null=null;
 try{f.driver.onCaptureRead(async()=>{entered.complete();await release.promise;});
  one=handled(f.object.initialize(authority));two=handled(f.object.initialize(authority));
  await enteredOrSettled(entered.promise,Promise.race([one,two]),"DO-concurrent-opening-entry");release.complete();
  succeeded(await bounded(one,"DO-first-initialize"));succeeded(await bounded(two,"DO-second-initialize"));
  expect(f.driver.calls.filter(text=>text.includes("read_account_karaoke_audio_capture_private_v1"))).toHaveLength(1);
  f.db.query("INSERT INTO karaoke_audio_chunk VALUES(1,?,3)").run(new Uint8Array([1,2,3]));
  const payload={completedAt:"2026-10-12T00:05:00.000Z",completionReason:"abandoned",diagnostics:buildKaraokeScoringDiagnostics(authority,summary,[]),qualificationId:"qualification-unused",summary};
  f.db.query("INSERT INTO karaoke_outbox(id,payload_json,score_state,recording_state) VALUES(1,?,'stored','pending')").run(JSON.stringify(payload));
  // The finite driver deliberately rejects unmodeled repository result SQL;
  // archive itself must still execute once and its journal remain authoritative.
  await f.object.alarm();expect(f.calls.filter(call=>call==="create")).toHaveLength(1);
  expect(f.db.query("SELECT completed FROM karaoke_archive_capture").all()).toEqual([{completed:1}]);
 }finally{release.complete();if(one!==null)await bounded(one,"DO-first-initialize-cleanup");if(two!==null)await bounded(two,"DO-second-initialize-cleanup");f.close();}
});
const failures:readonly ControlPlaneError[]=[
 new ControlPlaneAcquireFailed({phase:"acquisition",limitMs:1,elapsedMs:1}),
 new ControlPlaneOperationTimedOut({label:"original",limitMs:1,elapsedMs:1,outcomeCertainty:"not-started"}),
 new ControlPlaneStatementFailed({label:"original",sqlState:"40001",constraint:null,outcomeCertainty:"aborted"}),
 new ControlPlaneTransactionOutcomeUnknown({phase:"commit",label:"original",limitMs:1,elapsedMs:1}),
];
for(const axis of ["score","recording"] as const)for(const [index,failure]of failures.entries())test(`actual ${axis} outbox retains native/mapped ambiguity past exhaustion: ${failure._tag}`,async()=>{
 const f=await fixture();try{await f.object.initialize(authority);
  if(axis==="recording")f.db.query("INSERT INTO karaoke_audio_chunk VALUES(1,?,3)").run(new Uint8Array([1,2,3]));
  const payload={completedAt:"2026-10-12T00:05:00.000Z",completionReason:"abandoned",diagnostics:buildKaraokeScoringDiagnostics(authority,summary,[]),qualificationId:`qualification-unused-${index}`,summary};
  f.db.query("INSERT INTO karaoke_outbox(id,payload_json,score_state,recording_state,score_attempts,recording_attempts) VALUES(1,?,?,?,?,?)")
   .run(JSON.stringify(payload),axis==="score"?"pending":"stored",axis==="recording"?"pending":"stored",7,7);
  // Cached ledger keeps its registered original runtime; the real repository
  // observes the new failure Layer and maps all native failures at wire seam.
  f.fail(failure);await f.object.alarm();
  expect(f.db.query(`SELECT ${axis}_state AS state,${axis}_attempts AS attempts FROM karaoke_outbox`).all()).toEqual([{state:"pending",attempts:8}]);
 }finally{f.close();}
});
