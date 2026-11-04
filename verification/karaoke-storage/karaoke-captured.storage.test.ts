import { expect,test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCapturedKaraokeSqliteJournal } from "../../packages/platform-cf/src/captured-karaoke-sqlite-journal.ts";
import { CapturedKaraokeMultipartArchive } from "../../packages/platform-cf/src/captured-karaoke-multipart.ts";
import { capture,deferred,fixture,sqlite,handled,bounded,succeeded,enteredOrSettled,type Settlement } from "./karaoke-captured-storage.fixture.ts";

const rejection=async(task:Promise<unknown>)=>{try{await task;throw new Error("expected rejection");}catch(error){if(error instanceof Error&&error.message==="expected rejection")throw error;return error;}};
test("SQL-ID successful COMMIT ACK loss blocks PART until exact durable ID replay",async()=>{
 const f=fixture();try{f.append(1);f.driver.loseNextNoteCommit();const archive=f.make();
  const error=await rejection(archive.finish());expect(error).toMatchObject({_tag:"ControlPlaneTransactionOutcomeUnknown",phase:"commit"});
  expect(f.calls).toEqual(["create"]);expect(f.journal.load().multipartId).toBe("multipart-original");expect(f.driver.state().multipartId).toBe("multipart-original");
  f.onPart(async()=>{expect(f.driver.calls.filter(text=>text.includes("note_learner_audio_multipart_id_private_v1"))).toHaveLength(2);});
  expect((await archive.finish()).state).toBe("stored");expect(f.calls.filter(call=>call==="create")).toHaveLength(1);expect(f.calls.filter(call=>call==="part")).toHaveLength(1);
 }finally{f.close();}
});
test("genuine SQLite part transaction removes captured prefix and preserves frames appended during await",async()=>{
 const f=fixture(),entered=deferred<void>(),finish=deferred<void>();let settled:Promise<Settlement<void>>|null=null;
 try{f.append(1);f.onPart(async()=>{entered.complete();await finish.promise;});
  settled=handled(f.make().uploadPending(true));await enteredOrSettled(entered.promise,settled,"part-prefix-entry");
  f.append(2,new Uint8Array([9,8]));finish.complete();succeeded(await bounded(settled,"part-prefix-settlement"));
  expect(f.journal.load().parts).toEqual([{partNumber:1,etag:"part-1"}]);expect(f.journal.load().nextPart).toBe(2);
  const remaining=f.journal.chunks();expect(remaining.map(item=>item.frameSequence)).toEqual([2]);expect(Array.from(new Uint8Array(remaining[0]?.payload??new ArrayBuffer(0)))).toEqual([9,8]);
 }finally{finish.complete();if(settled!==null)await bounded(settled,"part-prefix-cleanup");f.close();}
});
for(const at of ["create","part","complete","get"] as const)test(`operator reset during ${at} preserves facts and prevents later mutating calls/publication`,async()=>{
 const f=fixture();try{f.append(1);const stop=async()=>{f.reset();};
  if(at==="create")f.onCreate(stop);else if(at==="part")f.onPart(stop);else if(at==="complete")f.onComplete(stop);else f.onGet(stop);
  const archive=f.make();await rejection(archive.finish());const journal=f.journal.load();
  expect(journal.multipartId).toBe("multipart-original");expect(journal.inFlight).toBeNull();
  if(at==="create"){expect(f.calls).toEqual(["create"]);expect(journal.parts).toEqual([]);expect(journal.completed).toBe(false);}
  else if(at==="part"){expect(f.calls).toEqual(["create","part"]);expect(journal.parts).toHaveLength(1);expect(journal.completed).toBe(false);}
  else{expect(f.calls).toEqual(["create","part","complete","get"]);expect(journal.completed).toBe(true);expect(journal.result?.state).toBe("stored");expect(f.driver.state()).toMatchObject({ioState:"closed",storageDisposition:"stored"});expect(f.driver.facts).toHaveLength(1);}
  const before=[...f.calls];await rejection(archive.finish());expect(f.calls).toEqual(before);
 }finally{f.close();}
});
test("native deletion stop during GET preserves current fence and original terminal fact without publication",async()=>{
 const f=fixture();let stop:Promise<Settlement<void>>|null=null,finished:Promise<Settlement<Awaited<ReturnType<CapturedKaraokeMultipartArchive["finish"]>>>>|null=null;
 try{f.append(1);const archive=f.make();
  f.onGet(async()=>{stop=handled(archive.stopForDeletion());await Promise.resolve();expect(f.journal.load().deletionFenced).toBe(true);});
  finished=handled(archive.finish());const outcome=await bounded(finished,"GET-deletion-finish");
  expect(outcome.ok).toBe(false);if(!outcome.ok)expect(outcome.error).toMatchObject({_tag:"LearnerAudioCaptureRejected",reason:"deletion-in-progress"});
  if(stop===null)throw new Error("actual stop task not started");succeeded(await bounded(stop,"GET-deletion-stop"));
  expect(f.journal.load()).toMatchObject({deletionFenced:true,completed:true,inFlight:null,result:{state:"stored",byteSize:3}});
  expect(f.driver.state()).toMatchObject({ioState:"closed",storageDisposition:"stored",fenced:true});expect(f.driver.facts).toHaveLength(1);
  expect(f.calls).toEqual(["create","part","complete","get","delete"]);
 }finally{if(finished!==null)await bounded(finished,"GET-deletion-finish-cleanup");if(stop!==null)await bounded(stop,"GET-deletion-stop-cleanup");f.close();}
});
test("generic observational GET failure stays typed unknown and does not repeat known COMPLETE",async()=>{
 const f=fixture();try{f.append(1);f.onGet(async()=>{throw new Error("controlled readback outage");});const archive=f.make();
  expect(await rejection(archive.finish())).toMatchObject({_tag:"LearnerAudioStorageOutcomeUnknown"});expect(f.journal.load()).toMatchObject({completed:true,inFlight:null,result:null});
  expect(f.driver.state().ioState).toBe("writing");
  f.onGet(async()=>{});expect((await archive.finish()).state).toBe("stored");expect(f.calls.filter(call=>call==="complete")).toHaveLength(1);
 }finally{f.close();}
});
test("persisted unknown nonce survives physical SQLite close/reopen; restart cannot create or declare absence",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"karaoke-captured-storage-")),path=join(directory,"owned.sqlite");
 let initial:Database|null=null,reopened:Database|null=null,primaryFailed=false;let primaryError:unknown;
 try{initial=new Database(path);const f=fixture(initial);f.append(1);f.onCreate(async()=>{throw new Error("controlled unresolved CREATE");});
  expect(await rejection(f.make().finish())).toMatchObject({_tag:"LearnerAudioStorageOutcomeUnknown"});
  expect(f.journal.load().inFlight?.kind).toBe("create");expect(f.driver.state().ioState).toBe("unknown");initial.close();initial=null;
  reopened=new Database(path);const restored=makeCapturedKaraokeSqliteJournal(sqlite(reopened).storage,capture);
  const archive=new CapturedKaraokeMultipartArchive(restored,f.driver.ledger,f.bucket,async()=>{},async()=>false,()=>{});
  expect(await rejection(archive.finish())).toMatchObject({_tag:"LearnerAudioStorageOutcomeUnknown"});expect(f.calls).toEqual(["create"]);expect(restored.load().result).toBeNull();
 }catch(error){primaryFailed=true;primaryError=error;throw error;}
 finally{
  const cleanupErrors:unknown[]=[];
  for(const database of [reopened,initial])if(database!==null){try{database.close();}catch(error){cleanupErrors.push(error);}}
  try{await rm(directory,{recursive:true});}catch(error){cleanupErrors.push(error);}
  if(cleanupErrors.length>0)throw new AggregateError(primaryFailed?[primaryError,...cleanupErrors]:cleanupErrors,"owned SQLite cleanup failed");
 }
});
test("genuine SQLite rejects clearing or changing immutable terminal result after exact stored completion",async()=>{
 const f=fixture();try{f.append(1);expect((await f.make().finish()).state).toBe("stored");const original=f.journal.load();const result=original.result;if(result===null)throw new Error("actual stored result missing");
  expect(()=>f.journal.save({...original,result:null})).toThrow("terminal_result_changed");
  expect(()=>f.journal.save({...original,result:{...result,byteSize:result.byteSize+1}})).toThrow("terminal_result_changed");
  expect(f.journal.load()).toEqual(original);
 }finally{f.close();}
});

