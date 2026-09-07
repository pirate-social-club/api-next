import {
  acceptTelegramUpdate,
  confirmTelegramSetup,
  connectTelegram,
  createTelegramSetup,
  disconnectTelegram,
  getTelegramSettings,
  getTelegramSetup,
  listAssistantOptions,
  reconcileTelegramPublication,
  setAssistantCredential,
  TelegramFailure,
  type TelegramServices,
  updateTelegramSettings,
} from "@pirate/application/telegram";
import {
  AuthError,
  BadRequest,
  type CommunityAssistantPolicy,
  Conflict,
  InternalError,
  NotFound,
  ProviderUnavailable,
  RateLimited,
} from "@pirate/contracts";
import type { DecodedRequest, EndpointHandler } from "./transport.ts";

function account(request: DecodedRequest) {
  if (request.principal?.kind !== "user")
    throw new AuthError({ message: "Authentication required" });
  return request.principal.subject;
}
function path(request: DecodedRequest) {
  return request.params as {
    communityId: string;
    setupId: string;
    deliveryId: string;
    webhookId: string;
  };
}
function command(request: DecodedRequest) {
  const body = request.body as { expected_revision: number; idempotency_key: string };
  return {
    ...path(request),
    accountId: account(request),
    expected_revision: body.expected_revision,
    idempotency_key: body.idempotency_key,
  };
}
function guarded(handler: EndpointHandler): EndpointHandler {
  return async (request) => {
    try {
      return await handler(request);
    } catch (error) {
      if (error instanceof AuthError) throw error;
      if (!(error instanceof TelegramFailure))
        throw new InternalError({ message: "Telegram operation unavailable" });
      const message = "Community bot operation could not be completed";
      switch (error.reason) {
        case "unauthorized":
          throw new AuthError({ message });
        case "not_found":
          throw new NotFound({ message });
        case "conflict":
          throw new Conflict({ message });
        case "invalid":
          throw new BadRequest({ message });
        case "rate_limited":
          throw new RateLimited({ message });
        case "unavailable":
          throw new ProviderUnavailable({ message });
      }
    }
  };
}

export function makeTelegramHandlers(
  services: TelegramServices | null,
): Readonly<Record<string, EndpointHandler>> {
  const required = () => {
    if (!services) throw new TelegramFailure({ reason: "unavailable" });
    return services;
  };
  const handlers: Record<string, EndpointHandler> = {
    GetCommunityTelegram: (request) =>
      getTelegramSettings(required(), path(request).communityId, account(request)),
    ConnectCommunityTelegram: (request) =>
      connectTelegram(required(), {
        ...command(request),
        token: (request.body as { token: string }).token,
      }),
    DisconnectCommunityTelegram: (request) => disconnectTelegram(required(), command(request)),
    UpdateCommunityTelegram: (request) =>
      updateTelegramSettings(required(), {
        ...command(request),
        automatic_publishing: (request.body as { automatic_publishing: boolean })
          .automatic_publishing,
        assistant: (request.body as { assistant: CommunityAssistantPolicy }).assistant,
      }),
    SetCommunityAssistantCredential: (request) =>
      setAssistantCredential(required(), {
        ...command(request),
        provider: (request.body as { provider: "openrouter" | "elevenlabs" }).provider,
        key: (request.body as { key: string }).key,
      }),
    ListCommunityAssistantModels: (request) =>
      listAssistantOptions(required(), path(request).communityId, account(request), "openrouter"),
    ListCommunityAssistantVoices: (request) =>
      listAssistantOptions(required(), path(request).communityId, account(request), "elevenlabs"),
    CreateTelegramChannelSetup: (request) => {
      const input = command(request);
      return createTelegramSetup(
        required(),
        input.communityId,
        input.accountId,
        input.expected_revision,
        input.idempotency_key,
      );
    },
    GetTelegramChannelSetup: (request) =>
      getTelegramSetup(
        required(),
        path(request).communityId,
        account(request),
        path(request).setupId,
      ),
    ConfirmTelegramChannelSetup: (request) => {
      const input = command(request);
      return confirmTelegramSetup(
        required(),
        input.communityId,
        input.accountId,
        input.setupId,
        input.expected_revision,
      );
    },
    ListCommunityTelegramDeliveries: async (request) => {
      const service = required();
      await service.store.owner(path(request).communityId, account(request));
      return service.store.listDeliveries(
        path(request).communityId,
        (request.query as { before?: string } | undefined)?.before,
      );
    },
    PublishCommunityTelegramPosts: async (request) => {
      const service = required();
      const input = command(request);
      await service.store.owner(input.communityId, input.accountId);
      const integration = await service.store.integration(input.communityId);
      if (integration.revision !== input.expected_revision)
        throw new TelegramFailure({ reason: "conflict" });
      if (integration.status !== "ready" || !integration.channelId)
        throw new TelegramFailure({ reason: "invalid" });
      const ids = (request.body as { post_ids: readonly string[] }).post_ids;
      const posts = await service.store.publicPosts(input.communityId, ids);
      for (const post of posts)
        await reconcileTelegramPublication(service, input.communityId, post.id);
      return { queued: posts.length };
    },
    ResolveCommunityTelegramDelivery: async (request) => {
      const service = required();
      const input = command(request);
      await service.store.owner(input.communityId, input.accountId);
      if ((await service.store.integration(input.communityId)).revision !== input.expected_revision)
        throw new TelegramFailure({ reason: "conflict" });
      const body = request.body as {
        resolution: "confirmed" | "not_sent" | "cancel";
        message_id?: number;
      };
      return service.store.resolveDelivery(
        input.communityId,
        input.deliveryId,
        body.resolution,
        {
          ownerId: input.accountId,
          revision: input.expected_revision,
          key: input.idempotency_key,
          hash: await service.vault.hash(
            JSON.stringify({ operation: "resolve", id: input.deliveryId, ...body }),
          ),
        },
        body.message_id,
      );
    },
    ReceiveTelegramUpdate: (request) =>
      acceptTelegramUpdate(
        required(),
        path(request).webhookId,
        (request.headers as Record<string, string>)["x-telegram-bot-api-secret-token"] ?? "",
        request.body as Parameters<typeof acceptTelegramUpdate>[3],
      ),
  };
  return Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => [name, guarded(handler)]),
  );
}
