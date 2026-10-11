import { TelegramFailure } from "@pirate/application/telegram";
import {
  startTelegramLink,
  type TelegramLinkBrowser,
  type TelegramLinkServices,
  verifyTelegramLink,
  verifyTelegramLinkCallback,
} from "@pirate/application/telegram-linking";
import { TelegramOidcRejected } from "@pirate/application/telegram-oidc";
import {
  AuthError,
  BadRequest,
  Conflict,
  InternalError,
  NotFound,
  ProviderUnavailable,
  RateLimited,
  TELEGRAM_IDENTITY_LINK_CONFLICT_REASON,
} from "@pirate/contracts";
import { type DecodedRequest, type EndpointHandler, withEndpointResult } from "./transport.ts";

const TELEGRAM_LINK_COOKIE = "__Host-pirate_telegram_link";
const noStore = { "cache-control": "private, no-store", "referrer-policy": "no-referrer" };
function browser(request: DecodedRequest, bindingHash: string): TelegramLinkBrowser {
  if (request.principal?.kind !== "user" || !request.telegramLinkBrowser)
    throw new AuthError({ message: "Browser session required" });
  return {
    accountId: request.principal.subject,
    sessionHash: request.telegramLinkBrowser.sessionHash,
    browserHash: bindingHash,
  };
}
function guarded(handler: EndpointHandler): EndpointHandler {
  return async (request) => {
    try {
      return await handler(request);
    } catch (error) {
      const message = "Telegram linking could not be completed";
      if (error instanceof AuthError || error instanceof ProviderUnavailable) throw error;
      if (error instanceof TelegramOidcRejected) {
        if (error.reason === "provider_unavailable") throw new ProviderUnavailable({ message });
        throw new BadRequest({ message });
      }
      if (error instanceof TelegramFailure) {
        switch (error.reason) {
          case "unauthorized":
            throw new AuthError({ message });
          case "not_found":
            throw new NotFound({ message });
          case "identity_conflict":
            throw new Conflict({
              message:
                "This Telegram identity is linked to another Pirate account. Unlink it there before linking here.",
              details: { reason: TELEGRAM_IDENTITY_LINK_CONFLICT_REASON },
            });
          case "conflict":
            throw new Conflict({ message });
          case "invalid":
            throw new BadRequest({ message });
          case "unavailable":
            throw new ProviderUnavailable({ message });
          case "rate_limited":
            throw new RateLimited({ message });
        }
      }
      throw new InternalError({ message });
    }
  };
}
export function makeTelegramLinkingHandlers(
  services: TelegramLinkServices | null,
): Readonly<Record<string, EndpointHandler>> {
  const required = () => {
    if (!services) throw new ProviderUnavailable({ message: "Telegram linking unavailable" });
    return services;
  };
  const bound = async (request: DecodedRequest) => {
    const binding = request.telegramLinkBrowser?.binding;
    if (!binding) throw new AuthError({ message: "Link browser required" });
    return browser(request, await required().vault.hash(binding));
  };
  const id = (request: DecodedRequest) =>
    (request.params as { transactionId: string }).transactionId;
  const handlers: Record<string, EndpointHandler> = {
    GetMyTelegramLinks: async (request) =>
      withEndpointResult(await required().store.list(browser(request, "").accountId), 200, noStore),
    StartTelegramLink: async (request) => {
      const service = required();
      const binding = request.telegramLinkBrowser?.binding ?? service.vault.token();
      const result = await startTelegramLink(
        service,
        browser(request, await service.vault.hash(binding)),
        (request.body as { navigation_reference: string }).navigation_reference,
        request.signal,
      );
      return withEndpointResult(result, 200, {
        ...noStore,
        "set-cookie": `${TELEGRAM_LINK_COOKIE}=${binding}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=900`,
      });
    },
    GetTelegramLink: async (request) =>
      withEndpointResult(
        await required().store.get(id(request), await bound(request)),
        200,
        noStore,
      ),
    VerifyTelegramLink: async (request) => {
      const input = request.body as { state: string; code: string };
      return withEndpointResult(
        await verifyTelegramLink(
          required(),
          await bound(request),
          id(request),
          input.state,
          input.code,
          request.signal,
        ),
        200,
        noStore,
      );
    },
    VerifyTelegramLinkCallback: async (request) => {
      const input = request.body as { state: string; code: string };
      return withEndpointResult(
        await verifyTelegramLinkCallback(
          required(),
          await bound(request),
          input.state,
          input.code,
          request.signal,
        ),
        200,
        noStore,
      );
    },
    ConfirmTelegramLink: async (request) =>
      withEndpointResult(
        await required().store.confirm(
          id(request),
          await bound(request),
          (request.body as { persona_id: string }).persona_id,
        ),
        200,
        noStore,
      ),
    RevokeTelegramLinkGrant: async (request) => {
      const input = request.body as { community_id: string; bot_id: string };
      // Revocation requires the authenticated browser, not an earlier link-cookie.
      await required().store.revoke(browser(request, ""), input.community_id, input.bot_id);
      return withEndpointResult({ revoked: true }, 200, noStore);
    },
    UnlinkTelegramAccount: async (request) => {
      await required().store.unlink(
        browser(request, ""),
        (request.body as { telegram_user_id: string }).telegram_user_id,
      );
      return withEndpointResult({ unlinked: true }, 200, noStore);
    },
  };
  return Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => [name, guarded(handler)]),
  );
}
