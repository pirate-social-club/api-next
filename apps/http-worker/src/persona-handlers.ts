import {
  confirmPersonaEvmWallet,
  createPersona,
  listMyPersonas,
  type PersonaServices,
  type PersonaWalletServices,
  preparePersonaEvmWallet,
} from "@pirate/application/use-cases/personas";
import { AuthError } from "@pirate/contracts";
import { Effect } from "effect";
import type { DecodedRequest, EndpointHandler, Principal } from "./transport.ts";
import { withEndpointResult } from "./transport.ts";

export type PersonaHandlers = Readonly<{
  readonly ListMyPersonas: EndpointHandler;
  readonly CreatePersona: EndpointHandler;
  readonly PreparePersonaEvmWallet: EndpointHandler;
  readonly ConfirmPersonaEvmWallet: EndpointHandler;
}>;

export type PersonaHandlerServices = Readonly<{
  readonly personas: PersonaServices;
  readonly wallets: PersonaWalletServices;
}>;

function accountId(principal: Principal | null): string {
  if (principal === null || (principal.kind !== "user" && principal.kind !== "admin")) {
    throw new AuthError({ message: "Authentication required" });
  }
  return principal.subject;
}

function personaId(request: DecodedRequest): string {
  return (request.params as { readonly personaId: string }).personaId;
}

export function makePersonaHandlers(services: PersonaHandlerServices): PersonaHandlers {
  return {
    ListMyPersonas: async (request) =>
      await Effect.runPromise(
        listMyPersonas({ accountId: accountId(request.principal) }, services.personas),
      ),
    CreatePersona: async (request) => {
      const result = await Effect.runPromise(
        createPersona(
          {
            accountId: accountId(request.principal),
            body: request.body as Parameters<typeof createPersona>[0]["body"],
          },
          services.personas,
        ),
      );
      return withEndpointResult(result, 201);
    },
    PreparePersonaEvmWallet: async (request) =>
      await Effect.runPromise(
        preparePersonaEvmWallet(
          {
            accountId: accountId(request.principal),
            personaId: personaId(request),
            body: request.body as Parameters<typeof preparePersonaEvmWallet>[0]["body"],
          },
          services.wallets,
        ),
      ),
    ConfirmPersonaEvmWallet: async (request) =>
      await Effect.runPromise(
        confirmPersonaEvmWallet(
          {
            accountId: accountId(request.principal),
            personaId: personaId(request),
            body: request.body as Parameters<typeof confirmPersonaEvmWallet>[0]["body"],
          },
          services.wallets,
        ),
      ),
  };
}
