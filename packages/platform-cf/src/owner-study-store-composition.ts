// Complete frozen property composition candidate; no endpoint activation.
// Guest paths are actual starter3+mutations6. Ordinary API/TG retain their real
// Account store/service; unsupported owner-aware Account spoken authority is
// explicitly unavailable rather than filled with guest reservation locators.

import {
  type DurableParticipationOutcome,
  type GuestParticipationStoreFailure,
  GuestParticipationStoreRejected,
  type LearningAccess,
  type OrdinaryBrowserAccount,
  type OwnerAwareStudyV2Store,
  type OwnerStudyAnswer,
  type ParticipationSource,
  type PreparedGuestStudyContentStore,
  type StudyV2Failure,
  type StudyV2Store,
} from "@pirate/application";
import { GuestParticipationResultV1, StudyAnswerResultV2, StudySessionV2 } from "@pirate/contracts";
import { Effect, Schema } from "effect";
import type {
  OriginalAccountSource,
  OriginalAccountSourceControl,
} from "./owner-account-source-control.ts";

type Starter = Pick<OwnerAwareStudyV2Store, "startSession" | "getSession" | "findStartOperation">;
type Mutations = Pick<
  OwnerAwareStudyV2Store,
  | "submitAnswer"
  | "loadSpokenAnswerContext"
  | "reserveSpokenAnswer"
  | "failSpokenAnswer"
  | "persistSuccessfulSpokenResult"
  | "completeSpokenAnswer"
>;
type AccountSpoken = Pick<
  OwnerAwareStudyV2Store,
  | "reserveSpokenAnswer"
  | "failSpokenAnswer"
  | "persistSuccessfulSpokenResult"
  | "completeSpokenAnswer"
>;
const reject = (reason: GuestParticipationStoreRejected["reason"]) =>
  new GuestParticipationStoreRejected({ reason });
const failure = (error: StudyV2Failure) =>
  error._tag === "StudyV2StoreFailed"
    ? reject("resource-policy-unavailable")
    : reject(
        error.reason === "not-found"
          ? "not-found"
          : error.reason === "idempotency-conflict"
            ? "idempotency-conflict"
            : "authority-conflict",
      );
const sameSource = (a: ParticipationSource, b: ParticipationSource) =>
  a.kind === b.kind &&
  a.ownerId === b.ownerId &&
  (a.kind !== "account" ||
    b.kind !== "account" ||
    (a.accountId === b.accountId && a.personaId === b.personaId));
const assertLiveAccount = (access: LearningAccess, account: OrdinaryBrowserAccount | null) =>
  account !== null &&
  account.kind === "ordinary_account" &&
  access.kind === "account" &&
  access.accountId === account.accountId &&
  access.sessionBinding === account.sessionBinding;

/** `verifiedOrdinaryAccount` is the ACTUAL ordinary classifier/canonicalizer
 * transport output, including protected sessionBinding. Never derive it from
 * request body, actor preference, token text/prefix or an admin/setup principal.
 * Only an independently accepted real Account resource/checkpoint delegate may
 * fill `accountSpoken`; the retained audio generation reference is not one.
 */
