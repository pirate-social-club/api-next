import * as Domain from "@alchemy.run/domain";
import { Clock, DateTime, Effect, Layer } from "effect";
import { Ceremony, ObservationDue, StateRecorded, Wake } from "./aggregate.ts";
import { HnsObserver, observe } from "./service.ts";
import type { State } from "./ceremony.ts";

export function nextWake(s: State, now: number): number | undefined {
  if (["Cancelled", "Expired", "Suspended"].includes(s.phase)) return undefined;
  const deadlines = [
    ...(s.firstIncludedAt === null ? [s.publicationDeadline] : []),
    ...(s.maturedAt === null && s.maturityDeadline !== null
      ? [s.maturityDeadline]
      : []),
    ...(s.consented
      ? [
          s.consentDeadline,
          ...(s.phase === "ReadyToSubmit"
            ? []
            : [Math.max(now + 1, s.nextObservationAt)]),
        ]
      : []),
  ];
  return deadlines.length
    ? Math.max(now + 1, Math.min(...deadlines))
    : undefined;
}
export class ScheduleCeremony extends Domain.Policy("ScheduleCeremony", {
  from: Ceremony,
  on: [StateRecorded],
}) {}
export class ObserveCeremony extends Domain.Policy("ObserveCeremony", {
  from: Ceremony,
  on: [ObservationDue],
}) {}
export const ScheduleLive = ScheduleCeremony.toLayer(
  Effect.gen(function* () {
    const model = yield* Ceremony;
    return Effect.fn(function* ({ source }) {
      // Read the current snapshot: an old at-least-once delivery cannot re-arm old instructions.
      const state = yield* model.get(source.id);
      if (!state) return;
      const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const at = nextWake(state, now);
      if (at !== undefined)
        yield* model.schedule(source.id, new Wake({}), {
          at: DateTime.makeUnsafe(at * 1000),
          commandId: "ceremony-wake",
        });
    });
  }),
);
export const ObserveLive = ObserveCeremony.toLayer(
  Effect.gen(function* () {
    const model = yield* Ceremony;
    const observer = yield* HnsObserver;
    return Effect.fn(function* ({ source }) {
      // Persist another opportunity before external I/O. Known outages become state
      // and self-schedule; recovery does not depend on six native alarm retries.
      yield* model.schedule(source.id, new Wake({}), {
        after: "5 minutes",
        commandId: "ceremony-wake",
      });
      yield* observe(source.id).pipe(
        Effect.provideService(Ceremony, model),
        Effect.provideService(HnsObserver, observer),
        Effect.catchTag("StateConflict", () => Effect.void),
        Effect.orDie,
      );
    });
  }),
);
export const AutomationLive = Layer.mergeAll(ScheduleLive, ObserveLive);
