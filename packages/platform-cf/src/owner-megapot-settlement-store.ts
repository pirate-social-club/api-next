// Private typed native adapter. No server role grant, job selection or live activation here.
import { type ControlPlaneDb, type ControlPlaneError, ControlPlaneStatementFailed } from "@pirate/application";
import type {
  OwnerMegapotDrawingKey, OwnerMegapotCutoffCeilings, OwnerMegapotSettlementStore,
} from "@pirate/application/owner-megapot-settlement";
import { Effect, type Layer, Schema } from "effect";
import { boundedLearnerAudioTransaction } from "./bounded-audio-transaction.ts";

type Runtime = Layer.Layer<ControlPlaneDb, ControlPlaneError, never>;
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128), Schema.isPattern(/^[^\s\u0000-\u001f\u007f\uD800-\uDFFF]+$/u));
const Decimal = Schema.String.check(Schema.isPattern(/^(?:0|[1-9][0-9]{0,77})$/u));
const Hash = Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{64}$/u));
const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const Nonempty = Schema.String.check(Schema.isMinLength(1));
const Instant = Schema.String.check(Schema.makeFilter(value => Number.isFinite(Date.parse(value)) ? undefined : "Valid private instant required"));
const Key = Schema.Struct({ poolLegId: Id, drawingId: Decimal });
const Ceilings = Schema.Struct({ externalTickets: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2147483647 })),
  externalSpendAtomic: Decimal.check(Schema.isPattern(/^[1-9]/u)), sharedTickets: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2147483647 })),
  sharedSpendAtomic: Decimal.check(Schema.isPattern(/^[1-9]/u)),
});
const Cutoff = Schema.Struct({ poolLegId: Id, drawingId: Decimal, version: Schema.Int,
  status: Schema.Literals(["cutoff_frozen", "closed_no_entries", "closed_unfunded", "closed_fallback_ineligible", "closed_fallback_unavailable", "closed_fallback_ceiling"]),
  frozenShareCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), fallback: Schema.Boolean,
  reservedTicketCostAtomic: Decimal, snapshotId: Schema.NullOr(Id), snapshotHash: Schema.NullOr(Hash), terminalReason: Schema.NullOr(Nonempty),
}).check(Schema.makeFilter(result => result.status === "cutoff_frozen"
  ? result.snapshotId !== null && result.snapshotHash !== null ? undefined : "Frozen original snapshot required"
  : result.snapshotId === null && result.snapshotHash === null && result.fallback === false ? undefined : "Closed cutoff has no snapshot"));
const Published = Schema.Struct({ domain: Schema.Literal("pirate.megapot-pool-beneficiary-snapshot.v3"),
  poolLegId: Id, drawingId: Decimal, termsHash: Hash, algorithmVersion: Schema.Literal("equal_v1"), fallback: Schema.Boolean,
  leafCount: Schema.Int.check(Schema.isGreaterThan(0)), leafCommitments: Schema.Array(Hash), snapshotHash: Hash,
}).check(Schema.makeFilter(s => s.leafCommitments.length === s.leafCount ? undefined : "Exact commitment count required"));
const Progress = Schema.Struct({ commitmentEffectId: Id, payloadHash: Digest, signingKeyId: Nonempty, signature: Nonempty,
  state: Schema.Literals(["prepared", "published"]), preparedAt: Instant, publishedAt: Schema.NullOr(Instant), publicReference: Schema.NullOr(Nonempty),
}).check(Schema.makeFilter(p => p.state === "prepared"
  ? p.publishedAt === null && p.publicReference === null ? undefined : "Prepared original lacks publication"
  : p.publishedAt !== null && p.publicReference !== null && Date.parse(p.publishedAt) >= Date.parse(p.preparedAt) ? undefined : "Actual published outcome required"));
const Commitment = Schema.Struct({ poolLegId: Id, drawingId: Decimal, drawingVersion: Schema.Int,
  canPrepare: Schema.Boolean, snapshotId: Id, snapshot: Published, progress: Schema.NullOr(Progress),
}).check(Schema.makeFilter(c => c.snapshot.poolLegId === c.poolLegId && c.snapshot.drawingId === c.drawingId
  && c.snapshotId === `megapot_snapshot_${c.snapshot.snapshotHash.slice(2)}` ? undefined : "Original snapshot source mismatch"));
const Allocation = Schema.Struct({ allocationBatchId: Id, state: Schema.Literal("credited") });
const bad = (label: string) => new ControlPlaneStatementFailed({ label, sqlState: null, constraint: null, outcomeCertainty: "completed" });
const strict = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown): S["Type"] => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);

