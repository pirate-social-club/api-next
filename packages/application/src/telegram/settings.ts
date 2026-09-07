import type { CommunityAssistantPolicy } from "@pirate/contracts";
import {
  type IntegrationRecord,
  integrationView,
  type Provider,
  TelegramFailure,
  type TelegramServices,
} from "./types.ts";

type Command = {
  communityId: string;
  accountId: string;
  expected_revision: number;
  idempotency_key: string;
};

/** Authorization precedes both replay lookup and provider access. */
async function prepare(services: TelegramServices, command: Command, payload: unknown) {
  await services.store.owner(command.communityId, command.accountId);
  const hash = await services.vault.hash(JSON.stringify(payload));
  const replay = await services.store.commandReplay(
    command.communityId,
    command.idempotency_key,
    hash,
  );
  const record = await services.store.integration(command.communityId);
  if (replay !== null) return { record, hash, replay: true };
  if (record.revision !== command.expected_revision)
    throw new TelegramFailure({ reason: "conflict" });
  return { record, hash, replay: false };
}

async function save(
  services: TelegramServices,
  command: Command,
  record: IntegrationRecord,
  hash: string,
) {
  return integrationView(
    await services.store.saveIntegration(
      record,
      command.expected_revision,
      command.idempotency_key,
      hash,
      command.accountId,
    ),
  );
}

export async function getTelegramSettings(
  services: TelegramServices,
  communityId: string,
  accountId: string,
) {
  await services.store.owner(communityId, accountId);
  return integrationView(await services.store.integration(communityId));
}

export async function connectTelegram(
  services: TelegramServices,
  command: Command & { token: string },
) {
  const prepared = await prepare(services, command, { operation: "connect", token: command.token });
  if (prepared.replay) return integrationView(prepared.record);
  const bot = await services.api.call<{ id: number; is_bot: boolean; username?: string }>(
    command.token,
    "getMe",
    {},
  );
  if (
    !bot.is_bot ||
    !Number.isSafeInteger(bot.id) ||
    !bot.username ||
    !/^[A-Za-z0-9_]+$/u.test(bot.username)
  )
    throw new TelegramFailure({ reason: "invalid" });
  const epoch = services.vault.token();
  const secret = services.vault.token();
  const record: IntegrationRecord = {
    ...prepared.record,
    botEpoch: epoch,
    botId: String(bot.id),
    botUsername: bot.username,
    botToken: await services.vault.seal(
      JSON.stringify({ token: command.token, secret }),
      `${command.communityId}:telegram:${epoch}`,
    ),
    webhookId: services.vault.token(),
    webhookSecret: await services.vault.hash(secret),
    status: "configuring",
    channelId: null,
    channelTitle: null,
    channelUsername: null,
    automaticSince: null,
    lastError: null,
  };
  return save(services, command, record, prepared.hash);
}

export async function setAssistantCredential(
  services: TelegramServices,
  command: Command & { provider: Provider; key: string },
) {
  const prepared = await prepare(services, command, {
    operation: "credential",
    provider: command.provider,
    key: command.key,
  });
  if (prepared.replay) return integrationView(prepared.record);
  await services.providers.validate(command.provider, command.key);
  const ciphertext = await services.vault.seal(
    command.key,
    `${command.communityId}:${command.provider}`,
  );
  return save(
    services,
    command,
    {
      ...prepared.record,
      credentials: {
        ...prepared.record.credentials,
        [command.provider]: {
          ciphertext,
          status: "valid",
          checkedAt: new Date(services.now()).toISOString(),
        },
      },
    },
    prepared.hash,
  );
}

export async function updateTelegramSettings(
  services: TelegramServices,
  command: Command & { automatic_publishing: boolean; assistant: CommunityAssistantPolicy },
) {
  const prepared = await prepare(services, command, {
    operation: "settings",
    automatic_publishing: command.automatic_publishing,
    assistant: command.assistant,
  });
  if (prepared.replay) return integrationView(prepared.record);
  const policy = command.assistant;
  if (
    policy.enabled &&
    (!policy.model.trim() || prepared.record.credentials.openrouter?.status !== "valid")
  )
    throw new TelegramFailure({ reason: "invalid" });
  if (
    policy.voice_enabled &&
    (!policy.voice_id.trim() ||
      !policy.voice_model.trim() ||
      prepared.record.credentials.elevenlabs?.status !== "valid")
  )
    throw new TelegramFailure({ reason: "invalid" });
  if (policy.user_daily_messages > policy.community_daily_messages)
    throw new TelegramFailure({ reason: "invalid" });
  if (
    command.automatic_publishing &&
    (prepared.record.status !== "ready" || prepared.record.channelId === null)
  )
    throw new TelegramFailure({ reason: "invalid" });
  return save(
    services,
    command,
    {
      ...prepared.record,
      policy,
      automaticSince: command.automatic_publishing
        ? (prepared.record.automaticSince ?? new Date(services.now()).toISOString())
        : null,
    },
    prepared.hash,
  );
}

export async function disconnectTelegram(services: TelegramServices, command: Command) {
  const prepared = await prepare(services, command, { operation: "disconnect" });
  if (prepared.replay) return integrationView(prepared.record);
  return save(
    services,
    command,
    {
      ...prepared.record,
      botEpoch: services.vault.token(),
      botId: null,
      botUsername: null,
      botToken: null,
      webhookId: null,
      webhookSecret: null,
      status: "disconnected",
      channelId: null,
      channelTitle: null,
      channelUsername: null,
      automaticSince: null,
      lastError: null,
    },
    prepared.hash,
  );
}

export async function listAssistantOptions(
  services: TelegramServices,
  communityId: string,
  accountId: string,
  provider: Provider,
) {
  await services.store.owner(communityId, accountId);
  const record = await services.store.integration(communityId);
  const credential = record.credentials[provider];
  if (credential?.status !== "valid") throw new TelegramFailure({ reason: "invalid" });
  const key = await services.vault.open(credential.ciphertext, `${communityId}:${provider}`);
  return {
    items: await (provider === "openrouter"
      ? services.providers.models(key)
      : services.providers.voices(key)),
  };
}
