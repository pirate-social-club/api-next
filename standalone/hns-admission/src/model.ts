import * as Domain from "@alchemy.run/domain";
import { DateTime, Schema } from "effect";
import { State, advance } from "./ceremony.ts";
import { Hash } from "./records.ts";
import { Seconds } from "./protocol.ts";
import { Code } from "./outcomes.ts";
const Action = Schema.Union([
  Schema.Struct({ type: Schema.Literal("Consent"), deadline: Seconds }),
  Schema.Struct({ type: Schema.Literal("Suspend"), reason: Code }),
  Schema.Struct({ type: Schema.Literal("Cancel") }),
  Schema.Struct({ type: Schema.Literal("Unavailable"), reason: Code }),
  Schema.Struct({
    type: Schema.Literal("Observed"),
    includedAt: Schema.NullOr(Seconds),
    ownershipEpoch: Hash,
    safe: Schema.Boolean,
    transferPending: Schema.Boolean,
  }),
]);
export class StateRecorded extends Domain.Event("StateRecorded", {
  snapshot: State,
}) {}
export class StateConflict extends Domain.Rejection("StateConflict", {
  reason: Code,
}) {}
export class CreateCeremony extends Domain.Command("CreateCeremony", {
  target: Hash,
  input: { snapshot: State },
  events: [StateRecorded],
  rejects: [StateConflict],
}) {}
export class ApplyObservation extends Domain.Command("ApplyObservation", {
  target: Hash,
  input: { expectedRevision: Schema.Int, action: Action },
  events: [StateRecorded],
  rejects: [StateConflict],
}) {}
export class CheckDeadlines extends Domain.Command("CheckDeadlines", {
  target: Hash,
  events: [StateRecorded],
}) {}
export class Ceremony extends Domain.Aggregate("Ceremony", {
  id: Hash,
  state: Schema.NullOr(State),
  initial: null,
  commands: [CreateCeremony, ApplyObservation, CheckDeadlines],
  decide: {
    CreateCeremony: (s, c, ctx) => {
      if (c.snapshot.id !== ctx.id)
        return new StateConflict({ reason: "binding_mismatch" });
      if (s)
        return s.bindingDigest === c.snapshot.bindingDigest
          ? []
          : new StateConflict({ reason: "request_conflict" });
      return [new StateRecorded({ snapshot: c.snapshot })];
    },
    ApplyObservation: (s, c, ctx) => {
      if (!s || s.revision !== c.expectedRevision)
        return new StateConflict({ reason: "revision_conflict" });
      const now = Math.floor(DateTime.toEpochMillis(ctx.now) / 1000);
      return [
        new StateRecorded({ snapshot: advance(s, { ...c.action, now }) }),
      ];
    },
    CheckDeadlines: (s, _c, ctx) => {
      if (!s) return [];
      const next = advance(s, {
        type: "Tick",
        now: Math.floor(DateTime.toEpochMillis(ctx.now) / 1000),
      });
      return next === s ? [] : [new StateRecorded({ snapshot: next })];
    },
  },
  evolve: { StateRecorded: (_s, e) => e.snapshot },
}) {}
export class AdmissionModel extends Domain.Model("HnsAdmission", {
  aggregates: [Ceremony],
}) {}
