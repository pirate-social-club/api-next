// Effectful continuation shared by the existing account SQL adapter and private
// guest SQL frames. It grants no authority and contains no scoring/SQL/identity,
// provider/checkpoint/archive/money or qualification policy.
import { Effect } from "effect";
import { deriveStudyPresentationTransition } from "./study-shared-lesson-engine.ts";

type Facts = Parameters<typeof deriveStudyPresentationTransition>[0];
type Transition = ReturnType<typeof deriveStudyPresentationTransition>;
type Complete = Extract<Transition, { kind: "complete" }>;
type Advance = Readonly<{ kind: "advance"; nextPresentationCount: number }>;
type Keep = Readonly<{ kind: "keep_current"; nextPresentationCount: number }>;
type Unchanged = Extract<Transition, { kind: "unchanged" }>;

export interface StudyLessonMutationFrame<E, R = never> {
  readonly complete: (transition: Complete) => Effect.Effect<unknown, E, R>;
  readonly advance: (transition: Advance) => Effect.Effect<unknown, E, R>;
  readonly keepCurrent: (transition: Keep) => Effect.Effect<unknown, E, R>;
  /** Only the durable command/resource receipt may change for rerecord.
   * This callback must not insert an attempt/presentation, advance the queue,
   * update review scheduling or spend a lesson attempt. Paid call accounting
   * remains the owning checkpoint/resource protocol, not a free-provider claim.
   */
  readonly unchanged?: (transition: Unchanged) => Effect.Effect<unknown, E, R>;
}

/** Caller supplies locked actual aggregates AFTER its item mutation. Account
 * callbacks retain its exact SQL and qualification blocks. Guest callbacks are
 * reviewed owner SECURITY DEFINER entrypoints and have no economic projection.
 */
export const continueStudyLessonMutation = Effect.fn("continueStudyLessonMutation")(function* <
  E,
  R,
>(frame: StudyLessonMutationFrame<E, R>, facts: Facts) {
  const transition = deriveStudyPresentationTransition(facts);
  switch (transition.kind) {
    case "complete":
      yield* frame.complete(transition);
      break;
    case "advance":
      yield* frame.advance({
        kind: "advance",
        nextPresentationCount: transition.nextPresentationCount,
      });
      break;
    case "keep_current":
      yield* frame.keepCurrent({
        kind: "keep_current",
        nextPresentationCount: transition.nextPresentationCount,
      });
      break;
    case "unchanged":
      if (frame.unchanged !== undefined) yield* frame.unchanged(transition);
      break;
  }
  return transition;
});
