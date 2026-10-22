import {
  type FundingScope,
  makeSongMegapotContributionReads,
  makeSongMegapotContributions,
  SongContributionFailure,
  type SongContributionPorts,
  type SongContributionReadPorts,
} from "@pirate/application/use-cases/rewards/song-megapot-contributions";
import {
  AuthError,
  ContributionBadRequestV2,
  ContributionConflictV2,
  ContributionForbiddenV2,
  ContributionNotFoundV2,
  ContributionPausedV2,
  ContributionRateLimitedV2,
  ContributionUnavailableV2,
  ErrorV2,
  type FundingOperationV2,
  InternalError,
  songMegapotContributionRegistryV2,
} from "@pirate/contracts";
import { Effect, Schema } from "effect";
import type { DecodedRequest, EndpointHandler } from "./transport.ts";

export type SongMegapotContributionHandlerServices = Readonly<{
  commands: (authorization: Pick<SongContributionPorts, "authorize">) => SongContributionPorts;
  reads: (authorization: Pick<SongContributionReadPorts, "authorize">) => SongContributionReadPorts;
}>;
export type SongMegapotContributionHandlers = Readonly<
  Record<keyof typeof songMegapotContributionRegistryV2, EndpointHandler>
>;

/** The transport authenticates the host-only browser session, checks exact
 * Origin/CSRF on mutations, and closes/limits JSON before any handler runs.
 * These constructors also bind the capability to this request's exact account
 * and target. No browser actor, membership flag or wallet address is authority.
 */
export function makeSongMegapotContributionHandlers(
  services: SongMegapotContributionHandlerServices,
): SongMegapotContributionHandlers {
  const handler =
    (name: keyof typeof songMegapotContributionRegistryV2): EndpointHandler =>
    async (input: DecodedRequest) => {
      if (
        input.principal === null ||
        (input.principal.kind !== "user" && input.principal.kind !== "admin")
      )
        throw new AuthError({ message: "Authentication required" });
      const accountId = input.principal.subject;
      const definition = songMegapotContributionRegistryV2[name];
      const path = Schema.decodeUnknownSync(definition.request.path, { onExcessProperty: "error" })(
        input.params,
      );
      const scope: FundingScope = {
        communityId: path.communityId,
        postId: path.postId,
        contributionId: "contributionId" in path ? path.contributionId : null,
      };
      const authorization = {
        authorize: (requested: FundingScope) =>
          requested.communityId === scope.communityId &&
          requested.postId === scope.postId &&
          requested.contributionId === scope.contributionId
            ? Effect.succeed({ accountId })
            : Effect.fail(new SongContributionFailure({ code: "not_found" })),
      };
      try {
        if (name === "GetSongMegapotFundingContextV2")
          return await Effect.runPromise(
            makeSongMegapotContributionReads(services.reads(authorization)).context(
              scope,
              input.query,
            ),
            { signal: input.signal },
          );
        if (name === "GetSongMegapotContributionV2")
          return await Effect.runPromise(
            makeSongMegapotContributionReads(services.reads(authorization)).current(scope),
            { signal: input.signal },
          );
        if (name === "GetSongMegapotContributionCommandV2") {
          if (!("operation" in path) || !("idempotencyKey" in path))
            throw new InternalError({ message: "Invalid contribution read binding" });
          return await Effect.runPromise(
            makeSongMegapotContributionReads(services.reads(authorization)).command(
              scope,
              path.operation,
              path.idempotencyKey,
            ),
            { signal: input.signal },
          );
        }
        // Do not put a current pause/capacity/profile guard before execute:
        // original authenticated same-key receipts must survive those changes.
        return await Effect.runPromise(
          makeSongMegapotContributions(services.commands(authorization)).execute(
            name as FundingOperationV2,
            scope,
            input.body,
          ),
          { signal: input.signal },
        );
      } catch (cause) {
        if (!(cause instanceof SongContributionFailure)) {
          if (cause instanceof InternalError) throw cause;
          throw new InternalError({ message: "Contribution service failed", cause });
        }
        const details = Schema.decodeUnknownSync(ErrorV2, { onExcessProperty: "error" })({
          object: "contribution_error",
          version: 2,
          code: cause.code,
          request_id: crypto.randomUUID(),
          retry_after_seconds: null,
          current_state_href: null,
          refusal_receipt: cause.refusalReceipt ?? null,
        });
        const args = { message: "Contribution request refused", details: { ...details }, cause };
        switch (cause.code) {
          case "invalid_request":
          case "amount_below_minimum":
            throw new ContributionBadRequestV2(args);
          case "unauthenticated":
            throw new AuthError({ message: "Authentication required", cause });
          case "forbidden":
          case "origin_rejected":
          case "csrf_rejected":
          case "account_excluded":
            throw new ContributionForbiddenV2(args);
          case "not_found":
          case "persona_not_owned":
          case "persona_wrong_community":
            throw new ContributionNotFoundV2(args);
          case "rate_limited":
            throw new ContributionRateLimitedV2(args);
          case "paused":
            throw new ContributionPausedV2(args);
          case "policy_unavailable":
          case "mixed_objective_unavailable":
          case "schedule_unproven":
          case "gas_budget_unavailable":
          case "attestation_unavailable":
          case "outcome_unknown":
          case "durable_recovery_unavailable":
          case "cancellation_recovery_unavailable":
            throw new ContributionUnavailableV2(args);
          default:
            throw new ContributionConflictV2(args);
        }
      }
    };
  return {
    GetSongMegapotFundingContextV2: handler("GetSongMegapotFundingContextV2"),
    CreateSongMegapotContributionV2: handler("CreateSongMegapotContributionV2"),
    GetSongMegapotContributionV2: handler("GetSongMegapotContributionV2"),
    GetSongMegapotContributionCommandV2: handler("GetSongMegapotContributionCommandV2"),
    ClaimSongMegapotContributionSubmissionV2: handler("ClaimSongMegapotContributionSubmissionV2"),
    ObserveSongMegapotContributionV2: handler("ObserveSongMegapotContributionV2"),
    RecoverSongMegapotContributionV2: handler("RecoverSongMegapotContributionV2"),
    PrepareSongMegapotContributionCancellationV2: handler(
      "PrepareSongMegapotContributionCancellationV2",
    ),
  };
}
