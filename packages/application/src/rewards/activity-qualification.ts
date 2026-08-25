import type {
  AccountStreakClockV1,
  ActivityPresentationV1,
  ActivityStreakLeaderboardV1,
  StudyAnswerResultV1,
  StudyAnswerSubmissionV1,
  StudySessionV1,
} from "@pirate/contracts";
import { Data, Effect } from "effect";
import { Clock, IdGen, StudyItemSource } from "../ports.ts";
import type { StudyItemSourceSetV1 } from "../study-item-source.ts";
import { canonicalBodyHash } from "../use-cases/content/common.ts";

export { Clock, IdGen, StudyItemSource, StudyItemSourceError } from "../ports.ts";
export type { StudyItemSourceSetV1 } from "../study-item-source.ts";

export type ActivityQualificationStorageReason =
  | "constraint"
  | "invalid-row"
  | "outcome-unknown"
  | "unavailable";

export class ActivityQualificationStorageFailed extends Data.TaggedError(
  "ActivityQualificationStorageFailed",
)<{ readonly reason: ActivityQualificationStorageReason }> {}

export class ActivityQualificationRejected extends Data.TaggedError(
  "ActivityQualificationRejected",
)<{
  readonly reason:
    | "attempt-conflict"
    | "idempotency-conflict"
    | "invalid-input"
    | "not-found"
    | "persona-ineligible"
    | "song-unavailable"
    | "source-unavailable"
    | "timezone-change-too-soon";
}> {}

export type ActivityQualificationFailure =
  | ActivityQualificationRejected
  | ActivityQualificationStorageFailed;

export type StudySessionStartInput = Readonly<{
  accountId: string;
  communityId: string;
  idempotencyKey: string;
  personaId: string;
  postId: string;
  requestedTimezone: string | null;
}>;

export type PreparedStudySessionStart =
  | Readonly<{ kind: "replayed"; session: StudySessionV1 }>
  | Readonly<{
      kind: "ready";
      audioRevision: number;
      lyricsRevision: number;
      timezone: string;
    }>;

export type StudySessionSnapshotInput = Readonly<{
  accountId: string;
  audioRevision: number;
  communityId: string;
  createdAt: string;
  idempotencyKey: string;
  itemIds: readonly string[];
  lyricsRevision: number;
  personaId: string;
  postId: string;
  qualificationPolicyVersionId: "study_session_first_pass_v2@1";
  requestHash: string;
  sessionId: string;
  source: StudyItemSourceSetV1;
  sourceSnapshotHash: string;
  timezone: string;
}>;

export type SubmitStudyAnswerInput = Readonly<{
  accountId: string;
  answer: StudyAnswerSubmissionV1;
  answerId: string;
  answeredAt: string;
  attemptNumber: number;
  communityId: string;
  idempotencyKey: string;
  qualificationId: string;
  requestHash: string;
  sessionId: string;
  sessionItemId: string;
}>;

export interface ActivityQualificationStore {
  readonly prepareStudySessionStart: (
    input: StudySessionStartInput & { readonly requestHash: string },
  ) => Effect.Effect<PreparedStudySessionStart, ActivityQualificationFailure>;
  readonly createStudySession: (
    input: StudySessionSnapshotInput,
  ) => Effect.Effect<StudySessionV1, ActivityQualificationFailure>;
  readonly getStudySession: (input: {
    readonly accountId: string;
    readonly communityId: string;
    readonly sessionId: string;
  }) => Effect.Effect<StudySessionV1 | null, ActivityQualificationStorageFailed>;
  readonly submitStudyAnswer: (
    input: SubmitStudyAnswerInput,
  ) => Effect.Effect<StudyAnswerResultV1, ActivityQualificationFailure>;
  readonly setStreakTimezone: (input: {
    readonly accountId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly timezone: string;
    readonly updatedAt: string;
  }) => Effect.Effect<AccountStreakClockV1, ActivityQualificationFailure>;
  readonly setPresentationPersona: (input: {
    readonly accountId: string;
    readonly communityId: string;
    readonly idempotencyKey: string;
    readonly personaId: string;
    readonly requestHash: string;
    readonly updatedAt: string;
  }) => Effect.Effect<ActivityPresentationV1, ActivityQualificationFailure>;
  readonly getSongLeaderboard: (input: {
    readonly accountId: string | null;
    readonly communityId: string;
    readonly limit: number;
    readonly postId: string;
    readonly readAt: string;
  }) => Effect.Effect<ActivityStreakLeaderboardV1, ActivityQualificationFailure>;
  readonly getCommunityLeaderboard: (input: {
    readonly accountId: string | null;
    readonly communityId: string;
    readonly limit: number;
    readonly readAt: string;
  }) => Effect.Effect<ActivityStreakLeaderboardV1, ActivityQualificationFailure>;
}

