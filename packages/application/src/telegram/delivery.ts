import {
  boundedTelegramText,
  decideTelegramDelivery,
  type TelegramMessage,
} from "@pirate/domain/telegram";
import {
  type IncomingUpdate,
  type IntegrationRecord,
  type PublicTelegramPost,
  TelegramFailure,
  type TelegramServices,
} from "./types.ts";

export async function telegramBotCredentials(
  services: TelegramServices,
  record: IntegrationRecord,
): Promise<{ token: string; secret: string }> {
  if (!record.botToken) throw new TelegramFailure({ reason: "unavailable" });
  try {
    const value: unknown = JSON.parse(
      await services.vault.open(
        record.botToken,
        `${record.communityId}:telegram:${record.botEpoch}`,
      ),
    );
    if (
      !value ||
      typeof value !== "object" ||
      !("token" in value) ||
      !("secret" in value) ||
      typeof value.token !== "string" ||
      typeof value.secret !== "string"
    )
      throw new Error();
    return { token: value.token, secret: value.secret };
  } catch {
    throw new TelegramFailure({ reason: "unavailable" });
  }
}

export async function acceptTelegramUpdate(
  services: TelegramServices,
  webhookId: string,
  secret: string,
  update: IncomingUpdate,
) {
  const record = await services.store.byWebhook(webhookId);
  if (
    !record ||
    record.status === "disconnected" ||
    record.webhookSecret !== (await services.vault.hash(secret))
  )
    throw new TelegramFailure({ reason: "unauthorized" });
  const id = await services.store.acceptUpdate(record, update);
  // The scheduled scanner recovers a lost notification after durable acceptance.
  try {
    await services.wake({ kind: "inbox", id });
  } catch {
    /* Durable inbox owns recovery. */
  }
  return { ok: true as const };
}

export async function configureTelegramBots(services: TelegramServices) {
  for (const record of await services.store.configuredCandidates()) {
    try {
      const credentials = await telegramBotCredentials(services, record);
      const origin = new URL(services.webhookOrigin);
      if (origin.protocol !== "https:" || origin.username || origin.password || !record.webhookId)
        throw new Error();
      const result = await services.api.call<boolean>(credentials.token, "setWebhook", {
        url: new URL(`/telegram/bots/${encodeURIComponent(record.webhookId)}/updates`, origin).href,
        secret_token: credentials.secret,
        allowed_updates: ["message", "callback_query", "my_chat_member"],
        max_connections: 10,
      });
      if (result !== true) throw new Error();
      await services.store.configureResult(record.communityId, record.botEpoch, null);
    } catch {
      await services.store.configureResult(
        record.communityId,
        record.botEpoch,
        "webhook_configuration_failed",
      );
    }
  }
}

export function telegramPublication(post: PublicTelegramPost): TelegramMessage {
  const buttons = [{ text: "Open post", url: post.url }];
  if (post.studyUrl) buttons.push({ text: "Study song", url: post.studyUrl });
  if (post.karaokeUrl) buttons.push({ text: "Sing karaoke", url: post.karaokeUrl });
  const text = [post.title, post.body, post.rewardText].filter(Boolean).join("\n\n");
  return {
    kind: post.media?.kind ?? "text",
    media: post.media?.url ?? null,
    text: boundedTelegramText(text, post.media !== null),
    buttons,
  };
}

/** Called for new publications and existing copies, including withdrawals. */
export async function reconcileTelegramPublication(
  services: TelegramServices,
  communityId: string,
  postId: string,
) {
  const record = await services.store.integration(communityId);
  if (record.status !== "ready" || !record.channelId) return;
  const posts = await services.store.publicPosts(communityId, [postId]);
  const post = posts.find((candidate) => candidate.id === postId);
  const desired = post ? telegramPublication(post) : null;
  const id = await services.vault.hash(
    `publication:${communityId}:${record.botEpoch}:${record.channelId}:${postId}`,
  );
  await services.store.enqueueDelivery({
    id,
    communityId,
    botEpoch: record.botEpoch,
    chatId: record.channelId,
    kind: "publication",
    postId,
    state: "pending",
    desired,
    desiredHash: desired ? await services.vault.hash(JSON.stringify(desired)) : null,
  });
  try {
    await services.wake({ kind: "delivery", id });
  } catch {
    /* Durable delivery owns recovery. */
  }
}

export async function processTelegramDelivery(services: TelegramServices, id: string) {
  // Claim returns the pre-claim state together with its newly fenced attempt.
  const delivery = await services.store.claimDelivery(id);
  if (!delivery) return;
  const record = await services.store.integration(delivery.communityId);
  if (
    record.botEpoch !== delivery.botEpoch ||
    record.status !== "ready" ||
    (delivery.kind === "publication" && record.channelId !== delivery.chatId)
  ) {
    await services.store.holdDelivery(delivery, "integration_changed");
    return;
  }
  const decision = decideTelegramDelivery({
    state: delivery.state,
    messageId: delivery.messageId,
    desiredHash: delivery.desiredHash,
    confirmedHash: delivery.confirmedHash,
    desiredKind: delivery.desired?.kind ?? null,
    confirmedKind: delivery.confirmed?.kind ?? null,
  });
  if (decision === "review") {
    await services.store.holdDelivery(delivery, "operator_review_required");
    return;
  }
  if (decision === "cancel" || decision === "unchanged") {
    await services.store.finishDelivery(
      delivery,
      { kind: "confirmed", messageId: delivery.messageId },
      decision === "cancel" ? "delete" : "edit",
    );
    return;
  }
  // Refresh public eligibility immediately before dispatch, not only at enqueue time.
  if (delivery.kind === "publication" && delivery.postId && delivery.desired !== null) {
    const posts = await services.store.publicPosts(delivery.communityId, [delivery.postId]);
    const post = posts.find((candidate) => candidate.id === delivery.postId);
    if (
      !post ||
      (await services.vault.hash(JSON.stringify(telegramPublication(post)))) !==
        delivery.desiredHash
    ) {
      await services.store.holdDelivery(delivery, "publication_changed");
      await reconcileTelegramPublication(services, delivery.communityId, delivery.postId);
      return;
    }
  }
  let credentials: { token: string; secret: string };
  let audio: Uint8Array | undefined;
  try {
    credentials = await telegramBotCredentials(services, record);
    if (delivery.kind === "voice") {
      const credential = record.credentials.elevenlabs;
      if (!record.policy.voice_enabled || credential?.status !== "valid" || !delivery.desired)
        throw new Error();
      if (
        !(await services.store.reserveUsage(
          record.communityId,
          record.botEpoch,
          delivery.chatId,
          `speech:${delivery.id}:${delivery.attempt}`,
          record.policy,
          delivery.desired.text.length,
        ))
      ) {
        await services.store.finishDelivery(
          delivery,
          { kind: "rejected", code: "speech_budget_exhausted", retryAfter: null },
          decision,
        );
        return;
      }
      const key = await services.vault.open(
        credential.ciphertext,
        `${record.communityId}:elevenlabs`,
      );
      audio = await services.providers.synthesize(key, record.policy, delivery.desired.text);
    }
  } catch {
    await services.store.finishDelivery(
      delivery,
      { kind: "rejected", code: "preparation_failed", retryAfter: 60 },
      decision,
    );
    return;
  }
  const outcome = await services.api.dispatch(credentials.token, delivery, decision, audio);
  await services.store.finishDelivery(delivery, outcome, decision);
}
