import {
  type CommunityNavigationStore,
  listMyModerationCommunities,
  listPopularCommunities,
} from "@pirate/application/use-cases/community-navigation";
import { AuthError } from "@pirate/contracts";
import { Effect } from "effect";
import type { EndpointHandler } from "./transport.ts";

export function makeCommunityNavigationHandlers(
  store: CommunityNavigationStore,
): Readonly<Record<"ListPopularCommunities" | "ListMyModerationCommunities", EndpointHandler>> {
  return {
    ListPopularCommunities: (request) =>
      Effect.runPromise(listPopularCommunities(request.query as { limit?: string }, store)),
    ListMyModerationCommunities: (request) => {
      const principal = request.principal;
      if (principal === null || (principal.kind !== "user" && principal.kind !== "admin"))
        throw new AuthError({ message: "Authentication required" });
      return Effect.runPromise(
        listMyModerationCommunities(principal.subject, request.query as { cursor?: string }, store),
      );
    },
  };
}
