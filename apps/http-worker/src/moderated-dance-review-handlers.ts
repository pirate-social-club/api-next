import { AuthError, BadRequest, Conflict, InternalError, NotFound } from "@pirate/contracts";
import { Effect, Schema } from "effect";
import {
  type DanceReviewReadStore,
  type DanceReviewServiceFailure,
  type DanceReviewServices,
  executeDanceReviewCommand,
} from "../../../packages/application/src/use-cases/dance/moderator-review-services.ts";
import {
  ChangeModeratedDanceVisibility,
  GetLatestModeratedDanceReview,
  GetMyModeratedDancePublication,
  GetMyModeratedDanceResult,
  GetOwnerModeratedDanceReview,
  ListOwnerModeratedDanceReviews,
  RecordModeratedDanceVerdict,
  SubmitModeratedDanceReview,
  WithdrawModeratedDanceReview,
} from "../../../packages/contracts/src/dance-review.ts";
import type { EndpointHandler, Principal } from "./transport.ts";

const actor = (principal: Principal | null) => {
  if (principal === null || (principal.kind !== "user" && principal.kind !== "admin"))
    throw new AuthError({ message: "Authentication required" });
  return principal.subject;
};
function error(e: DanceReviewServiceFailure) {
  switch (e.reason) {
    case "invalid_request":
      return new BadRequest({ message: "Invalid Dance review request" });
    case "unauthorized":
      return new AuthError({ message: "Authentication required" });
    case "not_found":
      return new NotFound({ message: "Recording unavailable" });
    case "revision_conflict":
      return new Conflict({ message: "Review or lifecycle changed; reload current status" });
    case "idempotency_conflict":
      return new Conflict({ message: "Command key conflicts with its original request" });
    case "outcome_unknown":
      return new InternalError({
        message: "Review outcome unknown; read current status or replay the same command key",
      });
    default:
      return new InternalError({ message: "Dance review unavailable" });
  }
}
const decoded = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): S["Type"] => {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
  } catch {
    throw new BadRequest({ message: "Invalid Dance review request" });
  }
};
type Store = DanceReviewServices & DanceReviewReadStore;

/** Real account-private command/read surface. The transport has already enforced
 * browser session, exact JSON and Origin/CSRF. No caller selects another actor,
 * review worker, score, qualification, payment or private media object.
 */
export function makeModeratedDanceReviewHandlers(
  storeForAccount: (accountId: string) => Store,
): Readonly<Record<string, EndpointHandler>> {
  const command =
    (operation: "submit" | "visibility" | "withdraw" | "verdict"): EndpointHandler =>
    (ctx) => {
      const accountId = actor(ctx.principal);
      const endpoint =
        operation === "submit"
          ? SubmitModeratedDanceReview
          : operation === "visibility"
            ? ChangeModeratedDanceVisibility
            : operation === "withdraw"
              ? WithdrawModeratedDanceReview
              : RecordModeratedDanceVerdict;
      const path = decoded(endpoint.request.path, ctx.params);
      const body = decoded(endpoint.request.body, ctx.body);
      if (
        body.operation !== operation ||
        body.community_id !== path.communityId ||
        body.review_id !== path.reviewId
      )
        throw new BadRequest({ message: "Dance review path does not match command" });
      return Effect.runPromise(
        executeDanceReviewCommand(body, storeForAccount(accountId)).pipe(Effect.mapError(error)),
        { signal: ctx.signal },
      );
    };
  return {
    SubmitModeratedDanceReview: command("submit"),
    ChangeModeratedDanceVisibility: command("visibility"),
    WithdrawModeratedDanceReview: command("withdraw"),
    RecordModeratedDanceVerdict: command("verdict"),
    GetMyModeratedDanceResult: (ctx) => {
      const accountId = actor(ctx.principal),
        path = decoded(GetMyModeratedDanceResult.request.path, ctx.params);
      return Effect.runPromise(
        storeForAccount(accountId)
          .getOwnResult(path.communityId, path.reviewId)
          .pipe(Effect.mapError(error)),
        { signal: ctx.signal },
      );
    },
    GetMyModeratedDancePublication: (ctx) => {
      const accountId = actor(ctx.principal),
        path = decoded(GetMyModeratedDancePublication.request.path, ctx.params);
      return Effect.runPromise(
        storeForAccount(accountId)
          .getPublication(path.communityId, path.reviewId)
          .pipe(Effect.mapError(error)),
        { signal: ctx.signal },
      );
    },
    GetLatestModeratedDanceReview: (ctx) => {
      const accountId = actor(ctx.principal),
        path = decoded(GetLatestModeratedDanceReview.request.path, ctx.params);
      return Effect.runPromise(
        storeForAccount(accountId)
          .getLatest(path.communityId, path.postId, path.choreographyId, Number(path.revision))
          .pipe(Effect.mapError(error)),
        { signal: ctx.signal },
      );
    },
    ListOwnerModeratedDanceReviews: (ctx) => {
      const accountId = actor(ctx.principal),
        path = decoded(ListOwnerModeratedDanceReviews.request.path, ctx.params),
        query = decoded(ListOwnerModeratedDanceReviews.request.query, ctx.query ?? {});
      return Effect.runPromise(
        storeForAccount(accountId)
          .ownerQueue(path.communityId, query.cursor ?? null)
          .pipe(Effect.mapError(error)),
        { signal: ctx.signal },
      );
    },
    GetOwnerModeratedDanceReview: (ctx) => {
      const accountId = actor(ctx.principal),
        path = decoded(GetOwnerModeratedDanceReview.request.path, ctx.params);
      return Effect.runPromise(
        storeForAccount(accountId)
          .ownerDetail(path.communityId, path.reviewId)
          .pipe(Effect.mapError(error)),
        { signal: ctx.signal },
      );
    },
  };
}
