import { GuestParticipationStoreRejected } from "@pirate/application/guest-participation-authority";
import { PERSONA_WALLET_SETUP_SESSION_SCOPE } from "@pirate/application/use-cases/identity-registration-handler";
import type { OwnerRewardCreditReadStore } from "@pirate/application/use-cases/owner-financial-study";
import {
  AuthError,
  BadRequest,
  GetMyOwnerRewardCreditV1,
  InternalError,
  ListMyOwnerRewardCreditsV1,
  NotFound,
  ProviderUnavailable,
} from "@pirate/contracts";
import { Effect, Schema } from "effect";
import type { EndpointHandler } from "./transport.ts";
/** Declarative Auth.user(browserSessionOnly) has already verified actual ordinary
 * token purpose before decoding. The existing composition denies setup scope outside its narrow setup/attachment routes; the handler also explicitly refuses it.
 * No fabricated BrowserParticipationContext/OrdinaryBrowserAccount/session digest. */
export function makeOwnerRewardCreditReadHandlers(store: OwnerRewardCreditReadStore): Readonly<{
  ListMyOwnerRewardCreditsV1: EndpointHandler;
  GetMyOwnerRewardCreditV1: EndpointHandler;
}> {
  const wire = (error: unknown) => {
    if (error instanceof GuestParticipationStoreRejected && error.reason === "not-found")
      return new NotFound({ message: "Reward credit is unavailable" });
    return new ProviderUnavailable({ message: "Reward credit reader is unavailable" });
  };
  const strict = <A>(schema: Schema.ConstraintDecoder<A>, value: unknown): A => {
    try {
      return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
    } catch {
      throw new BadRequest({ message: "Invalid reward credit request" });
    }
  };
  return {
    ListMyOwnerRewardCreditsV1: async (request) => {
      if (
        request.principal?.kind !== "user" ||
        request.principal.scopes?.includes(PERSONA_WALLET_SETUP_SESSION_SCOPE)
      )
        throw new AuthError({ message: "Authentication required" });
      const query = strict(ListMyOwnerRewardCreditsV1.request.query, request.query);
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
        return Schema.decodeUnknownSync(ListMyOwnerRewardCreditsV1.response, {
          onExcessProperty: "error",
        })(result);
      } catch {
        throw new InternalError({ message: "Reward credit projection is unavailable" });
      }
    },
    GetMyOwnerRewardCreditV1: async (request) => {
      if (
        request.principal?.kind !== "user" ||
        request.principal.scopes?.includes(PERSONA_WALLET_SETUP_SESSION_SCOPE)
      )
        throw new AuthError({ message: "Authentication required" });
      const params = strict(GetMyOwnerRewardCreditV1.request.path, request.params);
      const result = await Effect.runPromise(
        store
          .get({ accountId: request.principal.subject, creditId: params.creditId })
          .pipe(Effect.mapError(wire)),
      );
      try {
        return Schema.decodeUnknownSync(GetMyOwnerRewardCreditV1.response, {
          onExcessProperty: "error",
        })(result);
      } catch {
        throw new InternalError({ message: "Reward credit projection is unavailable" });
      }
    },
  };
}