export interface ActivityQualificationService {
  readonly startStudySession: (
    input: StudySessionStartInput,
  ) => Effect.Effect<StudySessionV1, ActivityQualificationFailure, Clock | IdGen | StudyItemSource>;
  readonly getStudySession: (
    input: Parameters<ActivityQualificationStore["getStudySession"]>[0],
  ) => Effect.Effect<StudySessionV1, ActivityQualificationFailure>;
  readonly submitStudyAnswer: (
    input: Omit<
      SubmitStudyAnswerInput,
      "answerId" | "answeredAt" | "qualificationId" | "requestHash"
    >,
  ) => Effect.Effect<StudyAnswerResultV1, ActivityQualificationFailure, Clock | IdGen>;
  readonly setStreakTimezone: (input: {
    readonly accountId: string;
    readonly idempotencyKey: string;
    readonly timezone: string;
  }) => Effect.Effect<AccountStreakClockV1, ActivityQualificationFailure, Clock>;
  readonly setPresentationPersona: (input: {
    readonly accountId: string;
    readonly communityId: string;
    readonly idempotencyKey: string;
    readonly personaId: string;
  }) => Effect.Effect<ActivityPresentationV1, ActivityQualificationFailure, Clock>;
  readonly getSongLeaderboard: (
    input: Omit<
      Parameters<ActivityQualificationStore["getSongLeaderboard"]>[0],
      "limit" | "readAt"
    > & { readonly limit?: number },
  ) => Effect.Effect<ActivityStreakLeaderboardV1, ActivityQualificationFailure, Clock>;
  readonly getCommunityLeaderboard: (
    input: Omit<
      Parameters<ActivityQualificationStore["getCommunityLeaderboard"]>[0],
      "limit" | "readAt"
    > & { readonly limit?: number },
  ) => Effect.Effect<ActivityStreakLeaderboardV1, ActivityQualificationFailure, Clock>;
}

const rejected = (reason: ActivityQualificationRejected["reason"]): ActivityQualificationRejected =>
  new ActivityQualificationRejected({ reason });

const hashRequest = (value: unknown): Effect.Effect<string, ActivityQualificationRejected> =>
  canonicalBodyHash(value).pipe(Effect.mapError(() => rejected("invalid-input")));

const nextIdentifier = (prefix: string): Effect.Effect<string, never, IdGen> =>
  Effect.gen(function* () {
    const ids = yield* IdGen;
    return `${prefix}_${yield* ids.next}`;
  });

const instant = (milliseconds: number): string => new Date(milliseconds).toISOString();

