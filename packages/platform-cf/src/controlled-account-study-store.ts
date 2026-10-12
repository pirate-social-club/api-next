import {
  type ControlPlaneError,
  ControlPlaneDb,
  StudyV2StoreFailed,
  type StudyV2Store,
  type StudyV2Failure,
} from "@pirate/application";
import type { ControlledAccountSpokenProtocol } from "@pirate/application/controlled-account-spoken";
import { StudyAnswerResultV2 } from "@pirate/contracts";
import { Effect, type Layer, Schema } from "effect";
import { makeControlPlaneStudyV2Repository, type StudyV2Admission } from "./study-v2-repository.ts";
import { LearnerAudioUploadCaptureSchema } from "./learner-audio-producer-store.ts";
const Reserved = Schema.Union([
  Schema.Struct({ state: Schema.Literal("completed"), result: StudyAnswerResultV2 }),
  Schema.Struct({
    state: Schema.Literal("reserved"),
    commandId: Schema.NonEmptyString,
    leaseToken: Schema.NonEmptyString,
    attemptId: Schema.NonEmptyString,
    artifactId: Schema.NonEmptyString,
    capture: LearnerAudioUploadCaptureSchema,
  }),
]);
const invalid = () => new StudyV2StoreFailed({ reason: "invalid-row" });
export const makeControlledAccountStudyV2Store = (
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  admission?: StudyV2Admission,
): Readonly<{
  ordinary: StudyV2Store;
  reserve: ControlledAccountSpokenProtocol["reserve"];
  finalize: ControlledAccountSpokenProtocol["finalize"];
}> => {
  const repository = makeControlPlaneStudyV2Repository(admission, true);
  const provide = <A>(
    effect: Effect.Effect<A, ControlPlaneError | StudyV2Failure, ControlPlaneDb>,
  ) =>
    effect.pipe(
      Effect.provide(runtime),
      Effect.mapError((error) =>
        error._tag === "StudyV2CommandRejected" || error._tag === "StudyV2StoreFailed"
          ? error
          : error._tag === "ControlPlaneTransactionOutcomeUnknown"
            ? new StudyV2StoreFailed({ reason: "outcome-unknown" })
            : new StudyV2StoreFailed({ reason: "unavailable" }),
      ),
    );
  const ordinary: StudyV2Store = {
    getAvailability: (input) => provide(repository.getAvailability(input)),
    startSession: (input) => provide(repository.startSession(input)),
    getSession: (input) => provide(repository.getSession(input)),
    submitAnswer: (input) => provide(repository.submitAnswer(input)),
    loadSpokenAnswerContext: (input) => provide(repository.loadSpokenAnswerContext(input)),
    reserveSpokenAnswer: (input) => provide(repository.reserveSpokenAnswer(input)),
    failSpokenAnswer: (input) => provide(repository.failSpokenAnswer(input)),
    completeSpokenAnswer: (input) => provide(repository.completeSpokenAnswer(input)),
  };
  return {
    ordinary,
    reserve: Effect.fn("controlledAccountStudy.reserve")(function* (
      input: Parameters<ControlledAccountSpokenProtocol["reserve"]>[0],
    ) {
      const result = yield* provide(repository.reserveSpokenAnswer(input));
      return yield* Effect.try({
        try: () => Schema.decodeUnknownSync(Reserved, { onExcessProperty: "error" })(result),
        catch: invalid,
      });
    }),
    finalize: Effect.fn("controlledAccountStudy.finalize")(function* (
      capture: Parameters<ControlledAccountSpokenProtocol["finalize"]>[0],
      result: Parameters<ControlledAccountSpokenProtocol["finalize"]>[1],
      archive: Parameters<ControlledAccountSpokenProtocol["finalize"]>[2],
    ) {
      return yield* provide(repository.completeSpokenAnswer({ ...result, archive, capture }));
    }),
  };
};
