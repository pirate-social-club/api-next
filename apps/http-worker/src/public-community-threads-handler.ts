import {
  getPublicCommunityThreads,
  type PublicCommunityThreadsServices,
} from "@pirate/application/use-cases/feed/public-community-threads";
import { Effect } from "effect";
import type { DecodedRequest, EndpointHandler } from "./transport.ts";

type PublicCommunityThreadsPath = Readonly<{ readonly communityRef: string }>;

/**
 * Focused handoff adapter for the public threads endpoint. The production
 * composition intentionally does not install this handler until the
 * coordinator adds its route-specific cache policy.
 */
export const makePublicCommunityThreadsHandler = (
  services: PublicCommunityThreadsServices,
): EndpointHandler => {
  return async (request: DecodedRequest) => {
    const { communityRef } = request.params as PublicCommunityThreadsPath;
    return Effect.runPromise(
      getPublicCommunityThreads(
        {
          communityRef,
          query: request.query as Parameters<typeof getPublicCommunityThreads>[0]["query"],
          ...(request.principal === null ? {} : { viewerUserId: request.principal.subject }),
        },
        services,
      ),
    );
  };
};
