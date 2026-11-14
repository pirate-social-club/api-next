import * as Domain from "@alchemy.run/domain";
import { DateTime, Schema } from "effect";
import { State, advance } from "./ceremony.ts";
import { Hash } from "./records.ts";
import { Seconds } from "./protocol.ts";
import { Observation } from "./observation.ts";
import { Code, ConflictDetail } from "./outcomes.ts";
const Action = Schema.Union([
  Schema.Struct({ type: Schema.Literal("Consent"), deadline: Seconds }),
  Schema.Struct({ type: Schema.Literal("Suspend"), reason: Code }),
  Schema.Struct({ type: Schema.Literal("Cancel") }),
  Schema.Struct({
    type: Schema.Literal("Unavailable"),
    reason: Code,
    detail: Schema.optionalKey(ConflictDetail),
  }),
  Schema.Struct({
    type: Schema.Literal("Observed"),
    includedAt: Schema.NullOr(Seconds),
    ownershipEpoch: Hash,
    evidence: Schema.optionalKey(Observation),
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
export class ReserveObservation extends Domain.Command("ReserveObservation", {
  target: Hash,
  input: { expectedRevision: Schema.Int },
  events: [StateRecorded],
  rejects: [StateConflict],
}) {}
export class ObservationDue extends Domain.Event("ObservationDue", {}) {}
export class Wake extends Domain.Command("Wake", {
  target: Hash,
  events: [StateRecorded, ObservationDue],
}) {}
export class Ceremony extends Domain.Aggregate("Ceremony", {
  id: Hash,
  state: Schema.NullOr(State),
  initial: null,
  commands: [
    CreateCeremony,
    ApplyObservation,
    CheckDeadlines,
    ReserveObservation,
    Wake,
  ],
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
      const now = Math.max(
        s.updatedAt,
        Math.floor(DateTime.toEpochMillis(ctx.now) / 1000),
      );
      const next = advance(s, { ...c.action, now });
      const observing = ["Observed", "Unavailable", "Suspend"].includes(
        c.action.type,
      );
      const failures =
        c.action.type === "Unavailable"
          ? Math.min(s.observationFailures + 1, 10)
          : 0;
      return [
        new StateRecorded({
          snapshot: observing
            ? {
                ...next,
                observationFailures: failures,
                nextObservationAt:
                  now +
                  Math.min(
                    300,
                    60 * 2 ** Math.min(Math.max(failures - 1, 0), 3),
                  ),
              }
            : next,
        }),
      ];
    },
    ReserveObservation: (s, c, ctx) => {
      if (!s || s.revision !== c.expectedRevision)
        return new StateConflict({ reason: "revision_conflict" });
      const now = Math.max(
        s.updatedAt,
        Math.floor(DateTime.toEpochMillis(ctx.now) / 1000),
      );
      if (now < s.nextObservationAt)
        return new StateConflict({ reason: "observation_pending" });
      return [
        new StateRecorded({
          snapshot: {
            ...s,
            revision: s.revision + 1,
            updatedAt: now,
            nextObservationAt: now + 45,
          },
        }),
      ];
    },
    Wake: (s, _c, ctx) => {
      if (!s) return [];
      const now = Math.max(
        s.updatedAt,
        Math.floor(DateTime.toEpochMillis(ctx.now) / 1000),
      );
      const next = advance(s, { type: "Tick", now });
      const events: (StateRecorded | ObservationDue)[] =
        next === s ? [] : [new StateRecorded({ snapshot: next })];
      if (
        next.consented &&
        ["AwaitingPublication", "Maturing"].includes(next.phase) &&
        now >= next.nextObservationAt
      )
        events.push(new ObservationDue({}));
      return events;
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
  evolve: { StateRecorded: (_s, e) => e.snapshot, ObservationDue: (s) => s },
}) {}
