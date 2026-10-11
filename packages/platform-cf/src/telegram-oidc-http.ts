import { TelegramOidcRejected } from "@pirate/application/telegram-oidc";
import { telegramResponseBytes } from "./telegram-http.ts";

export type TelegramOidcFetch = (url: string, init: RequestInit) => Promise<Response>;

function transportDiagnostic(error: unknown): { name: string; message: string } {
  // Never log arbitrary messages: they may contain codes, credentials or bodies.
  if (error instanceof TypeError) {
    return {
      name: "TypeError",
      message: error.message.startsWith("Invalid redirect value")
        ? "Invalid redirect value; Workers supports follow or manual"
        : "Fetch TypeError; details redacted",
    };
  }
  if (error instanceof Error) {
    return {
      name: error.name === "AbortError" ? "AbortError" : "Error",
      message: "Fetch rejected; details redacted",
    };
  }
  return { name: "UnknownTransportError", message: "Non-error fetch rejection" };
}

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
    try {
      // Workers rejects `error`; manual returns 3xx for the non-OK check below.
      response = await fetcher(url, { ...init, redirect: "manual", signal: controller.signal });
    } catch (error) {
      console.error("telegram_oidc_transport_failure", transportDiagnostic(error));
      throw error;
    }
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
