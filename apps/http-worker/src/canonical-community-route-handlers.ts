import {
  type GetCanonicalCommunityRouteInput,
  type GetCanonicalCommunityRouteServices,
  getCanonicalCommunityRoute,
} from "@pirate/application/use-cases/community/get-canonical-community-route";
import { Effect } from "effect";
import type { DecodedRequest, EndpointHandler } from "./transport.ts";

export type CanonicalCommunityRouteHandlers = Readonly<{
  readonly GetCanonicalCommunityRoute: EndpointHandler;
}>;

export function makeCanonicalCommunityRouteHandlers(
  services: GetCanonicalCommunityRouteServices,
): CanonicalCommunityRouteHandlers {
  return {
    GetCanonicalCommunityRoute: async (request: DecodedRequest) =>
      await Effect.runPromise(
        getCanonicalCommunityRoute(request.params as GetCanonicalCommunityRouteInput, services),
      ),
  };
}