test("incomplete object body remains unknown; accepted COMPLETE is never sent twice",async()=>{
 const f=fixture();try{f.append(1);f.bodyFailure(true);const archive=f.make();
  expect(await rejection(archive.finish())).toMatchObject({_tag:"LearnerAudioStorageOutcomeUnknown"});expect(f.journal.load()).toMatchObject({completed:true,result:null});
  f.bodyFailure(false);expect((await archive.finish()).state).toBe("stored");expect(f.calls.filter(call=>call==="complete")).toHaveLength(1);
 }finally{f.close();}
});
test("actual deletion stop journals ABORT and DELETE before calls and leaves no new producer",async()=>{
 const f=fixture();try{f.append(1);const archive=f.make();await archive.uploadPending(true);await archive.stopForDeletion();
  expect(f.calls).toEqual(["create","part","abort","delete"]);expect(f.journal.load()).toMatchObject({deletionFenced:true,inFlight:null});
  expect(f.driver.state()).toMatchObject({ioState:"closed",storageDisposition:"absent"});
  expect(await rejection(archive.finish())).toMatchObject({_tag:"LearnerAudioCaptureRejected"});expect(f.calls).toEqual(["create","part","abort","delete"]);
 }finally{f.close();}
});

test("SQLite journal refuses a non-BLOB payload before issuing any R2 call",()=>{
 const f=fixture();try{
  f.db.query("INSERT INTO karaoke_audio_chunk VALUES(1,?,3)").run("not-a-BLOB");
  expect(()=>f.journal.chunks()).toThrow();expect(f.calls).toEqual([]);
 }finally{f.close();}
});
test("SQLite journal refuses a nonpositive frame sequence before issuing any R2 call",()=>{
 const f=fixture();try{
  f.append(0);expect(()=>f.journal.chunks()).toThrow();expect(f.calls).toEqual([]);
 }finally{f.close();}
});
test("SQLite journal strictly decodes an actual BLOB and retains its positive sequence",()=>{
 const f=fixture();try{
  f.append(7,new Uint8Array([9,8]));const frames=f.journal.chunks();
  expect(frames).toHaveLength(1);expect(frames[0]?.frameSequence).toBe(7);
  if(frames[0]===undefined)throw new Error("actual frame missing");
  expect(frames[0].payload).toBeInstanceOf(ArrayBuffer);
  expect(Array.from(new Uint8Array(frames[0].payload))).toEqual([9,8]);expect(f.calls).toEqual([]);
 }finally{f.close();}
});
