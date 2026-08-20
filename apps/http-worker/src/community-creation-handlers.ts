import {
  type CommunityCreationServices,
  createCommunityCreationIntent,
  getCommunityCreationIntent,
  updateCommunityCreationIntent,
} from "@pirate/application/use-cases/community/creation-intents";
import { AuthError } from "@pirate/contracts";
import { Effect } from "effect";
import type { DecodedRequest, EndpointHandler, Principal } from "./transport.ts";
import { withEndpointResult } from "./transport.ts";

export type CommunityCreationHandlers = Readonly<{
  readonly CreateCommunityCreationIntent: EndpointHandler;
  readonly GetCommunityCreationIntent: EndpointHandler;
  readonly UpdateCommunityCreationIntent: EndpointHandler;
}>;

type CommunityCreationActor = Parameters<typeof createCommunityCreationIntent>[0]["actor"];

function actor(principal: Principal | null): CommunityCreationActor {
  if (principal === null || (principal.kind !== "user" && principal.kind !== "admin")) {
    throw new AuthError({ message: "Authentication required" });
  }
  return {
    userId: principal.subject,
    kind: principal.kind,
    ...(principal.scopes === undefined ? {} : { scopes: principal.scopes }),
  };
}

function intentId(request: DecodedRequest): string {
  return (request.params as { readonly intentId: string }).intentId;
}

/**
 * Installs only draft lifecycle operations. Commit remains absent until the
 * evidence, policy, community, and subject-quota writes share one transaction.
 */
export function makeCommunityCreationHandlers(
  services: CommunityCreationServices,
): CommunityCreationHandlers {
  return {
    CreateCommunityCreationIntent: async (request) => {
      const result = await Effect.runPromise(
        createCommunityCreationIntent(
          { actor: actor(request.principal), body: request.body },
          services,
        ),
      );
      return withEndpointResult(result, 201);
    },
    GetCommunityCreationIntent: async (request) =>
      await Effect.runPromise(
        getCommunityCreationIntent(
          { actor: actor(request.principal), intentId: intentId(request) },
          services,
        ),
      ),
    UpdateCommunityCreationIntent: async (request) =>
      await Effect.runPromise(
        updateCommunityCreationIntent(
          {
            actor: actor(request.principal),
            intentId: intentId(request),
            body: request.body,
          },
          services,
        ),
      ),
  };
}
