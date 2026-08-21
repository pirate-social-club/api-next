import {
  HNS_OWNER_PROVIDER_ID,
  NamespaceOwnershipProviderInvalidResponse,
  NamespaceOwnershipProviderRejected,
  NamespaceOwnershipProviderUnavailable,
} from "@pirate/application";
import type { HnsRouteRevalidationSessionV1 } from "@pirate/application/route-revalidation";
import type { HnsOwnerRouteRevalidationStartWireV1 } from "@pirate/application/route-revalidation/hashes";
import { Effect } from "effect";
import type { HnsOwnerTransport, HnsOwnerTransportFailure } from "./hns-owner.ts";

const START_URL = "https://hns-owner.internal/internal/hns-owner/v1/start";
const POLL_URL = "https://hns-owner.internal/internal/hns-owner/v1/poll";
const START_REQUEST_MAX_BYTES = 8_192;
const START_RESPONSE_MAX_BYTES = 65_536;
const POLL_REQUEST_MAX_BYTES = 32_768;
const POLL_RESPONSE_MAX_BYTES = 1_048_576;
const START_DEADLINE_MS = 5_000;
const POLL_DEADLINE_MS = 15_000;

export type HnsOwnerServiceBinding = Readonly<{
  readonly fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
}>;

/** Low-level route-revalidation start transport. It deliberately has no
 * creation-intent or ceremony fields and is not part of the creation adapter. */
export type HnsOwnerRouteRevalidationTransport = Readonly<{
  readonly start: (
    input: Readonly<{
      readonly wire: HnsOwnerRouteRevalidationStartWireV1;
      readonly revalidation_session_id: string;
    }>,
  ) => Effect.Effect<Uint8Array, HnsOwnerTransportFailure>;
  readonly complete: (
    input: Readonly<{
      readonly session: HnsRouteRevalidationSessionV1;
      readonly revalidation_session_id: string;
    }>,
  ) => Effect.Effect<Uint8Array, HnsOwnerTransportFailure>;
}>;

type Operation = "start" | "complete";

function unavailable(operation: Operation) {
  return new NamespaceOwnershipProviderUnavailable({
    provider_id: HNS_OWNER_PROVIDER_ID,
    operation,
  });
}

function rejected(operation: Operation) {
  return new NamespaceOwnershipProviderRejected({
    provider_id: HNS_OWNER_PROVIDER_ID,
    operation,
  });
}

function invalid(operation: Operation) {
  return new NamespaceOwnershipProviderInvalidResponse({
    provider_id: HNS_OWNER_PROVIDER_ID,
    operation,
  });
}

function jsonBytes(value: unknown, maxBytes: number, operation: Operation): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(value));
  } catch {
    throw invalid(operation);
  }
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) throw invalid(operation);
  return bytes;
}

async function boundedResponseBytes(
  response: Response,
  maxBytes: number,
  operation: Operation,
): Promise<Uint8Array> {
  const declaredHeader = response.headers.get("content-length");
  if (declaredHeader !== null) {
    const declared = Number(declaredHeader);
    if (!Number.isSafeInteger(declared) || declared < 1 || declared > maxBytes) {
      throw invalid(operation);
    }
  }
  if (response.body === null) throw invalid(operation);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the bounded-response classification if cancellation races
          // the provider closing the stream.
        }
        throw invalid(operation);
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw invalid(operation);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response classification remains authoritative if the provider closes
    // or errors its stream while it is being discarded.
  }
}

async function mappedResponse(
  response: Response,
  operation: Operation,
  contentType: "application/json" | "application/octet-stream",
  maxBytes: number,
): Promise<Uint8Array> {
  if (response.status === 429 || response.status >= 500) {
    await discardResponseBody(response);
    throw unavailable(operation);
  }
  if ([400, 404, 409, 422].includes(response.status)) {
    await discardResponseBody(response);
    throw rejected(operation);
  }
  if (
    response.status !== 200 ||
    response.headers.get("content-type")?.toLowerCase() !== contentType
  ) {
    await discardResponseBody(response);
    throw invalid(operation);
  }
  return boundedResponseBytes(response, maxBytes, operation);
}