export const makeActivityQualificationService = (
  store: ActivityQualificationStore,
): ActivityQualificationService => ({
  startStudySession: (input) =>
    Effect.gen(function* () {
      const requestHash = yield* hashRequest({
        community_id: input.communityId,
        idempotency_key: input.idempotencyKey,
        persona_id: input.personaId,
        post_id: input.postId,
        timezone: input.requestedTimezone,
      });
      const prepared = yield* store.prepareStudySessionStart({ ...input, requestHash });
      if (prepared.kind === "replayed") return prepared.session;

      const sourcePort = yield* StudyItemSource;
      const source = yield* sourcePort
        .getForAcceptedSongRevision({
          communityId: input.communityId,
          postId: input.postId,
          audioRevision: prepared.audioRevision,
          lyricsRevision: prepared.lyricsRevision,
        })
        .pipe(Effect.mapError(() => rejected("source-unavailable")));
      if (
        source.song_revision.community_id !== input.communityId ||
        source.song_revision.post_id !== input.postId ||
        source.song_revision.audio_revision !== prepared.audioRevision ||
        source.song_revision.lyrics_revision !== prepared.lyricsRevision
      ) {
        return yield* rejected("source-unavailable");
      }

      const sourceSnapshotHash = yield* hashRequest(source);
      const sessionId = yield* nextIdentifier("study_session");
      const itemIds = yield* Effect.forEach(source.items, () => nextIdentifier("study_item"));
      const clock = yield* Clock;
      const createdAt = instant(yield* clock.now);
      return yield* store.createStudySession({
        accountId: input.accountId,
        audioRevision: prepared.audioRevision,
        communityId: input.communityId,
        createdAt,
        idempotencyKey: input.idempotencyKey,
        itemIds,
        lyricsRevision: prepared.lyricsRevision,
        personaId: input.personaId,
        postId: input.postId,
        qualificationPolicyVersionId: "study_session_first_pass_v2@1",
        requestHash,
        sessionId,
        source,
        sourceSnapshotHash,
        timezone: prepared.timezone,
      });
    }),
  getStudySession: (input) =>
    store
      .getStudySession(input)
      .pipe(
        Effect.flatMap((session) =>
          session === null ? Effect.fail(rejected("not-found")) : Effect.succeed(session),
        ),
      ),
  submitStudyAnswer: (input) =>
    Effect.gen(function* () {
      const requestHash = yield* hashRequest({
        answer: input.answer,
        attempt_number: input.attemptNumber,
        idempotency_key: input.idempotencyKey,
        session_id: input.sessionId,
        session_item_id: input.sessionItemId,
      });
      const answerId = yield* nextIdentifier("study_answer");
      const qualificationId = yield* nextIdentifier("qualification");
      const clock = yield* Clock;
      const answeredAt = instant(yield* clock.now);
      return yield* store.submitStudyAnswer({
        ...input,
        answerId,
        answeredAt,
        qualificationId,
        requestHash,
      });
    }),
  setStreakTimezone: (input) =>
    Effect.gen(function* () {
      const requestHash = yield* hashRequest({
        idempotency_key: input.idempotencyKey,
        timezone: input.timezone,
      });
      const clock = yield* Clock;
      return yield* store.setStreakTimezone({
        ...input,
        requestHash,
        updatedAt: instant(yield* clock.now),
      });
    }),
  setPresentationPersona: (input) =>
    Effect.gen(function* () {
      const requestHash = yield* hashRequest({
        community_id: input.communityId,
        idempotency_key: input.idempotencyKey,
        persona_id: input.personaId,
      });
      const clock = yield* Clock;
      return yield* store.setPresentationPersona({
        ...input,
        requestHash,
        updatedAt: instant(yield* clock.now),
      });
    }),
  getSongLeaderboard: (input) =>
    Effect.gen(function* () {
      const clock = yield* Clock;
      return yield* store.getSongLeaderboard({
        ...input,
        limit: input.limit ?? 50,
        readAt: instant(yield* clock.now),
      });
    }),
  getCommunityLeaderboard: (input) =>
    Effect.gen(function* () {
      const clock = yield* Clock;
      return yield* store.getCommunityLeaderboard({
        ...input,
        limit: input.limit ?? 50,
        readAt: instant(yield* clock.now),
      });
    }),
});
