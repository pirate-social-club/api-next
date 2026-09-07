import {
  type AssistantProviders,
  type Provider,
  TelegramFailure,
} from "@pirate/application/telegram";
import { telegramObject, telegramResponseBytes } from "./telegram-http.ts";

export function makeTelegramAssistantProviders(fetcher: typeof fetch): AssistantProviders {
  async function request(
    provider: Provider,
    key: string,
    path: string,
    body?: unknown,
    audio = false,
  ) {
    try {
      const headers: Record<string, string> =
        provider === "openrouter" ? { Authorization: `Bearer ${key}` } : { "xi-api-key": key };
      if (body !== undefined && !(body instanceof FormData))
        headers["Content-Type"] = "application/json";
      const origin =
        provider === "openrouter" ? "https://openrouter.ai/api/v1" : "https://api.elevenlabs.io";
      const response = await fetcher(`${origin}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(45_000),
        ...(body === undefined
          ? {}
          : { body: body instanceof FormData ? body : JSON.stringify(body) }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new TelegramFailure({
          reason:
            response.status === 401 || response.status === 403
              ? "invalid"
              : response.status === 429
                ? "rate_limited"
                : "unavailable",
        });
      }
      return await telegramResponseBytes(response, audio ? 5_242_880 : 2_097_152);
    } catch (error) {
      if (error instanceof TelegramFailure) throw error;
      throw new TelegramFailure({ reason: "unavailable" });
    }
  }
  async function json(provider: Provider, key: string, path: string, body?: unknown) {
    const bytes = await request(provider, key, path, body);
    try {
      return telegramObject(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
      throw new TelegramFailure({ reason: "unavailable" });
    }
  }
  function options(value: unknown, field: string) {
    if (!Array.isArray(value) || value.length > 5000)
      throw new TelegramFailure({ reason: "unavailable" });
    return value.map((item) => {
      const entry = telegramObject(item);
      if (typeof entry[field] !== "string" || typeof entry.name !== "string")
        throw new TelegramFailure({ reason: "unavailable" });
      return { id: entry[field], name: entry.name };
    });
  }
  return {
    async validate(provider, key) {
      const result = await json(provider, key, provider === "openrouter" ? "/key" : "/v1/user");
      if (provider === "openrouter") {
        const data = telegramObject(result.data);
        if (data.is_management_key === true || data.is_provisioning_key === true)
          throw new TelegramFailure({ reason: "invalid" });
      } else if (typeof result.user_id !== "string")
        throw new TelegramFailure({ reason: "unavailable" });
    },
    async models(key) {
      return options((await json("openrouter", key, "/models")).data, "id");
    },
    async voices(key) {
      return options(
        (await json("elevenlabs", key, "/v2/voices?page_size=100")).voices,
        "voice_id",
      );
    },
    async complete(key, model, messages) {
      const result = await json("openrouter", key, "/chat/completions", {
        model,
        messages,
        max_tokens: 800,
        stream: false,
      });
      if (!Array.isArray(result.choices) || result.choices.length === 0)
        throw new TelegramFailure({ reason: "unavailable" });
      const message = telegramObject(telegramObject(result.choices[0]).message);
      if (typeof message.content !== "string" || !message.content.trim())
        throw new TelegramFailure({ reason: "unavailable" });
      return message.content.slice(0, 4000);
    },
    async transcribe(key, bytes) {
      if (bytes.byteLength > 5_242_880) throw new TelegramFailure({ reason: "invalid" });
      const body = new FormData();
      body.set("file", new Blob([new Uint8Array(bytes)], { type: "audio/ogg" }), "input.ogg");
      body.set("model_id", "scribe_v2");
      body.set("tag_audio_events", "false");
      const result = await json("elevenlabs", key, "/v1/speech-to-text", body);
      if (typeof result.text !== "string" || !result.text.trim() || result.text.length > 4000)
        throw new TelegramFailure({ reason: "invalid" });
      return result.text;
    },
    async synthesize(key, policy, text) {
      if (!policy.voice_enabled || !policy.voice_id || text.length > 4000)
        throw new TelegramFailure({ reason: "invalid" });
      return request(
        "elevenlabs",
        key,
        `/v1/text-to-speech/${encodeURIComponent(policy.voice_id)}?output_format=mp3_44100_128`,
        { text, model_id: policy.voice_model },
        true,
      );
    },
  };
}