function request(
  binding: HnsOwnerServiceBinding,
  url: string,
  body: Uint8Array,
  accept: string,
  sessionId: string,
  deadlineMs: number,
  operation: Operation,
  maxResponseBytes: number,
): Effect.Effect<Uint8Array, HnsOwnerTransportFailure> {
  return Effect.tryPromise({
    try: async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), deadlineMs);
      try {
        const response = await binding.fetch(url, {
          method: "POST",
          headers: [
            ["Content-Type", "application/json"],
            ["Accept", accept],
            ["Pirate-Namespace-Session-Id", sessionId],
          ],
          body,
          redirect: "manual",
          signal: controller.signal,
        });
        return await mappedResponse(
          response,
          operation,
          accept === "application/json" ? "application/json" : "application/octet-stream",
          maxResponseBytes,
        );
      } finally {
        clearTimeout(timeout);
      }
    },
    catch: (error) =>
      error instanceof NamespaceOwnershipProviderUnavailable ||
      error instanceof NamespaceOwnershipProviderRejected ||
      error instanceof NamespaceOwnershipProviderInvalidResponse
        ? error
        : unavailable(operation),
  });
}

/**
 * The only production HNS transport. The injected Fetcher is a Cloudflare
 * service binding; there is deliberately no global-fetch or public-URL path.
 */
export function makeHnsOwnerServiceBindingTransport(
  binding: HnsOwnerServiceBinding,
): HnsOwnerTransport {
  return {
    start: ({ input, context }) => {
      const body = jsonBytes(
        {
          actor_id: input.actor_id,
          creation_intent_id: input.creation_intent_id,
          ceremony_intent_id: input.ceremony_intent_id,
          requirement_hash: input.requirement_hash,
          generation: input.generation,
          request_hash: input.request_hash,
          provider_binding_hash: input.provider_binding_hash,
          provider_configuration: {
            kind: input.provider_configuration.kind,
            reference: input.provider_configuration.reference,
            version: input.provider_configuration.version,
          },
          protocol_version: input.protocol_version,
          environment: input.environment,
          route: {
            family: input.route.family,
            root_label: input.route.root_label,
            root_label_display: input.route.root_label_display,
            path_segment: input.route.path_segment,
            href: input.route.href,
            app_host: input.route.app_host,
          },
        },
        START_REQUEST_MAX_BYTES,
        "start",
      );
      return request(
        binding,
        START_URL,
        body,
        "application/json",
        context.namespace_session_id,
        START_DEADLINE_MS,
        "start",
        START_RESPONSE_MAX_BYTES,
      );
    },
    poll: ({ session, payload, context }) => {
      const body = jsonBytes({ session, payload }, POLL_REQUEST_MAX_BYTES, "complete");
      return request(
        binding,
        POLL_URL,
        body,
        "application/octet-stream",
        context.namespace_session_id,
        POLL_DEADLINE_MS,
        "complete",
        POLL_RESPONSE_MAX_BYTES,
      );
    },
  };
}

/**
 * Reuses only the service-binding HTTP seam. The route-revalidation body is a
 * separate target-owned wire shape and cannot enter the creation adapter.
 */
export function makeHnsOwnerRouteRevalidationTransport(
  binding: HnsOwnerServiceBinding,
): HnsOwnerRouteRevalidationTransport {
  return {
    start: ({ wire, revalidation_session_id }) => {
      const body = jsonBytes(
        {
          operation_kind: wire.operation_kind,
          route_revalidation_id: wire.route_revalidation_id,
          revalidation_session_id: wire.revalidation_session_id,
          community_id: wire.community_id,
          route_binding_id: wire.route_binding_id,
          expected_binding_generation: wire.expected_binding_generation,
          expected_verified_evidence_ref: wire.expected_verified_evidence_ref,
          principal_kind: wire.principal_kind,
          principal_id: wire.principal_id,
          requirement_hash: wire.requirement_hash,
          start_request_hash: wire.start_request_hash,
          provider_binding_hash: wire.provider_binding_hash,
          provider_configuration: {
            kind: wire.provider_configuration.kind,
            reference: wire.provider_configuration.reference,
            version: wire.provider_configuration.version,
          },
          protocol_version: wire.protocol_version,
          environment: wire.environment,
          route: {
            family: wire.route.family,
            root_label: wire.route.root_label,
            root_label_display: wire.route.root_label_display,
            path_segment: wire.route.path_segment,
            href: wire.route.href,
            app_host: wire.route.app_host,
          },
        },
        START_REQUEST_MAX_BYTES,
        "start",
      );
      return request(
        binding,
        START_URL,
        body,
        "application/json",
        revalidation_session_id,
        START_DEADLINE_MS,
        "start",
        START_RESPONSE_MAX_BYTES,
      );
    },
    complete: ({ session, revalidation_session_id }) => {
      const body = jsonBytes(
        {
          operation_kind: "route_revalidation",
          session,
          payload: {},
        },
        POLL_REQUEST_MAX_BYTES,
        "complete",
      );
      return request(
        binding,
        POLL_URL,
        body,
        "application/octet-stream",
        revalidation_session_id,
        POLL_DEADLINE_MS,
        "complete",
        POLL_RESPONSE_MAX_BYTES,
      );
    },
  };
}
