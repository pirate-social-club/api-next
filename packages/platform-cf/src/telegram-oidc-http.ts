import { TelegramOidcRejected } from "@pirate/application/telegram-oidc";
import { telegramResponseBytes } from "./telegram-http.ts";

export type TelegramOidcFetch = (url: string, init: RequestInit) => Promise<Response>;

/** The deadline owns both fetch and streaming body consumption. */
export async function telegramOidcJson(
  fetcher: TelegramOidcFetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  timeoutMs: number,
  byteLimit: number,
): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  let response: Response | undefined;
  try {
    if (controller.signal.aborted) throw new Error();
    response = await fetcher(url, { ...init, redirect: "error", signal: controller.signal });
    if (
      !response.ok ||
      response.redirected ||
      response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/json"
    ) {
      throw new Error();
    }
    const bytes = await telegramResponseBytes(response, byteLimit);
    if (controller.signal.aborted) throw new Error();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new TelegramOidcRejected({ reason: "provider_unavailable" });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    if (response?.body && !response.body.locked) {
      try {
        await response.body.cancel();
      } catch {
        // Preserve the redacted failure when an aborted stream is already errored.
      }
    }
  }
}
