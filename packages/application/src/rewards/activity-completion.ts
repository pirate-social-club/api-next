import type {
  ActivityCompletionV1,
  ActivityPresentationStateV1,
  ActivityProgressV1,
} from "@pirate/contracts";
import { Effect } from "effect";
import { Clock } from "../ports.ts";
import type { ActivityQualificationFailure } from "./activity-qualification.ts";

export type ActivityReadIdentity = Readonly<{ accountId: string; communityId: string }>;
export type ActivityCompletionRead = ActivityReadIdentity &
  Readonly<{
    activity: "study" | "karaoke";
    sessionId: string;
    attemptId: string | null;
  }>;
export type ActivityProgressRead = ActivityReadIdentity & Readonly<{ postId: string | null }>;

/** Independent port: phase-0 ports and immutable activity receipts stay unchanged. */
export interface ActivityCompletionStore {
  readonly getCompletion: (
    input: ActivityCompletionRead & { readonly readAt: string },
  ) => Effect.Effect<ActivityCompletionV1, ActivityQualificationFailure>;
  readonly getProgress: (
    input: ActivityProgressRead & { readonly readAt: string },
  ) => Effect.Effect<ActivityProgressV1, ActivityQualificationFailure>;
  readonly getPresentation: (
    input: ActivityReadIdentity & { readonly readAt: string },
  ) => Effect.Effect<ActivityPresentationStateV1, ActivityQualificationFailure>;
}

export const makeActivityCompletionService = (store: ActivityCompletionStore) => ({
  getCompletion: Effect.fn("ActivityCompletion.getCompletion")(function* (
    input: ActivityCompletionRead,
  ) {
    const clock = yield* Clock;
    return yield* store.getCompletion({
      ...input,
      readAt: new Date(yield* clock.now).toISOString(),
    });
  }),
  getProgress: Effect.fn("ActivityCompletion.getProgress")(function* (input: ActivityProgressRead) {
    const clock = yield* Clock;
    return yield* store.getProgress({ ...input, readAt: new Date(yield* clock.now).toISOString() });
  }),
  getPresentation: Effect.fn("ActivityCompletion.getPresentation")(function* (
    input: ActivityReadIdentity,
  ) {
    const clock = yield* Clock;
    return yield* store.getPresentation({
      ...input,
      readAt: new Date(yield* clock.now).toISOString(),
    });
  }),
});
