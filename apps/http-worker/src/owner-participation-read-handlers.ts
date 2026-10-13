import { GuestParticipationStoreRejected } from "@pirate/application/guest-participation-authority";
import { PERSONA_WALLET_SETUP_SESSION_SCOPE } from "@pirate/application/use-cases/identity-registration-handler";
import type { OwnerParticipationReadStore } from "@pirate/application/use-cases/owner-financial-study";
import {
  AuthError,
  BadRequest,
  GetMyOwnerParticipationV1,
  InternalError,
  ListMyOwnerParticipationsV1,
  NotFound,
  ProviderUnavailable,
} from "@pirate/contracts";
import { Effect, Schema } from "effect";
import type { EndpointHandler } from "./transport.ts";
export function makeOwnerParticipationReadHandlers(store: OwnerParticipationReadStore): Readonly<{
  ListMyOwnerParticipationsV1: EndpointHandler;
  GetMyOwnerParticipationV1: EndpointHandler;
}> {
  const wire = (error: unknown) =>
    error instanceof GuestParticipationStoreRejected && error.reason === "not-found"
      ? new NotFound({ message: "Participation is unavailable" })
      : new ProviderUnavailable({ message: "Participation reader is unavailable" });
  const strict = <A>(schema: Schema.ConstraintDecoder<A>, input: unknown): A => {
    try {
      return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(input);
    } catch {
      throw new BadRequest({ message: "Invalid participation request" });
    }
  };
  return {
    ListMyOwnerParticipationsV1: async (request) => {
      if (
        request.principal?.kind !== "user" ||
        request.principal.scopes?.includes(PERSONA_WALLET_SETUP_SESSION_SCOPE)
      )
        throw new AuthError({ message: "Authentication required" });
      const query = strict(ListMyOwnerParticipationsV1.request.query, request.query);
      const result = await Effect.runPromise(
        store
          .list({
            accountId: request.principal.subject,
            cursor: query.cursor ?? null,
            limit: query.limit === undefined ? 25 : Number(query.limit),
          })
          .pipe(Effect.mapError(wire)),
      );
      try {
        return Schema.decodeUnknownSync(ListMyOwnerParticipationsV1.response, {
          onExcessProperty: "error",
        })(result);
      } catch {
        throw new InternalError({ message: "Participation projection is unavailable" });
      }
    },
    GetMyOwnerParticipationV1: async (request) => {
      if (
        request.principal?.kind !== "user" ||
        request.principal.scopes?.includes(PERSONA_WALLET_SETUP_SESSION_SCOPE)
      )
        throw new AuthError({ message: "Authentication required" });
      const path = strict(GetMyOwnerParticipationV1.request.path, request.params);
      const result = await Effect.runPromise(
        store
          .get({ accountId: request.principal.subject, participationId: path.participationId })
          .pipe(Effect.mapError(wire)),
      );
      try {
        return Schema.decodeUnknownSync(GetMyOwnerParticipationV1.response, {
          onExcessProperty: "error",
        })(result);
      } catch {
        throw new InternalError({ message: "Participation projection is unavailable" });
      }
    },
  };
}
