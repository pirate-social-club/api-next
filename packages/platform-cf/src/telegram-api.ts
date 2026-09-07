import {
  type TelegramApi,
  type TelegramDispatchOutcome,
  TelegramFailure,
} from "@pirate/application/telegram";
import { boundedTelegramText } from "@pirate/domain/telegram";
import { telegramObject, telegramResponseBytes } from "./telegram-http.ts";

export function makeTelegramApi(fetcher: typeof fetch): TelegramApi {
  async function request(
    token: string,
    method: string,
    payload: Record<string, unknown> | FormData,
  ) {
    if (!/^\d+:[A-Za-z0-9_-]+$/u.test(token) || !/^[A-Za-z]+$/u.test(method))
      throw new TelegramFailure({ reason: "invalid" });
    const response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(25_000),
      ...(payload instanceof FormData
        ? { body: payload }
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error("Telegram response unavailable");
    }
    return telegramObject(
      JSON.parse(new TextDecoder().decode(await telegramResponseBytes(response, 262_144))),
    );
  }
  const api: TelegramApi = {
    async call<T>(token: string, method: string, payload: Record<string, unknown>): Promise<T> {
      try {
        const result = await request(token, method, payload);
        if (result.ok !== true || result.result === undefined) throw new Error();
        return result.result as T;
      } catch {
        throw new TelegramFailure({ reason: "unavailable" });
      }
    },
    async dispatch(token, delivery, operation, audio): Promise<TelegramDispatchOutcome> {
      const message = delivery.desired;
      const payload: Record<string, unknown> = { chat_id: delivery.chatId };
      let method: string;
      if (operation === "delete") {
        method = "deleteMessage";
        payload.message_id = delivery.messageId;
      } else {
        if (!message) return { kind: "rejected", code: "missing_payload", retryAfter: null };
        if (message.buttons.length > 0)
          payload.reply_markup = { inline_keyboard: message.buttons.map((button) => [button]) };
        else if (message.keyboard !== undefined) payload.reply_markup = message.keyboard;
        if (message.replyTo !== undefined)
          payload.reply_parameters = {
            message_id: message.replyTo,
            allow_sending_without_reply: true,
          };
        if (operation === "edit") {
          payload.message_id = delivery.messageId;
          if (message.kind === "text") {
            method = "editMessageText";
            payload.text = message.text;
          } else {
            method = "editMessageMedia";
            payload.media = { type: message.kind, media: message.media, caption: message.text };
          }
          payload.reply_markup ??= { inline_keyboard: [] };
        } else {
          const methods = {
            text: "sendMessage",
            photo: "sendPhoto",
            video: "sendVideo",
            audio: "sendAudio",
            voice: "sendVoice",
          };
          method = methods[message.kind];
          if (message.kind === "text") payload.text = message.text;
          else {
            payload.caption = boundedTelegramText(message.text, true);
            payload[message.kind] = message.media;
          }
        }
      }
      let body: Record<string, unknown> | FormData = payload;
      if (audio) {
        const form = new FormData();
        for (const [key, value] of Object.entries(payload))
          if (key !== "voice")
            form.set(key, typeof value === "string" ? value : JSON.stringify(value));
        form.set("voice", new Blob([new Uint8Array(audio)], { type: "audio/mpeg" }), "reply.mp3");
        body = form;
      }
      try {
        const response = await request(token, method, body);
        if (response.ok === false && Number.isInteger(response.error_code)) {
          const parameters =
            response.parameters === undefined ? {} : telegramObject(response.parameters);
          const retryAfter =
            typeof parameters.retry_after === "number" &&
            Number.isSafeInteger(parameters.retry_after) &&
            parameters.retry_after > 0
              ? parameters.retry_after
              : null;
          if (
            operation === "edit" &&
            response.error_code === 400 &&
            typeof response.description === "string" &&
            response.description.includes("message is not modified")
          )
            return { kind: "confirmed", messageId: delivery.messageId };
          return { kind: "rejected", code: `telegram_${response.error_code}`, retryAfter };
        }
        if (response.ok !== true) throw new Error();
        if (operation === "delete" && response.result === true)
          return { kind: "confirmed", messageId: null };
        const result = telegramObject(response.result);
        if (!Number.isSafeInteger(result.message_id) || Number(result.message_id) <= 0)
          throw new Error();
        return { kind: "confirmed", messageId: Number(result.message_id) };
      } catch {
        // A timeout or malformed acknowledgement does not prove a send failed.
        return { kind: "uncertain", code: "acknowledgement_unavailable" };
      }
    },
    async downloadVoice(token, fileId) {
      const result = await api.call<{ file_path?: string; file_size?: number }>(token, "getFile", {
        file_id: fileId,
      });
      if (
        !result.file_path ||
        !/^[A-Za-z0-9_/-]+\.[A-Za-z0-9]+$/u.test(result.file_path) ||
        result.file_path.includes("..") ||
        (result.file_size !== undefined && result.file_size > 5_242_880)
      )
        throw new TelegramFailure({ reason: "invalid" });
      try {
        const response = await fetcher(
          `https://api.telegram.org/file/bot${token}/${result.file_path}`,
          { redirect: "manual", signal: AbortSignal.timeout(20_000) },
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error();
        }
        return await telegramResponseBytes(response, 5_242_880);
      } catch {
        throw new TelegramFailure({ reason: "unavailable" });
      }
    },
  };
  return api;
}
