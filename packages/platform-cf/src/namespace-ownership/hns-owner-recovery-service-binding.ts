import {
  decodeHnsOwnerRecoveryProviderStartResponseBytes,
  encodeHnsOwnerRecoveryProviderPollRequest,
  encodeHnsOwnerRecoveryProviderStart,
  type HnsOwnerRecoveryPollProvider,
  type HnsOwnerRecoveryProvider,
  HnsOwnerRecoveryProviderFailed,
} from "@pirate/application/route-revalidation";
import { Effect } from "effect";
import {
  discardHnsOwnerServiceBindingResponse,
  type HnsOwnerServiceBinding,
  readBoundedHnsOwnerServiceBindingResponse,
} from "./hns-owner-service-binding.ts";

const START_URL = "https://hns-owner.internal/internal/hns-owner/v1/start";
const POLL_URL = "https://hns-owner.internal/internal/hns-owner/v1/poll";
const START_RESPONSE_MAX_BYTES = 65_536;
const POLL_RESPONSE_MAX_BYTES = 1_048_576;
const ERROR_RESPONSE_MAX_BYTES = 64;
const MISCONFIGURED_ERROR_BODY = '{"error":"provider_misconfigured"}';
const INVALID_RESPONSE_ERROR_BODY = '{"error":"invalid_response"}';

export const HNS_OWNER_RECOVERY_START_DEADLINE_MS = 5_000;
export const HNS_OWNER_RECOVERY_POLL_DEADLINE_MS = 15_000;

export type HnsOwnerRecoveryServiceBindingProvider = HnsOwnerRecoveryProvider &
  HnsOwnerRecoveryPollProvider;

function failed(reason: "unavailable" | "misconfigured" | "invalid_response") {
  return new HnsOwnerRecoveryProviderFailed({ reason });
}

function canonicalIdentifier(value: string): boolean {
  if (value.length === 0 || value.trim() !== value) return false;
  if (new TextEncoder().encode(value).byteLength > 256) return false;
  return [...value].every((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point >= 0x20 && !(point >= 0x7f && point <= 0x9f);
  });
}

async function mappedInternalError(response: Response): Promise<never> {
  if (response.headers.get("content-type")?.toLowerCase() !== "application/json") {
    await discardHnsOwnerServiceBindingResponse(response);
    throw failed("invalid_response");
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedHnsOwnerServiceBindingResponse(
      response,
      ERROR_RESPONSE_MAX_BYTES,
      () => failed("invalid_response"),
    );
  } catch {
    throw failed("invalid_response");
  }
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw failed("invalid_response");
  }
  if (body === MISCONFIGURED_ERROR_BODY) throw failed("misconfigured");
  if (body === INVALID_RESPONSE_ERROR_BODY) throw failed("invalid_response");
  throw failed("invalid_response");
}

async function mappedResponse(
  response: Response,
  expectedContentType: "application/json" | "application/octet-stream",
  maxBytes: number,
): Promise<Uint8Array> {
  if (response.status === 502) return mappedInternalError(response);
  if (response.status === 429 || response.status >= 500) {
    await discardHnsOwnerServiceBindingResponse(response);
    throw failed("unavailable");
  }
  if ([400, 404, 409, 422].includes(response.status)) {
    await discardHnsOwnerServiceBindingResponse(response);
    throw failed("invalid_response");
  }
  if (
    response.status !== 200 ||
    response.headers.get("content-type")?.toLowerCase() !== expectedContentType
  ) {
    await discardHnsOwnerServiceBindingResponse(response);
    throw failed("invalid_response");
  }
  return readBoundedHnsOwnerServiceBindingResponse(response, maxBytes, () =>
    failed("invalid_response"),
  );
}

function boundRequest(
  binding: HnsOwnerServiceBinding,
  input: Readonly<{
    readonly url: string;
    readonly body: Uint8Array;
    readonly accept: "application/json" | "application/octet-stream";
    readonly session_id: string;
    readonly observation_id?: string;
    readonly deadline_ms: number;
    readonly max_response_bytes: number;
  }>,
): Effect.Effect<Uint8Array, HnsOwnerRecoveryProviderFailed> {
  return Effect.tryPromise({
    try: async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), input.deadline_ms);
      try {
        const headers: Array<[string, string]> = [
          ["Content-Type", "application/json"],
          ["Accept", input.accept],
          ["Pirate-Namespace-Session-Id", input.session_id],
        ];
        if (input.observation_id !== undefined) {
          headers.push(["Pirate-HNS-Observation-Id", input.observation_id]);
        }
        const response = await binding.fetch(input.url, {
          method: "POST",
          headers,
          body: input.body,
          redirect: "manual",
          signal: controller.signal,
        });
        return await mappedResponse(response, input.accept, input.max_response_bytes);
      } finally {
        clearTimeout(timeout);
      }
    },
    catch: (error) =>
      error instanceof HnsOwnerRecoveryProviderFailed ? error : failed("unavailable"),
  });
}

/**
 * Private recovery-only service-binding adapter. It owns no global-fetch or
 * public-URL fallback and is not assembled into either Worker by this module.
 */
export function makeHnsOwnerRecoveryServiceBindingProvider(
  binding: HnsOwnerServiceBinding,
): HnsOwnerRecoveryServiceBindingProvider {
  return {
    start: (request, options) => {
      if (options.deadline_ms !== HNS_OWNER_RECOVERY_START_DEADLINE_MS) {
        return Effect.fail(failed("misconfigured"));
      }
      return Effect.tryPromise({
        try: () => encodeHnsOwnerRecoveryProviderStart(request),
        catch: () => failed("invalid_response"),
      }).pipe(
        Effect.flatMap((body) =>
          boundRequest(binding, {
            url: START_URL,
            body,
            accept: "application/json",
            session_id: request.session_id,
            deadline_ms: options.deadline_ms,
            max_response_bytes: START_RESPONSE_MAX_BYTES,
          }),
        ),
        Effect.flatMap((responseBytes) =>
          Effect.try({
            try: () => decodeHnsOwnerRecoveryProviderStartResponseBytes(responseBytes),
            catch: () => failed("invalid_response"),
          }),
        ),
      );
    },
    poll: (request, options) => {
      if (options.deadline_ms !== HNS_OWNER_RECOVERY_POLL_DEADLINE_MS) {
        return Effect.fail(failed("misconfigured"));
      }
      if (!canonicalIdentifier(options.observation_id)) {
        return Effect.fail(failed("invalid_response"));
      }
      return Effect.try({
        try: () => encodeHnsOwnerRecoveryProviderPollRequest(request),
        catch: () => failed("invalid_response"),
      }).pipe(
        Effect.flatMap((body) =>
          boundRequest(binding, {
            url: POLL_URL,
            body,
            accept: "application/octet-stream",
            session_id: request.session.session_id,
            observation_id: options.observation_id,
            deadline_ms: options.deadline_ms,
            max_response_bytes: POLL_RESPONSE_MAX_BYTES,
          }),
        ),
      );
    },
  };
}
