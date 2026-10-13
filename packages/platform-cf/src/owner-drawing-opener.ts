import { ControlPlaneDb, type ControlPlaneTransaction, ControlPlaneStatementFailed } from "@pirate/application";
import { GuestDrawingIdV1, GuestIdentifierV1 } from "@pirate/contracts";
import { Effect, Schema } from "effect";
import { boundedLearnerAudioTransaction } from "./bounded-audio-transaction.ts";
const Opening=Schema.Struct({poolLegId:GuestIdentifierV1,drawingId:GuestDrawingIdV1});
const Original=Schema.Struct({poolLegId:GuestIdentifierV1,drawingId:GuestDrawingIdV1,beneficiaryVersion:Schema.Literal(3)});
const decode=<S extends Schema.ConstraintDecoder<unknown>>(schema:S,value:unknown):S["Type"]=>Schema.decodeUnknownSync(schema,{onExcessProperty:"error"})(value);
const failed=(label:string)=>new ControlPlaneStatementFailed({label,sqlState:null,constraint:null,outcomeCertainty:"completed"});
const one=<S extends Schema.ConstraintDecoder<unknown>>(tx:ControlPlaneTransaction,label:string,text:string,values:readonly unknown[],schema:S)=>
 tx.execute<unknown>({label,text,values,readonly:false}).pipe(Effect.flatMap(rows=>Effect.try({try:()=>{
  if(rows.rows.length!==1)throw new Error();return decode(schema,decode(Schema.Struct({result:Schema.Unknown}),rows.rows[0]).result);
 },catch:()=>failed(label)})));
/** Invoke only after actual observation COMMIT ACK. Neither list nor an opening
 * is an entry purchase; original salt is reused on every retry/ACK uncertainty. */
export const openOwnerDrawingsForObservation=Effect.fn("OwnerDrawingOpener.open")(function*(observationId:string){
 const id=yield* Effect.try({try:()=>decode(GuestIdentifierV1,observationId),catch:()=>failed("owner-drawing.observation")});
 const db=yield* ControlPlaneDb;
 const rows=yield* db.execute<unknown>({label:"owner-drawing.list",text:"SELECT list_owner_megapot_openings_v1($1) AS result",values:[id],readonly:true});
 const openings=yield* Effect.try({try:()=>{
  if(rows.rows.length!==1)throw new Error();return decode(Schema.Array(Opening).check(Schema.isMaxLength(256)),decode(Schema.Struct({result:Schema.Unknown}),rows.rows[0]).result);
 },catch:()=>failed("owner-drawing.list.decode")});
 const opened:string[]=[];
 for(const target of openings){
  const original=yield* boundedLearnerAudioTransaction(Effect.fn("OwnerDrawingOpener.original")(function*(tx:ControlPlaneTransaction){
   const saved=yield* one(tx,"owner-drawing.original","SELECT find_owner_megapot_original_drawing_v1($1,$2) AS result",[target.poolLegId,id],Schema.NullOr(Original));
   if(saved!==null)return saved;
   // Actual server CSPRNG only after original lookup. A concurrent creator's
   // immutable original wins inside native creation, never a salt overwrite.
   const salt=crypto.getRandomValues(new Uint8Array(32));
   return yield* one(tx,"owner-drawing.open","SELECT open_owner_megapot_drawing_v1($1,$2,$3::bytea) AS result",[target.poolLegId,id,salt],Original);
  }));
  yield* Effect.try({try:()=>{if(original.poolLegId!==target.poolLegId||original.drawingId!==target.drawingId)throw new Error();},catch:()=>failed("owner-drawing.original.correlation")});
  opened.push(original.poolLegId);
 }
 return opened;
});
