import type { KaraokeResetSnapshot } from "./karaoke-reset-inspection.ts";
import {
  decodeKaraokeResetCommand,
  decodeKaraokeResetTarget,
  type KaraokeResetReceipt,
} from "./karaoke-reset-installation.ts";
import {
  admitKaraokeResetOperator,
  type KaraokeResetOperatorBindings,
} from "./karaoke-reset-operator-auth.ts";

export interface KaraokeResetCallerBindings extends KaraokeResetOperatorBindings {
  readonly KARAOKE_RESET_CALLER_ORIGIN?: string;
  readonly RESET_OPERATOR: {
    apply(assertion: string, command: unknown): Promise<KaraokeResetReceipt>;
    inspect(assertion: string, target: unknown): Promise<KaraokeResetSnapshot>;
  };
}

const response = (status: number, body: string | null = null) =>
  new Response(body, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });

async function readCommand(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (reader === undefined) throw new Error("missing_body");
  const bytes = new Uint8Array(2_048);
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (size + next.value.byteLength > bytes.byteLength) {
        await reader.cancel();
        throw new Error("oversized_body");
      }
      bytes.set(next.value, size);
      size += next.value.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
  } finally {
    reader.releaseLock();
  }
}

/** Separate operator Worker only; never mounted in the product HTTP router. */
export async function handleKaraokeResetCaller(
  request: Request,
  bindings: KaraokeResetCallerBindings,
): Promise<Response> {
  const url = new URL(request.url);
  const origin = bindings.KARAOKE_RESET_CALLER_ORIGIN;
  if (
    bindings.API_NEXT_ENV !== "staging" ||
    bindings.KARAOKE_RESET_ENABLED !== "true" ||
    origin === undefined ||
    url.protocol !== "https:" ||
    url.origin !== origin
  )
    return response(403);
  if ((url.pathname !== "/command" && url.pathname !== "/inspect") || url.search !== "")
    return response(404);
  if (request.method !== "POST") return response(405);
  if (
    request.headers.get("origin") !== origin ||
    request.headers.get("content-type") !== "application/json" ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    return response(403);
  const assertion = request.headers.get("cf-access-jwt-assertion");
  if (assertion === null || assertion.length > 16_384) return response(403);
  try {
    await admitKaraokeResetOperator(bindings, assertion);
  } catch {
    return response(403);
  }
  let command: unknown;
  try {
    const input = await readCommand(request);
    command =
      url.pathname === "/inspect"
        ? decodeKaraokeResetTarget(input)
        : decodeKaraokeResetCommand(input);
  } catch {
    return response(400);
  }
  try {
    // The named entrypoint and DO independently authenticate the same assertion.
    const receipt =
      url.pathname === "/inspect"
        ? await bindings.RESET_OPERATOR.inspect(assertion, command)
        : await bindings.RESET_OPERATOR.apply(assertion, command);
    return response(200, JSON.stringify(receipt));
  } catch {
    // No provider exception, token or request body may enter the response/logs.
    return response(502);
  }
}
