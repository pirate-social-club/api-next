import {
  AuthError,
  BadRequest,
  type KaraokeAttempt,
  type KaraokeAttemptCreateRequest,
  type KaraokeLeaderboardQuery,
  type KaraokeSession,
  type KaraokeSongLeaderboard,
  NotFound,
} from "@pirate/contracts";
import type { DecodedRequest, EndpointHandler, Principal } from "./transport.ts";
import { withEndpointResult } from "./transport.ts";

export interface KaraokeHandlerServices {
  readonly createAttempt: (input: {
    readonly communityId: string;
    readonly postId: string;
    readonly personaId: string | null;
    readonly userId: string;
    readonly idempotencyKey: string;
    readonly timezone: string | null;
  }) => Promise<KaraokeSession>;
  readonly getAttempt: (input: {
    readonly attemptId: string;
    readonly communityId: string;
    readonly userId: string;
  }) => Promise<KaraokeAttempt | null>;
  readonly getLeaderboard: (input: {
    readonly communityId: string;
    readonly limit: number | undefined;
    readonly postId: string;
    readonly userId: string;
  }) => Promise<KaraokeSongLeaderboard>;
}

type KaraokePath = {
  readonly communityId: string;
  readonly postId?: string;
  readonly attemptId?: string;
};
type KaraokeHeaders = { readonly "idempotency-key": string };

const karaokeActor = (principal: Principal | null): string => {
  if (principal === null || (principal.kind !== "user" && principal.kind !== "admin")) {
    throw new AuthError({ message: "Authorization failed" });
  }
  return principal.subject;
};

const karaokePath = (request: DecodedRequest): KaraokePath => request.params as KaraokePath;

const createAttempt: (services: KaraokeHandlerServices) => EndpointHandler =
  (services) => async (request) => {
    const userId = karaokeActor(request.principal);
    const path = karaokePath(request);
    const headers = request.headers as KaraokeHeaders;
    const body = (request.body ?? {}) as KaraokeAttemptCreateRequest;
    if (
      !path.postId ||
      typeof headers["idempotency-key"] !== "string" ||
      headers["idempotency-key"].trim() === ""
    ) {
      throw new BadRequest({
        message: "Karaoke attempt creation requires postId and Idempotency-Key",
      });
    }

    const result = await services.createAttempt({
      communityId: path.communityId,
      idempotencyKey: headers["idempotency-key"],
      postId: path.postId,
      personaId: body.persona_id ?? null,
      timezone: body.timezone ?? null,
      userId,
    });
    return withEndpointResult(result, 201);
  };

const getAttempt: (services: KaraokeHandlerServices) => EndpointHandler =
  (services) => async (request) => {
    const userId = karaokeActor(request.principal);
    const path = karaokePath(request);
    if (!path.attemptId) throw new BadRequest({ message: "Karaoke attemptId is required" });
    const result = await services.getAttempt({
      attemptId: path.attemptId,
      communityId: path.communityId,
      userId,
    });
    if (result === null) throw new NotFound({ message: "Karaoke attempt not found" });
    return withEndpointResult(result);
  };

const leaderboard: (services: KaraokeHandlerServices) => EndpointHandler =
  (services) => async (request) => {
    const userId = karaokeActor(request.principal);
    const path = karaokePath(request);
    if (!path.postId) throw new BadRequest({ message: "Karaoke leaderboard requires postId" });
    const query = (request.query ?? {}) as KaraokeLeaderboardQuery;
    const limit = query.limit === undefined ? undefined : Number(query.limit);
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
      throw new BadRequest({
        message: "Karaoke leaderboard limit must be an integer from 1 to 100",
      });
    }
    const result = await services.getLeaderboard({
      communityId: path.communityId,
      limit,
      postId: path.postId,
      userId,
    });
    return withEndpointResult(result);
  };

export type KaraokeHandlers = Readonly<Record<string, EndpointHandler>> & {
  readonly CreateKaraokeAttempt: EndpointHandler;
  readonly GetKaraokeAttempt: EndpointHandler;
  readonly GetKaraokeLeaderboard: EndpointHandler;
};

export const makeKaraokeHandlers = (services: KaraokeHandlerServices): KaraokeHandlers => ({
  CreateKaraokeAttempt: createAttempt(services),
  GetKaraokeAttempt: getAttempt(services),
  GetKaraokeLeaderboard: leaderboard(services),
});
