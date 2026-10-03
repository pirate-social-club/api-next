import {
  claimVideoOutcome,
  type VideoOutcomeStore,
} from "@pirate/application/use-cases/video-outcomes";
import { AuthError } from "@pirate/contracts";
import { Effect } from "effect";
import type { EndpointHandler } from "./transport.ts";
import { withEndpointResult } from "./transport.ts";

export function makeVideoOutcomeHandlers(store: VideoOutcomeStore): Readonly<{
  ClaimVideoOutcome: EndpointHandler;
}> {
  return {
    ClaimVideoOutcome: async (request) => {
      if (request.principal?.kind !== "user") {
        throw new AuthError({ message: "Authentication required" });
      }
      return withEndpointResult(
        await Effect.runPromise(claimVideoOutcome(request.principal.subject, store), {
          signal: request.signal,
        }),
        200,
        { "cache-control": "private, no-store" },
      );
    },
  };
}
