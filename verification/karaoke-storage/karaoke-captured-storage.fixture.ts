// Genuine Bun SQLite + real production journal/controlled adapter. Finite driver
// substitutes PostgreSQL at its typed boundary; no native authority credit.
import { Database,type SQLQueryBindings } from "bun:sqlite";
import { expect } from "bun:test";
import { makeDirectPostgresControlPlaneLayer,type PostgresClientLike } from "../../packages/platform-cf/src/postgres.ts";
import { makeCapturedLearnerAudioUploadStore } from "../../packages/platform-cf/src/learner-audio-producer-store.ts";
import { makeCapturedKaraokeSqliteJournal,type CapturedKaraokeSqliteStorage } from "../../packages/platform-cf/src/captured-karaoke-sqlite-journal.ts";
import { CapturedKaraokeMultipartArchive,type CapturedKaraokeMultipartBucket,type CapturedKaraokeMultipart } from "../../packages/platform-cf/src/captured-karaoke-multipart.ts";
import type { LearnerAudioUploadCapture } from "../../packages/platform-cf/src/learner-audio-captured-io.ts";
export const capture:LearnerAudioUploadCapture={uploadAttemptId:"upload-original",sourceOwnerId:"owner-original",artifactId:"artifact-original",
 sourceKind:"karaoke",attemptRef:"attempt-original",commandRef:"session-original",reservationRef:"session-original",capturedRevision:0,
 objectRef:"karaoke/account-original/attempt-original.pcm",contentDigest:null,contentType:"audio/L16;rate=16000;channels=1",byteSize:null,durationMs:null};
export const deferred=<A>()=>{let complete:(value:A)=>void=()=>{};let reject:(error:unknown)=>void=()=>{};
 const promise=new Promise<A>((yes,no)=>{complete=yes;reject=no;});return{promise,complete,reject};};
