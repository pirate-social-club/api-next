import type { TelegramChannelSetup } from "@pirate/contracts";
import { telegramBotCredentials } from "./delivery.ts";
import {
  integrationView,
  type SetupRecord,
  TelegramFailure,
  type TelegramServices,
} from "./types.ts";

function view(record: SetupRecord, deepLink: string | null = null): TelegramChannelSetup {
  return {
    id: record.id,
    state: record.state,
    deep_link: deepLink,
    channel_title: record.channelTitle,
    expires_at: record.expiresAt,
  };
}

export async function createTelegramSetup(
  services: TelegramServices,
  communityId: string,
  ownerId: string,
  revision: number,
  commandKey: string,
): Promise<TelegramChannelSetup> {
  await services.store.owner(communityId, ownerId);
  const integration = await services.store.integration(communityId);
  const id = await services.vault.hash(`setup:${communityId}:${ownerId}:${commandKey}`);
  const commandHash = await services.vault.hash(JSON.stringify({ revision }));
  const existing = await services.store.setup(communityId, id);
  if (existing) {
    if (existing.commandHash !== commandHash || existing.botEpoch !== integration.botEpoch)
      throw new TelegramFailure({ reason: "conflict" });
    const token = await services.vault.open(existing.tokenCiphertext, `setup:${id}`);
    return view(
      existing,
      existing.state === "pending"
        ? `https://t.me/${integration.botUsername}?start=${token}`
        : null,
    );
  }
  if (integration.revision !== revision) throw new TelegramFailure({ reason: "conflict" });
  if (integration.status !== "ready" || !integration.botUsername)
    throw new TelegramFailure({ reason: "invalid" });
  const token = services.vault.token();
  const record: SetupRecord = {
    tokenCiphertext: await services.vault.seal(token, `setup:${id}`),
    commandHash,
    id,
    communityId,
    ownerId,
    botEpoch: integration.botEpoch,
    tokenHash: await services.vault.hash(token),
    requestId: (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) & 0x7fffffff,
    telegramUserId: null,
    privateChatId: null,
    channelId: null,
    channelTitle: null,
    channelUsername: null,
    state: "pending",
    expiresAt: new Date(services.now() + 10 * 60_000).toISOString(),
  };
  await services.store.createSetup(record);
  return createTelegramSetup(services, communityId, ownerId, revision, commandKey);
}

export async function getTelegramSetup(
  services: TelegramServices,
  communityId: string,
  ownerId: string,
  setupId: string,
) {
  await services.store.owner(communityId, ownerId);
  const record = await services.store.setup(communityId, setupId);
  if (!record || record.ownerId !== ownerId) throw new TelegramFailure({ reason: "not_found" });
  const integration = await services.store.integration(communityId);
  if (record.botEpoch !== integration.botEpoch) return view({ ...record, state: "expired" });
  const token =
    record.state === "pending"
      ? await services.vault.open(record.tokenCiphertext, `setup:${record.id}`)
      : null;
  return view(record, token ? `https://t.me/${integration.botUsername}?start=${token}` : null);
}

export async function verifyTelegramChannel(
  services: TelegramServices,
  communityId: string,
  channelId: string,
  userId: string,
) {
  const integration = await services.store.integration(communityId);
  const { token } = await telegramBotCredentials(services, integration);
  const [chat, user, bot] = await Promise.all([
    services.api.call<{ type: string; title?: string; username?: string }>(token, "getChat", {
      chat_id: channelId,
    }),
    services.api.call<{ status: string }>(token, "getChatMember", {
      chat_id: channelId,
      user_id: userId,
    }),
    services.api.call<{
      status: string;
      can_post_messages?: boolean;
      can_edit_messages?: boolean;
      can_delete_messages?: boolean;
    }>(token, "getChatMember", { chat_id: channelId, user_id: integration.botId }),
  ]);
  if (
    chat.type !== "channel" ||
    !chat.title ||
    !["creator", "administrator"].includes(user.status) ||
    bot.status !== "administrator" ||
    !bot.can_post_messages ||
    !bot.can_edit_messages ||
    !bot.can_delete_messages
  )
    throw new TelegramFailure({ reason: "invalid" });
  return { title: chat.title, username: chat.username ?? null };
}

export async function confirmTelegramSetup(
  services: TelegramServices,
  communityId: string,
  ownerId: string,
  setupId: string,
  revision: number,
) {
  await services.store.owner(communityId, ownerId);
  const record = await services.store.setup(communityId, setupId);
  if (!record || record.ownerId !== ownerId || !record.channelId || !record.telegramUserId)
    throw new TelegramFailure({ reason: "not_found" });
  await verifyTelegramChannel(services, communityId, record.channelId, record.telegramUserId);
  return integrationView(
    await services.store.confirmSetup(communityId, ownerId, setupId, revision),
  );
}