export function makeControlPlaneOwnerMegapotSettlementStore(runtime: Runtime): OwnerMegapotSettlementStore {
  const query = Effect.fn("OwnerMegapotSettlement.query")(function* <S extends Schema.ConstraintDecoder<unknown>>(
    label: string, text: string, values: readonly unknown[], schema: S,
  ): Effect.fn.Return<S["Type"], ControlPlaneError, ControlPlaneDb> {
    return yield* boundedLearnerAudioTransaction(tx => Effect.gen(function* () {
      const isolation = yield* tx.execute<unknown>({ label: "owner-settlement.isolation.verify",
        text: "SELECT current_setting('transaction_isolation') AS isolation", values: [], readonly: true });
      yield* Effect.try({ try: () => {
        if (isolation.rows.length !== 1) throw new Error();
        strict(Schema.Struct({ isolation: Schema.Literal("read committed") }), isolation.rows[0]);
      }, catch: () => bad("owner-settlement.isolation.verify") });
      const result = yield* tx.execute<unknown>({ label, text, values, readonly: false });
      return yield* Effect.try({ try: () => {
        if (result.rows.length !== 1) throw new Error();
        const outer = strict(Schema.Struct({ result: Schema.Unknown }), result.rows[0]);
        return strict(schema, outer.result);
      }, catch: () => bad(label) });
    }));
  });
  const key = Effect.fn("OwnerMegapotSettlement.key")(function* (input: OwnerMegapotDrawingKey) {
    return yield* Effect.try({ try: () => strict(Key, input), catch: () => bad("owner-settlement.input") });
  });
  const own = <A>(effect: Effect.Effect<A, ControlPlaneError, ControlPlaneDb>) => effect.pipe(Effect.provide(runtime));
  const freeze = Effect.fn("OwnerMegapotSettlement.freeze")(function* (input: OwnerMegapotDrawingKey, config: OwnerMegapotCutoffCeilings | null) {
    const original = yield* key(input);
    const ceilings = yield* Effect.try({ try: () => config === null ? null : strict(Ceilings, config), catch: () => bad("owner-settlement.ceilings") });
    const result = yield* query("owner-settlement.freeze", "SELECT freeze_owner_megapot_drawing_private_v1($1,$2::numeric,$3::jsonb) AS result",
      [original.poolLegId, original.drawingId, ceilings === null ? null : JSON.stringify(ceilings)], Cutoff);
    if (result.poolLegId !== original.poolLegId || result.drawingId !== original.drawingId) return yield* Effect.fail(bad("owner-settlement.freeze.source"));
    return result;
  });
  const readCommitment = Effect.fn("OwnerMegapotSettlement.readCommitment")(function* (input: OwnerMegapotDrawingKey) {
    const original = yield* key(input);
    const result = yield* query("owner-settlement.commitment.read", "SELECT read_owner_megapot_commitment_private_v1($1,$2::numeric) AS result",
      [original.poolLegId, original.drawingId], Commitment);
    if (result.poolLegId !== original.poolLegId || result.drawingId !== original.drawingId) return yield* Effect.fail(bad("owner-settlement.commitment.source"));
    return result;
  });
  const prepare = Effect.fn("OwnerMegapotSettlement.prepareCommitment")(function* (input: Parameters<OwnerMegapotSettlementStore["prepareCommitment"]>[0]) {
    const original = yield* key({ poolLegId: input.poolLegId, drawingId: input.drawingId });
    const checked = yield* Effect.try({ try: () => strict(Schema.Struct({ poolLegId: Id, drawingId: Decimal, snapshotId: Id,
      payload: Nonempty, payloadHash: Digest, signingKeyId: Nonempty, signature: Nonempty }), input), catch: () => bad("owner-settlement.prepare.input") });
    const result = yield* query("owner-settlement.commitment.prepare", "SELECT prepare_owner_megapot_commitment_private_v1($1,$2::numeric,$3,$4,$5,$6,$7) AS result",
      [original.poolLegId, original.drawingId, checked.snapshotId, checked.payload, checked.payloadHash, checked.signingKeyId, checked.signature], Commitment);
    if (result.poolLegId !== original.poolLegId || result.drawingId !== original.drawingId || result.snapshotId !== checked.snapshotId
      || result.progress?.payloadHash !== checked.payloadHash) return yield* Effect.fail(bad("owner-settlement.prepare.source"));
    return result;
  });
  const confirm = Effect.fn("OwnerMegapotSettlement.confirmPublished")(function* (input: Parameters<OwnerMegapotSettlementStore["confirmPublished"]>[0]) {
    const original = yield* key({ poolLegId: input.poolLegId, drawingId: input.drawingId });
    const checked = yield* Effect.try({ try: () => strict(Schema.Struct({ poolLegId: Id, drawingId: Decimal, commitmentEffectId: Id,
      payloadHash: Digest, publicReference: Nonempty, publishedAt: Instant }), input), catch: () => bad("owner-settlement.publish.input") });
    const result = yield* query("owner-settlement.commitment.publish", "SELECT confirm_owner_megapot_commitment_private_v1($1,$2::numeric,$3,$4,$5,$6::timestamptz) AS result",
      [original.poolLegId, original.drawingId, checked.commitmentEffectId, checked.payloadHash, checked.publicReference, checked.publishedAt], Commitment);
    if (result.poolLegId !== original.poolLegId || result.drawingId !== original.drawingId || result.progress?.state !== "published"
      || result.progress.commitmentEffectId !== checked.commitmentEffectId || result.progress.payloadHash !== checked.payloadHash
      || result.progress.publicReference !== checked.publicReference) return yield* Effect.fail(bad("owner-settlement.publish.source"));
    return result;
  });
  const allocate = Effect.fn("OwnerMegapotSettlement.allocate")(function* (input: OwnerMegapotDrawingKey) {
    const original = yield* key(input);
    return yield* query("owner-settlement.allocation.credit", "SELECT allocate_owner_megapot_winnings_private_v1($1,$2::numeric) AS result",
      [original.poolLegId, original.drawingId], Allocation);
  });
  return Object.freeze({ freeze: (input, ceilings) => own(freeze(input, ceilings)), readCommitment: input => own(readCommitment(input)),
    prepareCommitment: input => own(prepare(input)), confirmPublished: input => own(confirm(input)), allocate: input => own(allocate(input)) });
  // Every native/driver failure, including sent-COMMIT outcome uncertainty,
  // propagates unchanged. Reconciliation uses this original drawing key; no
  // absence/refusal/success is synthesized and no replacement draw is selected.
}