export type Settlement<A> = Readonly<{ok:true;value:A}> | Readonly<{ok:false;error:unknown}>;
export const handled=<A>(task:Promise<A>):Promise<Settlement<A>>=>task.then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));
export const bounded=<A>(task:Promise<A>,label:string,limitMs=2000):Promise<A>=>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(`finite fixture deadline: ${label}`)),limitMs);});
 return Promise.race([task,timeout]).finally(()=>{if(timer!==undefined)clearTimeout(timer);});
};
export const succeeded=<A>(outcome:Settlement<A>):A=>{if(!outcome.ok)throw outcome.error;return outcome.value;};
export const enteredOrSettled=<A>(entry:Promise<void>,settled:Promise<Settlement<A>>,label:string)=>bounded(Promise.race([
 entry,settled.then(outcome=>{if(!outcome.ok)throw outcome.error;throw new Error(`producer settled before fixture entry: ${label}`);}),
]),label);
const binding=(value:unknown):SQLQueryBindings=>{
 if(value===null||typeof value==="string"||typeof value==="number"||typeof value==="bigint"||value instanceof Uint8Array)return value;
 if(value instanceof ArrayBuffer)return new Uint8Array(value);if(typeof value==="boolean")return value?1:0;
 throw new Error("unsupported finite SQLite binding");
};
export function sqlite(db=new Database(":memory:")){
 const storage:CapturedKaraokeSqliteStorage={sql:{exec:<A extends Readonly<Record<string,unknown>>>(query:string,...values:readonly unknown[])=>{
  const rows=db.query<A,SQLQueryBindings[]>(query).all(...values.map(binding));
  // Cloudflare SQL exposes BLOB as ArrayBuffer; normalize this concrete driver
  // value only. Generic row/schema authority is not asserted or fabricated.
  for(const row of rows)for(const [key,value]of Object.entries(row))if(value instanceof Uint8Array)Reflect.set(row,key,new Uint8Array(value).buffer);
  return{toArray:()=>rows};
 }},transactionSync:<A>(use:()=>A)=>db.transaction(use)()};
 return{db,storage};
}
export function nativeDriver(){
 type State={ioState:"registered"|"writing"|"unknown"|"closed";storageDisposition:"stored"|"absent"|"failed"|null;multipartId:string|null;fenced:boolean};
 let state:State={ioState:"registered",storageDisposition:null,multipartId:null,fenced:false};
 let staged:State|null=null,inTransaction=false,loseNoteCommit=false,noteSeen=false;
 const calls:string[]=[],facts:unknown[]=[];let captureRead=async()=>{};
 const client:PostgresClientLike={connect:async()=>{},end:async()=>{inTransaction=false;staged=null;},query:async({text,values=[]})=>{
  calls.push(text);
  if(text==="BEGIN"){inTransaction=true;staged={...state};noteSeen=false;return{rows:[],rowCount:0};}
  if(text==="ROLLBACK"){staged=null;inTransaction=false;return{rows:[],rowCount:0};}
  if(text==="COMMIT"){
   if(staged!==null)state=staged;staged=null;inTransaction=false;
   if(loseNoteCommit&&noteSeen){loseNoteCommit=false;throw new Error("finite successful SQL-ID COMMIT acknowledgment withheld");}
   return{rows:[],rowCount:0};
  }
  if(text.startsWith("SELECT set_config"))return{rows:[],rowCount:1};
  if(text.startsWith("SELECT current_setting"))return{rows:[{transaction:"3s",lock:"250ms",statement:"2s",idle:"2s"}],rowCount:1};
  expect(inTransaction).toBe(true);if(staged===null)throw new Error("finite controlled transaction missing");
  if(text.includes("require_captured_learner_audio_private_v1")){
   expect(values[0]).toBe(JSON.stringify(capture));return{rows:[{result:capture.uploadAttemptId}],rowCount:1};
  }
  if(text.includes("read_account_karaoke_audio_capture_private_v1")){await captureRead();return{rows:[{result:capture}],rowCount:1};}
  if(text.includes("note_learner_audio_multipart_id_private_v1")){
   expect(values[0]).toBe(capture.uploadAttemptId);expect(values[1]).toBe("multipart-original");
   if(staged.multipartId!==null&&staged.multipartId!==values[1])throw new Error("exact multipart ID differs");
   staged.multipartId="multipart-original";noteSeen=true;return{rows:[],rowCount:1};
  }
  if(text.includes("continue_captured_learner_audio_private_v1"))return{rows:[{result:!staged.fenced&&staged.ioState==="writing"}],rowCount:1};
  if(text.includes("claim_captured_learner_audio_private_v1")){
   expect(values[0]).toBe(JSON.stringify(capture));const claimed=staged.ioState==="registered"&&!staged.fenced;
   if(claimed)staged.ioState="writing";
   return{rows:[{result:{capture,ioState:staged.ioState,storageDisposition:staged.storageDisposition,cleanupRequired:staged.fenced,
    mayPublish:staged.ioState==="closed"&&staged.storageDisposition==="stored"&&!staged.fenced,
    mayContinue:staged.ioState==="writing"&&!staged.fenced,claimed}}],rowCount:1};
  }
  if(text.includes("settle_learner_audio_terminal_fact_private_v1")){
   expect(values[0]).toBe(capture.uploadAttemptId);const fact=values[4];facts.push(fact);
   if(values[2]===true){staged.ioState="closed";staged.storageDisposition=values[1]==="stored"?"stored":values[1]==="absent"?"absent":"failed";}
   else{staged.ioState="unknown";staged.storageDisposition=null;}
   return{rows:[{result:staged.storageDisposition==="stored"&&!staged.fenced}],rowCount:1};
  }
  throw new Error("unexpected finite controlled SQL");
 }};
 const runtime=makeDirectPostgresControlPlaneLayer("postgres://finite.invalid/karaoke-storage",{clientFactory:()=>client,logger:{info:()=>{},error:()=>{}}});
 return{runtime,ledger:makeCapturedLearnerAudioUploadStore(runtime),calls,facts,inTransaction:()=>inTransaction,loseNextNoteCommit:()=>{loseNoteCommit=true;},
  fence:()=>{state={...state,fenced:true};},state:()=>({...state}),onCaptureRead:(work:()=>Promise<void>)=>{captureRead=work;}};
}
export function fixture(database?:Database){
 const sql=sqlite(database);try{sql.db.exec(`CREATE TABLE karaoke_audio_chunk(frame_sequence INTEGER PRIMARY KEY,payload BLOB NOT NULL,byte_size INTEGER NOT NULL);
 CREATE TABLE karaoke_archive(id INTEGER PRIMARY KEY,upload_id TEXT,object_key TEXT,next_part INTEGER,parts_json TEXT,byte_size INTEGER,duration_ms INTEGER,state TEXT,result_json TEXT);`);
 sql.db.query("INSERT INTO karaoke_archive VALUES(1,NULL,?,1,'[]',0,1000,'pending',NULL)").run(capture.objectRef);
 const journal=makeCapturedKaraokeSqliteJournal(sql.storage,capture),driver=nativeDriver();
 let open=true;const calls:string[]=[],parts=new Map<number,Uint8Array>();let beforeCreate=async()=>{},beforePart=async()=>{},beforeComplete=async()=>{},beforeGet=async()=>{};let bodyError=false;
 const remote:CapturedKaraokeMultipart={uploadId:"multipart-original",uploadPart:async(number,bytes)=>{
  expect(driver.inTransaction()).toBe(false);calls.push("part");await beforePart();parts.set(number,new Uint8Array(bytes));return{partNumber:number,etag:`part-${number}`};},
  complete:async()=>{expect(driver.inTransaction()).toBe(false);calls.push("complete");await beforeComplete();return{};},
  abort:async()=>{expect(driver.inTransaction()).toBe(false);expect(journal.load().inFlight?.kind).toBe("abort");calls.push("abort");}};
 const bucket:CapturedKaraokeMultipartBucket={createMultipartUpload:async()=>{expect(driver.inTransaction()).toBe(false);calls.push("create");await beforeCreate();return remote;},
  resumeMultipartUpload:(key,id)=>{expect(key).toBe(capture.objectRef);expect(id).toBe("multipart-original");return remote;},
  get:async()=>{expect(driver.inTransaction()).toBe(false);calls.push("get");await beforeGet();const bytes=Uint8Array.from([...parts.values()].flatMap(part=>Array.from(part)));
   return{size:bytes.byteLength,body:new ReadableStream<Uint8Array>({start:controller=>{if(bodyError){controller.error(new Error("controlled incomplete object body"));return;}controller.enqueue(bytes);controller.close();}})};},
  delete:async()=>{expect(driver.inTransaction()).toBe(false);expect(journal.load().inFlight?.kind).toBe("delete");calls.push("delete");parts.clear();}};
 const make=()=>new CapturedKaraokeMultipartArchive(journal,driver.ledger,bucket,async()=>{driver.fence();},async()=>false,()=>{if(!open)throw new Error("actual producer reset marker simulated");});
 const append=(sequence:number,bytes=new Uint8Array([1,2,3]))=>sql.db.query("INSERT INTO karaoke_audio_chunk VALUES(?,?,?)").run(sequence,bytes,bytes.byteLength);
 return{...sql,journal,driver,calls,bucket,make,append,reset:()=>{open=false;},
  onCreate:(work:()=>Promise<void>)=>{beforeCreate=work;},onPart:(work:()=>Promise<void>)=>{beforePart=work;},onComplete:(work:()=>Promise<void>)=>{beforeComplete=work;},onGet:(work:()=>Promise<void>)=>{beforeGet=work;},bodyFailure:(value:boolean)=>{bodyError=value;},close:()=>sql.db.close()};
 }catch(error){if(database===undefined)sql.db.close();throw error;}
}
