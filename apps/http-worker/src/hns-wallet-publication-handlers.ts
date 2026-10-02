import {
  HnsWalletPublicationRejected,
  type HnsWalletPublicationStore,
} from "@pirate/application/namespace-ownership";
import {
  AuthError,
  BadRequest,
  Conflict,
  type HnsWalletPublicationCommandV1,
  InternalError,
  NotFound,
} from "@pirate/contracts";
import { Effect } from "effect";
import { type EndpointHandler, withEndpointResult } from "./transport.ts";

function wireFailure(error: unknown): Error {
  if (!(error instanceof HnsWalletPublicationRejected)) {
    return new InternalError({
      message: "Could not read or update publication status",
      cause: error,
    });
  }
  if (error.reason === "not_found")
    return new NotFound({ message: "Publication authority was not found" });
  if (error.reason === "invalid_command")
    return new BadRequest({ message: "Invalid publication command" });
  return new Conflict({
    message: "Publication requires reconciliation before another send",
    details: { reason: error.reason },
  });
}

export function makeHnsWalletPublicationHandlers(store: HnsWalletPublicationStore): Readonly<{
  GetHnsWalletPublication: EndpointHandler;
  CommandHnsWalletPublication: EndpointHandler;
}> {
  const identity = (request: Parameters<EndpointHandler>[0]) => {
    if (request.principal === null || !["user", "admin"].includes(request.principal.kind)) {
      throw new AuthError({ message: "Authentication required" });
    }
    const path = request.params as { communityId: string; sessionId: string };
    return {
      actor_id: request.principal.subject,
      community_id: path.communityId,
      root_import_session_id: path.sessionId,
    };
  };
  const response = <A>(operation: Effect.Effect<A, unknown>) =>
    Effect.runPromise(
      operation.pipe(
        Effect.map((result) => withEndpointResult(result, 200)),
        Effect.mapError(wireFailure),
      ),
    );
  return {
    GetHnsWalletPublication: (request) => response(store.read(identity(request))),
    CommandHnsWalletPublication: (request) =>
      response(
        store.command({
          ...identity(request),
          command: request.body as HnsWalletPublicationCommandV1,
        }),
      ),
  };
}