export function composeOwnerAwareStudyV2Store(
  deps: Readonly<{
    starter: Starter;
    mutations: Mutations;
    prepared: PreparedGuestStudyContentStore;
    ordinary: StudyV2Store;
    originalAccountSources: OriginalAccountSourceControl;
    verifiedOrdinaryAccount: OrdinaryBrowserAccount | null;
    accountSpoken?: AccountSpoken;
    // Actual accounting authority only; the legacy answer carries no economic
    // participation field. Missing authority refuses BEFORE Account mutation.
    ordinaryParticipation?: (
      input: Readonly<{
        source: OriginalAccountSource;
        communityId: string;
        sessionId: string;
      }>,
    ) => Effect.Effect<GuestParticipationResultV1, GuestParticipationStoreFailure>;
  }>,
): OwnerAwareStudyV2Store {
  const resolve = Effect.fn("OwnerStudyComposition.resolveAccount")(function* (
    input: Readonly<{
      access: LearningAccess;
      communityId: string;
      sessionId: string;
      sessionItemId?: string;
    }>,
  ) {
    if (
      !assertLiveAccount(input.access, deps.verifiedOrdinaryAccount) ||
      input.access.kind !== "account"
    )
      return yield* reject("owner-mismatch");
    const source = yield* deps.originalAccountSources.resolve({
      ...input,
      access: input.access,
    });
    if (source === null) return yield* reject("not-found");
    return source;
  });
  return {
    getAvailability: Effect.fn("OwnerStudyComposition.getAvailability")(function* (
      input: Parameters<OwnerAwareStudyV2Store["getAvailability"]>[0],
    ) {
      if (input.access.kind === "guest")
        return (yield* deps.prepared.get({
          communityId: input.communityId,
          postId: input.postId,
          targetLanguage: null,
          learnerBand: null,
        })).availability;
      if (!assertLiveAccount(input.access, deps.verifiedOrdinaryAccount))
        return yield* reject("owner-mismatch");
      return yield* deps.ordinary
        .getAvailability({
          accountId: input.access.accountId,
          communityId: input.communityId,
          postId: input.postId,
        })
        .pipe(Effect.mapError(failure));
    }),
    startSession: (input) => deps.starter.startSession(input),
    findStartOperation: (input) => deps.starter.findStartOperation(input),
    getSession: Effect.fn("OwnerStudyComposition.getSession")(function* (
      input: Parameters<OwnerAwareStudyV2Store["getSession"]>[0],
    ) {
      if (input.access.kind === "guest") return yield* deps.starter.getSession(input);
      if (!assertLiveAccount(input.access, deps.verifiedOrdinaryAccount))
        return yield* reject("owner-mismatch");
      const session = yield* deps.ordinary
        .getSession({
          accountId: input.access.accountId,
          communityId: input.communityId,
          sessionId: input.sessionId,
        })
        .pipe(Effect.mapError(failure));
      if (session === null) return null;
      const source = yield* resolve(input);
      const safe = yield* Effect.try({
        try: () =>
          Schema.decodeUnknownSync(StudySessionV2, {
            onExcessProperty: "error",
          })(session),
        catch: () => reject("authority-conflict"),
      });
      if (
        safe.persona_id !== source.personaId ||
        safe.session_id !== input.sessionId ||
        safe.community_id !== input.communityId
      )
        return yield* reject("owner-mismatch");
      return { source, session: safe };
    }),
    submitAnswer: Effect.fn("OwnerStudyComposition.submitAnswer")(function* (
      input: Parameters<OwnerAwareStudyV2Store["submitAnswer"]>[0],
    ): Effect.fn.Return<
      DurableParticipationOutcome<OwnerStudyAnswer>,
      GuestParticipationStoreFailure
    > {
      if (input.source.kind === "guest") return yield* deps.mutations.submitAnswer(input);
      if (deps.ordinaryParticipation === undefined)
        return yield* reject("resource-policy-unavailable");
      const source = yield* resolve(input);
      if (
        !sameSource(input.source, source) ||
        input.operation.sourceOwnerId !== source.ownerId ||
        input.operation.kind !== "study_answer" ||
        input.operation.idempotencyKey !== input.idempotencyKey ||
        input.operation.requestHash !== input.requestHash
      )
        return yield* reject("owner-mismatch");
      const result = yield* deps.ordinary
        .submitAnswer({
          accountId: source.accountId,
          acceptedAt: input.acceptedAt,
          answer: input.answer,
          attemptId: input.attemptId,
          attemptNumber: input.attemptNumber,
          communityId: input.communityId,
          idempotencyKey: input.idempotencyKey,
          qualificationId: input.qualificationId,
          requestHash: input.requestHash,
          sessionId: input.sessionId,
          sessionItemId: input.sessionItemId,
        })
        .pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              error._tag === "StudyV2StoreFailed" && error.reason === "outcome-unknown"
                ? Effect.succeed({
                    state: "pending_confirmation" as const,
                    operation: input.operation,
                    outcomeId: null,
                  })
                : Effect.fail(failure(error)),
            onSuccess: (answer) => Effect.succeed({ state: "answer" as const, answer }),
          }),
        );
      if (result.state === "pending_confirmation") return result;
      const safe = yield* Effect.try({
        try: () =>
          Schema.decodeUnknownSync(StudyAnswerResultV2, {
            onExcessProperty: "error",
          })(result.answer),
        catch: () => reject("authority-conflict"),
      });
      if (input.access.kind !== "account") return yield* reject("owner-mismatch");
      const receipt = yield* deps.originalAccountSources.receipt({
        ...input,
        access: input.access,
      });
      if (receipt === null)
        return {
          state: "pending_confirmation",
          operation: input.operation,
          outcomeId: null,
        };
      if (
        !sameSource(receipt.source, source) ||
        safe.session.persona_id !== source.personaId ||
        safe.session.session_id !== input.sessionId ||
        safe.session_item_id !== input.sessionItemId ||
        safe.attempt_number !== input.attemptNumber
      )
        return yield* reject("owner-mismatch");
      // Native original attempt ID wins; a new generated attempt/qualification
      // draw never becomes a fake durable operation identity on Account replay.
      const participation = yield* deps.ordinaryParticipation({
        source,
        communityId: input.communityId,
        sessionId: input.sessionId,
      });
      const decodedParticipation = yield* Effect.try({
        try: () =>
          Schema.decodeUnknownSync(GuestParticipationResultV1, {
            onExcessProperty: "error",
          })(participation),
        catch: () => reject("authority-conflict"),
      });
      return {
        state: "completed",
        operation: input.operation,
        outcomeId: receipt.attemptId,
        result: { source, answer: safe, participation: decodedParticipation },
      };
    }),
    loadSpokenAnswerContext: Effect.fn("OwnerStudyComposition.loadSpokenAnswerContext")(function* (
      input: Parameters<OwnerAwareStudyV2Store["loadSpokenAnswerContext"]>[0],
    ) {
      if (input.access.kind === "guest")
        return yield* deps.mutations.loadSpokenAnswerContext(input);
      const source = yield* resolve(input);
      const context = yield* deps.ordinary
        .loadSpokenAnswerContext({
          accountId: source.accountId,
          communityId: input.communityId,
          sessionId: input.sessionId,
          sessionItemId: input.sessionItemId,
          idempotencyKey: input.idempotencyKey,
        })
        .pipe(Effect.mapError(failure));
      if (context.item.session_item_id !== input.sessionItemId)
        return yield* reject("owner-mismatch");
      return { source, context };
    }),
    reserveSpokenAnswer: Effect.fn("OwnerStudyComposition.reserveSpokenAnswer")(function* (
      input: Parameters<OwnerAwareStudyV2Store["reserveSpokenAnswer"]>[0],
    ) {
      if (input.source.kind === "guest") return yield* deps.mutations.reserveSpokenAnswer(input);
      if (
        !assertLiveAccount(input.access, deps.verifiedOrdinaryAccount) ||
        input.access.kind !== "account" ||
        input.source.accountId !== input.access.accountId ||
        input.operation.sourceOwnerId !== input.source.ownerId ||
        input.operation.kind !== "study_answer" ||
        input.operation.idempotencyKey !== input.idempotencyKey ||
        input.operation.requestHash !== input.requestHash
      )
        return yield* reject("owner-mismatch");
      // A separately accepted Account delegate owns native original session/item/
      // resource correlation. The frozen input has no community locator to infer.
      if (deps.accountSpoken === undefined) return yield* reject("resource-policy-unavailable");
      return yield* deps.accountSpoken.reserveSpokenAnswer(input);
    }),
    failSpokenAnswer: (input) =>
      input.source.kind === "guest"
        ? deps.mutations.failSpokenAnswer(input)
        : deps.accountSpoken === undefined
          ? Effect.fail(reject("resource-policy-unavailable"))
          : deps.accountSpoken.failSpokenAnswer(input),
    persistSuccessfulSpokenResult: (input) =>
      input.checkpoint.source.kind === "guest"
        ? deps.mutations.persistSuccessfulSpokenResult(input)
        : deps.accountSpoken === undefined
          ? Effect.fail(reject("resource-policy-unavailable"))
          : deps.accountSpoken.persistSuccessfulSpokenResult(input),
    completeSpokenAnswer: (input) =>
      input.source.kind === "guest"
        ? deps.mutations.completeSpokenAnswer(input)
        : deps.accountSpoken === undefined
          ? Effect.fail(reject("resource-policy-unavailable"))
          : deps.accountSpoken.completeSpokenAnswer(input),
  };
}
