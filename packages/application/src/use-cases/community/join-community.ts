import {
  BadRequest,
  Conflict,
  GateUnsatisfied,
  InternalError,
  type JoinCommunity,
  MembershipRequired,
  NotFound,
} from "@pirate/contracts";
import { Effect, type Schema } from "effect";
import { CommunityRepositoryError, type JoinDocument, type M2Actor } from "../../ports.ts";
import { type CommunityServices, isUsableId } from "./services.ts";

export type JoinCommunityInput = Readonly<{
  readonly communityId: string;
  readonly actor: M2Actor;
  readonly body?: Schema.Schema.Type<(typeof JoinCommunity.request)["body"]>;
}>;

const invalidJoin = () => new BadRequest({ message: "Invalid community join request" });

const mapJoinFailure = (error: CommunityRepositoryError) => {
  if (error.reason === "membership-required") {
    return new GateUnsatisfied({
      message: "Community membership gates are not satisfied",
      details: { reason: "unsupported" },
    });
  }
  if (error.reason === "constraint") {
    return new Conflict({
      message: "Community join conflicts with existing membership or persona state",
    });
  }
  if (error.reason === "not-found") {
    return new NotFound({ message: "Community not found" });
  }
  return new InternalError({ message: "Community join failed" });
};

export const joinCommunity = Effect.fn("joinCommunity")(function* (
  input: JoinCommunityInput,
  services: CommunityServices,
): Effect.fn.Return<
  JoinDocument,
  BadRequest | Conflict | GateUnsatisfied | InternalError | MembershipRequired | NotFound
> {
  if (!isUsableId(input.communityId) || !isUsableId(input.actor.userId)) {
    return yield* invalidJoin();
  }

  const eligibility = yield* services.communityStore
    .getJoinEligibility({ communityId: input.communityId, userId: input.actor.userId })
    .pipe(
      Effect.mapError((error) =>
        error instanceof CommunityRepositoryError && error.reason === "not-found"
          ? new NotFound({ message: "Community not found" })
          : new InternalError({ message: "Community eligibility lookup failed" }),
      ),
    );
  if (eligibility === null) return yield* new NotFound({ message: "Community not found" });
  if (eligibility.status === "verification_required" || eligibility.status === "gate_failed") {
    return yield* new GateUnsatisfied({
      message: "Community membership gates are not satisfied",
      details: {
        reason:
          eligibility.status === "verification_required"
            ? "missing_verification"
            : (eligibility.failure_reason ?? "unsupported"),
      },
    });
  }
  if (eligibility.status === "banned") {
    return yield* new MembershipRequired({ message: "Community membership is unavailable" });
  }

  // Spec 014 section 10.2: a join that commits an active membership must
  // resolve a persona, while a request-mode join never carries a choice
  // because an intent does not pre-bind identity.
  const body = input.body ?? {};
  if (eligibility.membership_mode === "request") {
    if (body.persona !== undefined) return yield* invalidJoin();
  } else if (eligibility.status !== "already_joined" && body.persona === undefined) {
    return yield* invalidJoin();
  }

  return yield* services.communityStore
    .join({ communityId: input.communityId, actor: input.actor, body })
    .pipe(
      Effect.mapError((error) =>
        error instanceof CommunityRepositoryError
          ? mapJoinFailure(error)
          : new InternalError({ message: "Community join failed" }),
      ),
    );
});
