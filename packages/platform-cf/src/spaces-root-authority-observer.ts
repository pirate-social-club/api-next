import { Effect } from "effect";
import type { SpacesRootAuthorityObserver } from "./spaces-owner-proof-repository.ts";
import {
  parseSpacesRootAuthorityEvidenceV1,
  SPACES_ROOT_AUTHORITY_MAX_RESPONSE_BYTES,
} from "./spaces-root-authority-evidence.ts";

const URL = "https://spaces-verifier.pirate.sc/v1/observe-root-authority";

const failure = (phase: string, details: Readonly<Record<string, string | number | null>>) => {
  // Never record the Access token, bearer token, signature, or verifier body.
  console.warn("spaces.root_authority.observation_failed", { phase, ...details });
};

export type SpacesRootAuthorityCredentials = Readonly<{
  accessClientId: string;
  accessClientSecret: string;
  bearerToken: string;
}>;

/** A 409 or temporary outage is retryable; neither can assert root drift. */
export function makeSpacesRootAuthorityObserver(
  credentials: SpacesRootAuthorityCredentials,
  fetchImpl: typeof fetch = fetch,
  timeoutMilliseconds = 20_000,
): SpacesRootAuthorityObserver {
  if (!credentials.accessClientId || !credentials.accessClientSecret || !credentials.bearerToken) {
    throw new TypeError("Spaces root verifier credentials are incomplete");
  }
  if (
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 1 ||
    timeoutMilliseconds > 20_000
  )
    throw new TypeError("Spaces verifier deadline is invalid");
  const collect = async (
    input: Parameters<SpacesRootAuthorityObserver["observe"]>[0],
    signal: AbortSignal,
  ): Promise<Awaited<ReturnType<SpacesRootAuthorityObserver["observe"]>>> => {
    const challenge = input.digestHex !== undefined && input.signatureHex !== undefined;
    if ((input.digestHex === undefined) !== (input.signatureHex === undefined)) {
      throw new TypeError("Incomplete Spaces root challenge");
    }
    let response: Response;
    try {
      response = await fetchImpl(URL, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          "CF-Access-Client-Id": credentials.accessClientId,
          "CF-Access-Client-Secret": credentials.accessClientSecret,
          authorization: `Bearer ${credentials.bearerToken}`,
        },
        body: JSON.stringify({
          root: `@${input.canonicalRoot}`,
          ...(challenge ? { digest_hex: input.digestHex, signature_hex: input.signatureHex } : {}),
        }),
        signal,
      });
    } catch (error) {
      failure("transport", {
        error_name: error instanceof Error ? error.name : "unknown",
        error_message: error instanceof Error ? error.message.slice(0, 160) : "unknown",
      });
      throw error;
    }
    if (signal.aborted) {
      void response.body?.cancel().catch(() => {});
      signal.throwIfAborted();
    }
    if (response.status === 409 || response.status === 503) {
      void response.body?.cancel().catch(() => {});
      return { kind: "pending" };
    }
    if (response.status !== 200 || response.body === null) {
      failure("response", {
        status: response.status,
        cf_ray: response.headers.get("cf-ray"),
        content_type: response.headers.get("content-type"),
      });
      void response.body?.cancel().catch(() => {});
      throw new Error("Spaces root verifier unavailable");
    }
    const reader = response.body.getReader();
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        total += result.value.byteLength;
        if (total > SPACES_ROOT_AUTHORITY_MAX_RESPONSE_BYTES) {
          cancel();
          throw new Error("Spaces root verifier response exceeds bound");
        }
        chunks.push(result.value);
      }
    } finally {
      signal.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return {
        kind: "verified",
        bytes,
        evidence: parseSpacesRootAuthorityEvidenceV1(bytes, input.canonicalRoot, challenge),
      };
    } catch (error) {
      failure("evidence", {
        error_name: error instanceof Error ? error.name : "unknown",
        error_message: error instanceof Error ? error.message.slice(0, 160) : "unknown",
      });
      throw error;
    }
  };
  return {
    observe: (input, callerSignal) =>
      Effect.runPromise(
        Effect.tryPromise({
          try: (signal) =>
            collect(input, callerSignal ? AbortSignal.any([signal, callerSignal]) : signal),
          catch: (error) => error,
        }).pipe(Effect.timeout(timeoutMilliseconds)),
        callerSignal ? { signal: callerSignal } : undefined,
      ),
  };
}
