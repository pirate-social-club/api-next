import {
  acceptDanceAttemptCallback,
  DANCE_ATTEMPT_CALLBACK_KEY_VERSION_HEADER,
  DANCE_ATTEMPT_CALLBACK_SIGNATURE_HEADER,
  DANCE_ATTEMPT_CALLBACK_TIMESTAMP_HEADER,
  type DanceAttemptCallbackAuthenticator,
  type DanceAttemptCallbackClaimStore,
} from "@pirate/application/dance/attempt-callback";
import type { DanceAttemptProcessingStore } from "@pirate/application/dance/attempt-processing";
import { Effect } from "effect";

const MAX_CALLBACK_BODY_BYTES = 65_536;

async function readBoundedBody(request: Request): Promise<Uint8Array | null> {
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > MAX_CALLBACK_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

function response(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

/**
 * Provider-neutral callback boundary. It is deliberately not exported from a
 * Worker entrypoint and has no production route or secret binding.
 */
export function makeDanceAttemptCallbackHandler(dependencies: {
  readonly authenticator: DanceAttemptCallbackAuthenticator;
  readonly store: DanceAttemptProcessingStore & DanceAttemptCallbackClaimStore;
}) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return response({ outcome: "method_not_allowed" }, 405);
    if (request.headers.get("content-type") !== "application/json") {
      return response({ outcome: "invalid_request" }, 400);
    }
    const keyVersion = request.headers.get(DANCE_ATTEMPT_CALLBACK_KEY_VERSION_HEADER);
    const timestamp = request.headers.get(DANCE_ATTEMPT_CALLBACK_TIMESTAMP_HEADER);
    const signature = request.headers.get(DANCE_ATTEMPT_CALLBACK_SIGNATURE_HEADER);
    if (keyVersion === null || timestamp === null || signature === null) {
      return response({ outcome: "authentication_rejected" }, 401);
    }
    const rawBody = await readBoundedBody(request);
    if (rawBody === null) return response({ outcome: "invalid_request" }, 413);
    const disposition = await Effect.runPromise(
      acceptDanceAttemptCallback({ keyVersion, timestamp, signature, rawBody }, dependencies),
    );
    if (disposition.kind === "committed") return response({ outcome: "committed" }, 202);
    if (disposition.kind === "replayed") return response({ outcome: "replayed" }, 200);
    if (disposition.kind === "conflict") return response({ outcome: "conflict" }, 409);
    if (disposition.kind !== "rejected") return response({ outcome: "invalid_request" }, 500);
    if (disposition.reason === "authentication") {
      return response({ outcome: "authentication_rejected" }, 401);
    }
    return response(
      { outcome: disposition.reason === "stale" ? "stale" : "binding_rejected" },
      disposition.reason === "stale" ? 409 : 400,
    );
  };
}
