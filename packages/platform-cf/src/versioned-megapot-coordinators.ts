// Internal persisted-version dispatch. Genuine v2 coordinators remain unchanged.
import {
  type ControlPlaneDb,
  type ControlPlaneError,
  ControlPlaneStatementFailed,
  MegapotCutoffRejected,
  type MegapotCutoffStore,
} from "@pirate/application";
import type {
  OwnerMegapotCutoffCeilings,
  OwnerMegapotDrawingKey,
  OwnerMegapotSettlementStore,
} from "@pirate/application/owner-megapot-settlement";
import { Effect, type Layer, Schema } from "effect";
import { boundedLearnerAudioTransaction } from "./bounded-audio-transaction.ts";
import type { MegapotAllocationCoordinator } from "./megapot-allocation-coordinator.ts";
import type { MegapotCommitmentCoordinator } from "./megapot-commitment-coordinator.ts";
import { makeMegapotCutoffCoordinator } from "./megapot-cutoff-coordinator.ts";
import type { makeOwnerMegapotCommitmentCoordinator } from "./owner-megapot-commitment-coordinator.ts";

type Runtime = Layer.Layer<ControlPlaneDb, ControlPlaneError, never>;
const Id = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the native codec rejects controls and unpaired surrogates while preserving valid Unicode identifiers.
  Schema.isPattern(/^[^\s\u0000-\u001f\u007f\uD800-\uDFFF]+$/u),
);
const Draw = Schema.String.check(Schema.isPattern(/^(?:0|[1-9][0-9]*)$/u));
const Key = Schema.Struct({ poolLegId: Id, drawingId: Draw });
const Due = Schema.Struct({
  poolLegId: Id,
  drawingId: Draw,
  beneficiaryVersion: Schema.Literals([2, 3]),
  entryCutoffAt: Schema.String,
});
const bad = (label: string) =>
  new ControlPlaneStatementFailed({
    label,
    sqlState: null,
    constraint: null,
    outcomeCertainty: "completed",
  });

function makeControlPlaneMegapotBeneficiaryVersionReader(runtime: Runtime) {
  const query = Effect.fn("VersionedMegapot.query")(function* <
    S extends Schema.ConstraintDecoder<unknown>,
  >(
    label: string,
    text: string,
    values: readonly unknown[],
    schema: S,
  ): Effect.fn.Return<S["Type"], ControlPlaneError> {
    return yield* boundedLearnerAudioTransaction((tx) =>
      Effect.gen(function* () {
        const isolation = yield* tx.execute<unknown>({
          label: "versioned-megapot.isolation",
          text: "SELECT current_setting('transaction_isolation') AS isolation",
          values: [],
          readonly: true,
        });
        yield* Effect.try({
          try: () => {
            if (isolation.rows.length !== 1) throw new Error();
            Schema.decodeUnknownSync(
              Schema.Struct({ isolation: Schema.Literal("read committed") }),
              { onExcessProperty: "error" },
            )(isolation.rows[0]);
          },
          catch: () => bad("versioned-megapot.isolation"),
        });
        const response = yield* tx.execute<unknown>({ label, text, values, readonly: true });
        return yield* Effect.try({
          try: () => {
            if (response.rows.length !== 1) throw new Error();
            const outer = Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Unknown }), {
              onExcessProperty: "error",
            })(response.rows[0]);
            return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(outer.result);
          },
          catch: () => bad(label),
        });
      }),
    ).pipe(Effect.provide(runtime));
  });
  const read = Effect.fn("VersionedMegapot.version")(function* (key: OwnerMegapotDrawingKey) {
    const checked = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(Key, { onExcessProperty: "error" })(key),
      catch: () => bad("versioned-megapot.key"),
    });
    return yield* query(
      "versioned-megapot.version",
      "SELECT read_megapot_beneficiary_version_private_v1($1,$2::numeric)::integer AS result",
      [checked.poolLegId, checked.drawingId],
      Schema.Literals([2, 3]),
    );
  });
  return Object.freeze({
    read,
    due: (before: string, limit: number) =>
      query(
        "versioned-megapot.due",
        "SELECT list_versioned_megapot_cutoff_due_private_v1($1::timestamptz,$2) AS result",
        [before, limit],
        Schema.Array(Due),
      ),
    zeroDue: (limit: number) =>
      query(
        "versioned-megapot.zero-due",
        "SELECT list_owner_zero_allocation_due_private_v1($1) AS result",
        [limit],
        Schema.Array(Key),
      ),
  });
}

