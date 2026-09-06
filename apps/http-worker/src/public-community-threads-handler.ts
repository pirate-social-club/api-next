import {
  getPublicCommunityThreads,
  type PublicCommunityThreadsServices,
} from "@pirate/application/use-cases/feed/public-community-threads";
import { Effect } from "effect";
import type { DecodedRequest, EndpointHandler } from "./transport.ts";

type PublicCommunityThreadsPath = Readonly<{ readonly communityRef: string }>;

/**
 * Anonymous read even when a caller supplies credentials. The installed
 * transport applies the route-specific no-store policy.
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
        },
        services,
      ),
    );
  };
};