export function makeVersionedMegapotCutoffCoordinator(input: {
  readonly runtime: Runtime;
  readonly account: Parameters<typeof makeMegapotCutoffCoordinator>[0];
  readonly ownerStore: OwnerMegapotSettlementStore;
  readonly ownerCeilings: OwnerMegapotCutoffCeilings | null;
}) {
  const versions = makeControlPlaneMegapotBeneficiaryVersionReader(input.runtime);
  const freezeDue = Effect.fn("VersionedMegapot.freezeDue")(function* (command?: {
    readonly limit?: number;
  }) {
    const milliseconds = (input.account.now ?? Date.now)(),
      limit = command?.limit ?? 50;
    if (!Number.isFinite(milliseconds) || !Number.isInteger(limit) || limit < 1 || limit > 500)
      return yield* Effect.fail(new MegapotCutoffRejected({ reason: "invalid-config" }));
    const before = new Date(milliseconds).toISOString();
    const due = yield* versions.due(before, limit);
    // The retained v2 store must filter persisted beneficiary_version=2 and
    // use the reviewed original after-drawing-lock admission hold/source read.
    const accountCandidates = due.some((key) => key.beneficiaryVersion === 2)
      ? yield* input.account.store.loadDue({ cutoffAtOrBefore: before, limit: 500 })
      : [];
    return yield* Effect.forEach(
      due,
      Effect.fn("VersionedMegapot.freezeOriginal")(function* (key) {
        if (key.beneficiaryVersion === 3)
          return yield* input.ownerStore.freeze(
            { poolLegId: key.poolLegId, drawingId: key.drawingId },
            input.ownerCeilings,
          );
        const candidate = accountCandidates.find(
          (c) => c.poolLegId === key.poolLegId && c.drawingId.toString() === key.drawingId,
        );
        if (candidate === undefined)
          return yield* Effect.fail(new MegapotCutoffRejected({ reason: "cutoff-conflict" }));
        const isolated: MegapotCutoffStore = {
          loadDue: () => Effect.succeed([candidate]),
          freeze: input.account.store.freeze,
        };
        const results = yield* makeMegapotCutoffCoordinator({
          ...input.account,
          store: isolated,
          now: () => milliseconds,
        }).freezeDue({ limit: 1 });
        const result = results[0];
        if (results.length !== 1 || result === undefined)
          return yield* Effect.fail(bad("versioned-megapot.original-result"));
        return result;
      }),
      { concurrency: 1 },
    );
  });
  return Object.freeze({ freezeDue });
}

export function makeVersionedMegapotAllocationCoordinator(input: {
  readonly runtime: Runtime;
  readonly account: MegapotAllocationCoordinator;
  readonly ownerStore: OwnerMegapotSettlementStore;
}) {
  const versions = makeControlPlaneMegapotBeneficiaryVersionReader(input.runtime);
  const allocate = Effect.fn("VersionedMegapot.allocate")(function* (key: OwnerMegapotDrawingKey) {
    return (yield* versions.read(key)) === 2
      ? yield* input.account.allocate({
          poolLegId: key.poolLegId,
          drawingId: BigInt(key.drawingId),
        })
      : yield* input.ownerStore.allocate(key);
  });
  const allocateZeroNet = Effect.fn("VersionedMegapot.allocateZeroNet")(function* (limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      return yield* Effect.fail(bad("versioned-megapot.zero-limit"));
    const due = yield* versions.zeroDue(limit);
    if (due.length > limit) return yield* Effect.fail(bad("versioned-megapot.zero-limit"));
    // No invented claim/receipt or status mutation. Each actual original
    // drawing is revalidated under its native lock; uncertainty stops this pass.
    return yield* Effect.forEach(due, (key) => input.ownerStore.allocate(key), { concurrency: 1 });
  });
  return Object.freeze({ allocate, allocateZeroNet });
}

export function makeVersionedMegapotCommitmentCoordinator(input: {
  readonly runtime: Runtime;
  readonly account: MegapotCommitmentCoordinator;
  readonly owner: ReturnType<typeof makeOwnerMegapotCommitmentCoordinator>;
}) {
  const versions = makeControlPlaneMegapotBeneficiaryVersionReader(input.runtime);
  return Object.freeze({
    commit: Effect.fn("VersionedMegapot.commit")(function* (key: OwnerMegapotDrawingKey) {
      return (yield* versions.read(key)) === 2
        ? yield* input.account.commit({
            poolLegId: key.poolLegId,
            drawingId: BigInt(key.drawingId),
          })
        : yield* input.owner.commit(key);
    }),
  });
}
