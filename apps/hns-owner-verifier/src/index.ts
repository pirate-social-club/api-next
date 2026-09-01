import {
  decodeHnsActiveLeaseRenewalRequestBytes,
  HNS_ACTIVE_LEASE_RENEWAL_REQUEST_MAX_BYTES,
} from "@pirate/application/namespace-ownership";
import {
  decodeHnsOwnerRecoveryProviderPollBytes,
  decodeHnsOwnerRecoveryProviderStartBytes,
  HNS_OWNER_RECOVERY_PROVIDER_START_MAX_BYTES,
  type HnsOwnerSameRootRecoveryProviderStartV1,
} from "@pirate/application/route-revalidation";
import {
  composeHnsNameProofRuntime,
  composeHnsTargetObserverRuntime,
  type HnsTargetCompositionBindings,
} from "./composition.ts";
import {
  decodeHnsNameProofRequest,
  type HnsNameProofRuntime,
  HnsNameProofRuntimeError,
} from "./name-proof.ts";
import {
  type HnsOwnerCreationTargetSession,
  HnsTargetObserverFacadeError,
  type HnsTargetObserverRuntime,
  matchesHnsTargetObserverCreationConfiguration,
  matchesHnsTargetObserverRecoveryConfiguration,
  observeHnsActiveLeaseRenewal,
  observeHnsOwnerCreationSession,
  observeHnsOwnerRecoverySession,
} from "./target-observer.ts";

const START_PATH = "/internal/hns-owner/v1/start";
const POLL_PATH = "/internal/hns-owner/v1/poll";
const ACTIVE_LEASE_RENEWAL_PATH = "/internal/hns-owner/v1/active-lease-renewal";
const NAME_PROOF_PATH = "/internal/hns-owner/v1/verify-name-signature";
const SESSION_HEADER = "Pirate-Namespace-Session-Id";
const OBSERVATION_HEADER = "Pirate-HNS-Observation-Id";
const ACTIVE_LEASE_RENEWAL_HEADER = "Pirate-HNS-Active-Lease-Renewal-Id";
const START_REQUEST_MAX_BYTES = 8_192;
const START_RESPONSE_MAX_BYTES = 65_536;
const POLL_REQUEST_MAX_BYTES = 32_768;
const POLL_RESPONSE_MAX_BYTES = 1_048_576;
const NAME_PROOF_REQUEST_MAX_BYTES = 4_096;
const NAME_PROOF_RESPONSE_MAX_BYTES = 1_024;
const UPSTREAM_REFERENCE_BYTES = 24;

const CREATION_START_KEYS = [
  "actor_id",
  "creation_intent_id",
  "ceremony_intent_id",
  "requirement_hash",
  "generation",
  "request_hash",
  "provider_binding_hash",
  "provider_configuration",
  "protocol_version",
  "environment",
  "route",
] as const;
const REVALIDATION_START_KEYS = [
  "operation_kind",
  "route_revalidation_id",
  "revalidation_session_id",
  "community_id",
  "route_binding_id",
  "expected_binding_generation",
  "expected_verified_evidence_ref",
  "principal_kind",
  "principal_id",
  "requirement_hash",
  "start_request_hash",
  "provider_binding_hash",
  "provider_configuration",
  "protocol_version",
  "environment",
  "route",
] as const;
const CREATION_SESSION_KEYS = [
  "actor_id",
  "creation_intent_id",
  "ceremony_intent_id",
  "requirement_hash",
  "generation",
  "request_hash",
  "provider_id",
  "provider_binding_hash",
  "provider_configuration",
  "protocol_version",
  "environment",
  "route",
  "upstream_session_ref",
  "expires_at",
] as const;
const REVALIDATION_AUTHORITY_KEYS = [
  "version",
  "route_revalidation_id",
  "community_id",
  "route_binding_id",
  "principal_kind",
  "principal_id",
  "expected_binding_generation",
  "expected_verified_evidence_ref",
  "requirement_hash",
  "provider_id",
  "provider_binding_hash",
  "provider_configuration_kind",
  "provider_configuration_reference",
  "provider_configuration_version",
  "protocol_version",
  "environment",
  "family",
  "root_label",
  "root_label_display",
  "path_segment",
] as const;
const REVALIDATION_PRESENTATION_KEYS = [
  "kind",
  "session_id",
  "protocol",
  "version",
  "payload",
] as const;
const CHALLENGE_KEYS = [
  "ownership_source",
  "challenge_name",
  "challenge_value",
  "expires_at",
] as const;
const REVALIDATION_SESSION_KEYS = [
  "authority",
  "revalidation_session_id",
  "start_request_hash",
  "upstream_session_ref",
  "start_presentation",
  "status",
  "started_at",
  "expires_at",
  "terminal_at",
] as const;
const CREATION_POLL_KEYS = ["session", "payload"] as const;
const REVALIDATION_POLL_KEYS = ["operation_kind", "session", "payload"] as const;

export type Env = Readonly<{
  readonly HNS_OWNERSHIP_SOURCE?: string;
  readonly HNS_CHALLENGE_TTL_SECONDS?: string;
  readonly HNS_EVIDENCE_TTL_SECONDS?: string;
  readonly HNS_PROVIDER_ENVIRONMENT?: string;
  readonly HNS_PROVIDER_CONFIGURATION_REFERENCE?: string;
  readonly HNS_PROVIDER_CONFIGURATION_VERSION?: string;
}> &
  HnsTargetCompositionBindings;

type JsonObject = Record<string, unknown>;
type Operation = "creation" | "route_revalidation";
type StartInput = JsonObject & { readonly operation: Operation };
type PollInput = JsonObject & {
  readonly operation: Operation;
  readonly session: JsonObject;
  readonly root_label: string;
  readonly challenge_name: string;
  readonly upstream_session_ref: string;
  readonly expires_at: string;
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: JsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function safeText(value: unknown, maxBytes: number): value is string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) return false;
  if (utf8Length(value) > maxBytes) return false;
  return [...value].every((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point >= 0x20 && !(point >= 0x7f && point <= 0x9f);
  });
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function sha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function canonicalInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  );
}

function exactConfiguration(value: unknown): value is JsonObject {
  if (!isObject(value) || !hasExactKeys(value, ["kind", "reference", "version"])) return false;
  return (
    (value.kind === "managed" || value.kind === "dynamic") &&
    safeText(value.reference, 512) &&
    safeText(value.version, 256)
  );
}

function exactRoute(value: unknown): value is JsonObject {
  if (
    !isObject(value) ||
    !hasExactKeys(value, [
      "family",
      "root_label",
      "root_label_display",
      "path_segment",
      "href",
      "app_host",
    ])
  )
    return false;
  return (
    value.family === "hns" &&
    safeText(value.root_label, 63) &&
    safeText(value.root_label_display, 256) &&
    safeText(value.path_segment, 256) &&
    value.href === `/c/${value.path_segment}` &&
    value.app_host === null
  );
}

function exactChallenge(
  value: unknown,
  rootLabel: string,
  expectedSource: string,
  upstreamRef: string,
  expiresAt: string,
): value is JsonObject {
  if (!isObject(value) || !hasExactKeys(value, CHALLENGE_KEYS)) return false;
  const expectedName =
    expectedSource === "hns_parent_chain_txt" ? rootLabel : `_pirate.${rootLabel}`;
  return (
    value.ownership_source === expectedSource &&
    value.challenge_name === expectedName &&
    value.challenge_value === `pirate-verification=${upstreamRef}` &&
    value.expires_at === expiresAt
  );
}

function strictJson(bytes: Uint8Array, maxBytes: number): unknown {
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > maxBytes ||
    (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
  ) {
    throw new Error("invalid json bytes");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    assertNoDuplicateKeys(text);
    const value: unknown = JSON.parse(text);
    if (JSON.stringify(value) !== text) throw new Error("non-canonical json");
    return value;
  } catch {
    throw new Error("invalid json");
  }
}

function assertNoDuplicateKeys(text: string): void {
  let cursor = 0;
  const skipWhitespace = () => {
    while (/\s/u.test(text[cursor] ?? "")) cursor += 1;
  };
  const parseString = () => {
    const start = cursor;
    cursor += 1;
    while (cursor < text.length) {
      const character = text[cursor];
      cursor += 1;
      if (character === '"') return JSON.parse(text.slice(start, cursor)) as string;
      if (character === "\\") cursor += text[cursor] === "u" ? 5 : 1;
    }
    throw new Error("unterminated string");
  };
  const parseValue = (): void => {
    skipWhitespace();
    const token = text[cursor];
    if (token === "{") {
      cursor += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (text[cursor] === "}") {
        cursor += 1;
        return;
      }
      while (cursor < text.length) {
        if (text[cursor] !== '"') throw new Error("object key");
        const key = parseString();
        if (keys.has(key)) throw new Error("duplicate key");
        keys.add(key);
        skipWhitespace();
        if (text[cursor] !== ":") throw new Error("object colon");
        cursor += 1;
        parseValue();
        skipWhitespace();
        if (text[cursor] === "}") {
          cursor += 1;
          return;
        }
        if (text[cursor] !== ",") throw new Error("object comma");
        cursor += 1;
        skipWhitespace();
      }
      throw new Error("unterminated object");
    }
    if (token === "[") {
      cursor += 1;
      skipWhitespace();
      if (text[cursor] === "]") {
        cursor += 1;
        return;
      }
      while (cursor < text.length) {
        parseValue();
        skipWhitespace();
        if (text[cursor] === "]") {
          cursor += 1;
          return;
        }
        if (text[cursor] !== ",") throw new Error("array comma");
        cursor += 1;
        skipWhitespace();
      }
      throw new Error("unterminated array");
    }
    if (token === '"') {
      parseString();
      return;
    }
    while (cursor < text.length && !/[\s,\]}]/u.test(text[cursor] ?? "")) cursor += 1;
  };
  parseValue();
  skipWhitespace();
  if (cursor !== text.length) throw new Error("trailing json");
}

async function boundedBody(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/u.test(contentLength) || Number(contentLength) > maxBytes))
    return null;
  if (request.body === null) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(part.value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function sessionHeader(request: Request): string | null {
  const value = request.headers.get(SESSION_HEADER);
  return value !== null && safeText(value, 256) ? value : null;
}

function jsonResponse(value: unknown, status: number): Response {
  const body = JSON.stringify(value);
  if (utf8Length(body) > START_RESPONSE_MAX_BYTES) return errorResponse(502, "invalid_response");
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function bytesResponse(bytes: Uint8Array, status = 200): Response {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Response(buffer, {
    status,
    headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" },
  });
}

function errorResponse(status: number, reason: string): Response {
  return new Response(JSON.stringify({ error: reason }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function configuredSource(env: Env): "hns_parent_chain_txt" | "owner_authoritative_dns_txt" | null {
  return env.HNS_OWNERSHIP_SOURCE === "hns_parent_chain_txt" ||
    env.HNS_OWNERSHIP_SOURCE === "owner_authoritative_dns_txt"
    ? env.HNS_OWNERSHIP_SOURCE
    : null;
}

function challengeTtlSeconds(env: Env): number | null {
  const value = env.HNS_CHALLENGE_TTL_SECONDS;
  if (value === undefined || !/^\d+$/u.test(value)) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 604_800 ? seconds : null;
}

function evidenceTtlSeconds(env: Env): number | null {
  const value = env.HNS_EVIDENCE_TTL_SECONDS;
  if (value === undefined || !/^\d+$/u.test(value)) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 31_536_000 ? seconds : null;
}

function pinnedConfiguration(env: Env): Readonly<{
  readonly environment: string;
  readonly reference: string;
  readonly version: string;
}> | null {
  if (
    !safeText(env.HNS_PROVIDER_ENVIRONMENT, 256) ||
    !safeText(env.HNS_PROVIDER_CONFIGURATION_REFERENCE, 512) ||
    !safeText(env.HNS_PROVIDER_CONFIGURATION_VERSION, 256)
  )
    return null;
  return {
    environment: env.HNS_PROVIDER_ENVIRONMENT,
    reference: env.HNS_PROVIDER_CONFIGURATION_REFERENCE,
    version: env.HNS_PROVIDER_CONFIGURATION_VERSION,
  };
}

function matchesPinnedConfiguration(
  value: unknown,
  pinned: Readonly<{
    readonly environment: string;
    readonly reference: string;
    readonly version: string;
  }>,
): boolean {
  if (!isObject(value)) return false;
  return (
    value.kind === "managed" &&
    value.reference === pinned.reference &&
    value.version === pinned.version
  );
}

function sessionMatchesPinned(
  poll: PollInput,
  pinned: Readonly<{
    readonly environment: string;
    readonly reference: string;
    readonly version: string;
  }>,
): boolean {
  if (poll.operation === "creation") {
    return (
      matchesPinnedConfiguration(poll.session.provider_configuration, pinned) &&
      poll.session.environment === pinned.environment
    );
  }
  const authority = poll.session.authority;
  if (!isObject(authority)) return false;
  return (
    authority.provider_configuration_kind === "managed" &&
    authority.provider_configuration_reference === pinned.reference &&
    authority.provider_configuration_version === pinned.version &&
    authority.environment === pinned.environment
  );
}

function parseStart(value: unknown): StartInput | null {
  if (!isObject(value)) return null;
  if (hasExactKeys(value, CREATION_START_KEYS)) {
    if (
      !safeText(value.actor_id, 256) ||
      !safeText(value.creation_intent_id, 256) ||
      !safeText(value.ceremony_intent_id, 256) ||
      !sha256Hex(value.requirement_hash) ||
      !positiveInteger(value.generation) ||
      !sha256Hex(value.request_hash) ||
      !sha256Hex(value.provider_binding_hash) ||
      !exactConfiguration(value.provider_configuration) ||
      value.protocol_version !== "hns-txt-v1" ||
      !safeText(value.environment, 256) ||
      !exactRoute(value.route)
    )
      return null;
    return { ...value, operation: "creation" };
  }
  if (!hasExactKeys(value, REVALIDATION_START_KEYS)) return null;
  if (
    value.operation_kind !== "route_revalidation" ||
    !safeText(value.route_revalidation_id, 256) ||
    !safeText(value.revalidation_session_id, 256) ||
    !safeText(value.community_id, 256) ||
    !safeText(value.route_binding_id, 256) ||
    !positiveInteger(value.expected_binding_generation) ||
    (value.expected_verified_evidence_ref !== null &&
      !safeText(value.expected_verified_evidence_ref, 512)) ||
    value.principal_kind !== "system" ||
    !safeText(value.principal_id, 256) ||
    !sha256Hex(value.requirement_hash) ||
    !sha256Hex(value.start_request_hash) ||
    !sha256Hex(value.provider_binding_hash) ||
    !exactConfiguration(value.provider_configuration) ||
    value.protocol_version !== "hns-txt-v1" ||
    !safeText(value.environment, 256) ||
    !exactRoute(value.route)
  )
    return null;
  return { ...value, operation: "route_revalidation" };
}

function parseCreationSession(value: unknown): JsonObject | null {
  if (!isObject(value) || !hasExactKeys(value, CREATION_SESSION_KEYS)) return null;
  if (
    !safeText(value.actor_id, 256) ||
    !safeText(value.creation_intent_id, 256) ||
    !safeText(value.ceremony_intent_id, 256) ||
    !sha256Hex(value.requirement_hash) ||
    !positiveInteger(value.generation) ||
    !sha256Hex(value.request_hash) ||
    value.provider_id !== "hns.owner.v1" ||
    !sha256Hex(value.provider_binding_hash) ||
    !exactConfiguration(value.provider_configuration) ||
    value.protocol_version !== "hns-txt-v1" ||
    !safeText(value.environment, 256) ||
    !exactRoute(value.route) ||
    !safeText(value.upstream_session_ref, 16_384) ||
    !canonicalInstant(value.expires_at) ||
    Date.parse(value.expires_at as string) <= Date.now()
  )
    return null;
  return value;
}

function parseRevalidationSession(value: unknown): JsonObject | null {
  if (!isObject(value) || !hasExactKeys(value, REVALIDATION_SESSION_KEYS)) return null;
  const authority = value.authority;
  const presentation = value.start_presentation;
  if (
    !isObject(authority) ||
    !hasExactKeys(authority, REVALIDATION_AUTHORITY_KEYS) ||
    !isObject(presentation) ||
    !hasExactKeys(presentation, REVALIDATION_PRESENTATION_KEYS)
  )
    return null;
  if (
    authority.version !== "pirate-hns-route-revalidation-authority-v1" ||
    !safeText(authority.route_revalidation_id, 256) ||
    !safeText(authority.community_id, 256) ||
    !safeText(authority.route_binding_id, 256) ||
    authority.principal_kind !== "system" ||
    !safeText(authority.principal_id, 256) ||
    !positiveInteger(authority.expected_binding_generation) ||
    (authority.expected_verified_evidence_ref !== null &&
      !safeText(authority.expected_verified_evidence_ref, 512)) ||
    !sha256Hex(authority.requirement_hash) ||
    authority.provider_id !== "hns.owner.v1" ||
    !sha256Hex(authority.provider_binding_hash) ||
    (authority.provider_configuration_kind !== "managed" &&
      authority.provider_configuration_kind !== "dynamic") ||
    !safeText(authority.provider_configuration_reference, 512) ||
    !safeText(authority.provider_configuration_version, 256) ||
    authority.protocol_version !== "hns-txt-v1" ||
    !safeText(authority.environment, 256) ||
    authority.family !== "hns" ||
    !safeText(authority.root_label, 63) ||
    !safeText(authority.root_label_display, 256) ||
    !safeText(authority.path_segment, 256) ||
    !safeText(value.revalidation_session_id, 256) ||
    !sha256Hex(value.start_request_hash) ||
    !safeText(value.upstream_session_ref, 16_384) ||
    value.status !== "pending" ||
    !canonicalInstant(value.started_at) ||
    !canonicalInstant(value.expires_at) ||
    Date.parse(value.expires_at as string) <= Date.now() ||
    value.terminal_at !== null
  )
    return null;
  if (!isObject(presentation.payload) || !hasExactKeys(presentation.payload, CHALLENGE_KEYS))
    return null;
  if (
    presentation.kind !== "embedded_sdk" ||
    presentation.session_id !== value.upstream_session_ref ||
    presentation.protocol !== "hns-txt-challenge" ||
    presentation.version !== "1" ||
    !exactChallenge(
      presentation.payload,
      authority.root_label as string,
      String((presentation.payload as JsonObject).ownership_source),
      value.upstream_session_ref as string,
      value.expires_at as string,
    )
  )
    return null;
  return value;
}

function parsePoll(value: unknown, header: string, expectedSource: string): PollInput | null {
  if (!isObject(value)) return null;
  const isRevalidation = hasExactKeys(value, REVALIDATION_POLL_KEYS);
  const isCreation = hasExactKeys(value, CREATION_POLL_KEYS);
  if (
    (!isRevalidation && !isCreation) ||
    (isRevalidation && value.operation_kind !== "route_revalidation")
  )
    return null;
  if (!isObject(value.payload) || Object.keys(value.payload).length !== 0) return null;
  if (isRevalidation && !isObject(value.session)) return null;
  const creation = parseCreationSession(value.session);
  if (isCreation && creation !== null) {
    const route = creation.route as JsonObject;
    return {
      ...value,
      operation: "creation",
      session: creation,
      root_label: route.root_label as string,
      challenge_name:
        expectedSource === "hns_parent_chain_txt"
          ? (route.root_label as string)
          : `_pirate.${route.root_label as string}`,
      upstream_session_ref: creation.upstream_session_ref as string,
      expires_at: creation.expires_at as string,
    };
  }
  const revalidation = parseRevalidationSession(value.session);
  if (!isRevalidation || revalidation === null || revalidation.revalidation_session_id !== header)
    return null;
  const authority = revalidation.authority as JsonObject;
  const presentation = revalidation.start_presentation as JsonObject;
  const payload = presentation.payload as JsonObject;
  if (payload.ownership_source !== expectedSource) return null;
  return {
    ...value,
    operation: "route_revalidation",
    session: revalidation,
    root_label: authority.root_label as string,
    challenge_name: payload.challenge_name as string,
    upstream_session_ref: revalidation.upstream_session_ref as string,
    expires_at: revalidation.expires_at as string,
  };
}

function randomReference(): string {
  const bytes = new Uint8Array(UPSTREAM_REFERENCE_BYTES);
  crypto.getRandomValues(bytes);
  return `nvs_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function startResponse(input: StartInput, source: string, ttlSeconds: number): Response {
  const upstreamSessionRef = randomReference();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1_000).toISOString();
  const route = input.route as JsonObject;
  const rootLabel = route.root_label as string;
  const challenge = {
    ownership_source: source,
    challenge_name: source === "hns_parent_chain_txt" ? rootLabel : `_pirate.${rootLabel}`,
    challenge_value: `pirate-verification=${upstreamSessionRef}`,
    expires_at: expiresAt,
  };
  const body = {
    upstream_session_ref: upstreamSessionRef,
    expires_at: expiresAt,
    presentation: {
      kind: "embedded_sdk",
      session_id: upstreamSessionRef,
      protocol: "hns-txt-challenge",
      version: "1",
      payload: challenge,
    },
  };
  return jsonResponse(body, 200);
}

function recoveryStartResponse(
  input: HnsOwnerSameRootRecoveryProviderStartV1,
  source: string,
): Response {
  const upstreamSessionRef = randomReference();
  const expiresAt = input.challenge_expires_at;
  const rootLabel = input.route.root_label;
  return jsonResponse(
    {
      upstream_session_ref: upstreamSessionRef,
      expires_at: expiresAt,
      presentation: {
        kind: "embedded_sdk",
        session_id: upstreamSessionRef,
        protocol: "hns-txt-challenge",
        version: "1",
        payload: {
          ownership_source: source,
          challenge_name: source === "hns_parent_chain_txt" ? rootLabel : `_pirate.${rootLabel}`,
          challenge_value: `pirate-verification=${upstreamSessionRef}`,
          expires_at: expiresAt,
        },
      },
    },
    200,
  );
}

export async function handleRequest(
  request: Request,
  env: Env,
  options: Readonly<{
    readonly targetObserver?: HnsTargetObserverRuntime;
    readonly nameProof?: HnsNameProofRuntime;
  }> = {},
): Promise<Response> {
  const url = new URL(request.url);
  const source = configuredSource(env);
  const pinned = pinnedConfiguration(env);
  const evidenceTtl = evidenceTtlSeconds(env);
  if (
    url.pathname !== START_PATH &&
    url.pathname !== POLL_PATH &&
    url.pathname !== ACTIVE_LEASE_RENEWAL_PATH &&
    url.pathname !== NAME_PROOF_PATH
  )
    return errorResponse(404, "not_found");
  if (request.method !== "POST") return errorResponse(405, "method_not_allowed");
  if (url.pathname === NAME_PROOF_PATH) {
    if (
      request.headers.get("content-type") !== "application/json" ||
      request.headers.get("accept") !== "application/json" ||
      request.headers.get(OBSERVATION_HEADER) !== null ||
      sessionHeader(request) === null
    ) {
      return errorResponse(400, "invalid_request");
    }
    const body = await boundedBody(request, NAME_PROOF_REQUEST_MAX_BYTES);
    if (body === null) return errorResponse(400, "invalid_request");
    let decoded: unknown;
    try {
      decoded = strictJson(body, NAME_PROOF_REQUEST_MAX_BYTES);
    } catch {
      return errorResponse(400, "invalid_request");
    }
    const input = decodeHnsNameProofRequest(decoded);
    if (input === null) return errorResponse(400, "invalid_request");
    if (sessionHeader(request) !== input.root_import_session_id) {
      return errorResponse(400, "invalid_request");
    }
    if (options.nameProof === undefined) return errorResponse(502, "provider_misconfigured");
    try {
      const output = await options.nameProof.verify(input, request.signal);
      const result = strictJson(output, NAME_PROOF_RESPONSE_MAX_BYTES);
      return jsonResponse(result, 200);
    } catch (error) {
      return error instanceof HnsNameProofRuntimeError && error.reason === "unavailable"
        ? errorResponse(503, "provider_unavailable")
        : errorResponse(502, "invalid_response");
    }
  }
  if (url.pathname === ACTIVE_LEASE_RENEWAL_PATH) {
    if (
      request.headers.get("content-type") !== "application/json" ||
      request.headers.get("accept") !== "application/octet-stream" ||
      request.headers.get(SESSION_HEADER) !== null
    ) {
      return errorResponse(400, "invalid_request");
    }
    const renewalHeader = request.headers.get(ACTIVE_LEASE_RENEWAL_HEADER);
    const observationHeader = request.headers.get(OBSERVATION_HEADER);
    if (
      renewalHeader === null ||
      !safeText(renewalHeader, 256) ||
      observationHeader === null ||
      !safeText(observationHeader, 256)
    ) {
      return errorResponse(400, "invalid_request");
    }
    const body = await boundedBody(request, HNS_ACTIVE_LEASE_RENEWAL_REQUEST_MAX_BYTES);
    if (body === null) return errorResponse(400, "invalid_request");
    let decoded: Awaited<ReturnType<typeof decodeHnsActiveLeaseRenewalRequestBytes>>;
    try {
      decoded = await decodeHnsActiveLeaseRenewalRequestBytes(body);
    } catch {
      return errorResponse(400, "invalid_request");
    }
    if (decoded.request.active_lease_renewal_id !== renewalHeader) {
      return errorResponse(400, "invalid_request");
    }
    if (
      source === null ||
      pinned === null ||
      evidenceTtl === null ||
      options.targetObserver === undefined ||
      options.targetObserver.configuration.ownership_source !== source ||
      options.targetObserver.configuration.provider_configuration_reference !== pinned.reference ||
      options.targetObserver.configuration.provider_configuration_version !== pinned.version ||
      options.targetObserver.configuration.environment !== pinned.environment ||
      options.targetObserver.configuration.lease_policy.evidence_lease_seconds !== evidenceTtl
    ) {
      return errorResponse(502, "provider_misconfigured");
    }
    try {
      return bytesResponse(
        await observeHnsActiveLeaseRenewal(
          decoded.request,
          options.targetObserver,
          observationHeader,
          request.signal,
        ),
      );
    } catch (error) {
      if (error instanceof HnsTargetObserverFacadeError) {
        return error.reason === "ineligible"
          ? errorResponse(409, "renewal_evidence_ineligible")
          : error.reason === "unavailable"
            ? errorResponse(503, "provider_unavailable")
            : error.reason === "misconfigured"
              ? errorResponse(502, "provider_misconfigured")
              : errorResponse(502, "invalid_response");
      }
      return errorResponse(502, "invalid_response");
    }
  }
  const header = sessionHeader(request);
  if (header === null) return errorResponse(400, "invalid_request");
  const observationHeader = request.headers.get(OBSERVATION_HEADER);
  const expectedContentType = "application/json";
  if (request.headers.get("content-type") !== expectedContentType)
    return errorResponse(400, "invalid_request");
  const expectedAccept =
    url.pathname === START_PATH ? "application/json" : "application/octet-stream";
  if (request.headers.get("accept") !== expectedAccept)
    return errorResponse(400, "invalid_request");
  if (source === null || pinned === null || evidenceTtl === null)
    return errorResponse(502, "provider_misconfigured");
  const maxBytes =
    url.pathname === START_PATH
      ? HNS_OWNER_RECOVERY_PROVIDER_START_MAX_BYTES
      : POLL_REQUEST_MAX_BYTES;
  const body = await boundedBody(request, maxBytes);
  if (body === null) return errorResponse(400, "invalid_request");
  let decoded: unknown;
  try {
    decoded = strictJson(body, maxBytes);
  } catch {
    return errorResponse(400, "invalid_request");
  }
  if (url.pathname === START_PATH) {
    if (observationHeader !== null) return errorResponse(400, "invalid_request");
    if (isObject(decoded) && decoded.operation_kind === "same_root_recovery") {
      let input: HnsOwnerSameRootRecoveryProviderStartV1;
      try {
        input = await decodeHnsOwnerRecoveryProviderStartBytes(body);
      } catch {
        return errorResponse(400, "invalid_request");
      }
      if (options.targetObserver === undefined) return errorResponse(502, "provider_misconfigured");
      if (header !== input.session_id) return errorResponse(400, "invalid_request");
      if (
        !matchesPinnedConfiguration(input.provider_configuration, pinned) ||
        input.environment !== pinned.environment ||
        !matchesHnsTargetObserverRecoveryConfiguration(input, options.targetObserver) ||
        options.targetObserver.configuration.ownership_source !== source ||
        options.targetObserver.configuration.lease_policy.evidence_lease_seconds !== evidenceTtl
      ) {
        return errorResponse(502, "provider_misconfigured");
      }
      return recoveryStartResponse(input, source);
    }
    if (body.byteLength > START_REQUEST_MAX_BYTES) return errorResponse(400, "invalid_request");
    const input = parseStart(decoded);
    const ttl = challengeTtlSeconds(env);
    if (input === null) return errorResponse(400, "invalid_request");
    if (ttl === null) return errorResponse(502, "provider_misconfigured");
    if (input.operation !== "creation" || options.targetObserver === undefined) {
      return errorResponse(502, "provider_misconfigured");
    }
    if (
      !matchesPinnedConfiguration(input.provider_configuration, pinned) ||
      input.environment !== pinned.environment ||
      options.targetObserver.configuration.provider_configuration_reference !== pinned.reference ||
      options.targetObserver.configuration.provider_configuration_version !== pinned.version ||
      options.targetObserver.configuration.environment !== pinned.environment ||
      options.targetObserver.configuration.ownership_source !== source ||
      options.targetObserver.configuration.lease_policy.evidence_lease_seconds !== evidenceTtl
    )
      return errorResponse(502, "provider_misconfigured");
    return startResponse(input, source, ttl);
  }
  if (isObject(decoded) && decoded.operation_kind === "same_root_recovery") {
    let poll: Awaited<ReturnType<typeof decodeHnsOwnerRecoveryProviderPollBytes>>;
    try {
      poll = await decodeHnsOwnerRecoveryProviderPollBytes(body);
    } catch {
      return errorResponse(400, "invalid_request");
    }
    if (header !== poll.session.session_id) return errorResponse(400, "invalid_request");
    if (observationHeader === null || !safeText(observationHeader, 256)) {
      return errorResponse(400, "invalid_request");
    }
    if (options.targetObserver === undefined) {
      return errorResponse(502, "provider_misconfigured");
    }
    if (
      !matchesPinnedConfiguration(poll.session.provider_configuration, pinned) ||
      poll.session.environment !== pinned.environment ||
      !matchesHnsTargetObserverRecoveryConfiguration(poll.session, options.targetObserver) ||
      options.targetObserver.configuration.ownership_source !== source ||
      options.targetObserver.configuration.lease_policy.evidence_lease_seconds !== evidenceTtl
    ) {
      return errorResponse(502, "provider_misconfigured");
    }
    try {
      return bytesResponse(
        await observeHnsOwnerRecoverySession(
          poll.session,
          options.targetObserver,
          observationHeader,
        ),
      );
    } catch (error) {
      if (error instanceof HnsTargetObserverFacadeError) {
        return error.reason === "unavailable"
          ? errorResponse(503, "provider_unavailable")
          : error.reason === "misconfigured"
            ? errorResponse(502, "provider_misconfigured")
            : errorResponse(502, "invalid_response");
      }
      return errorResponse(502, "invalid_response");
    }
  }
  if (observationHeader === null || !safeText(observationHeader, 256)) {
    return errorResponse(400, "invalid_request");
  }
  const poll = parsePoll(decoded, header, source);
  if (poll === null) return errorResponse(400, "invalid_request");
  if (
    poll.operation !== "creation" ||
    !sessionMatchesPinned(poll, pinned) ||
    options.targetObserver === undefined ||
    options.targetObserver.configuration.ownership_source !== source ||
    options.targetObserver.configuration.lease_policy.evidence_lease_seconds !== evidenceTtl ||
    !matchesHnsTargetObserverCreationConfiguration(
      poll.session as unknown as HnsOwnerCreationTargetSession,
      options.targetObserver,
    )
  ) {
    return errorResponse(502, "provider_misconfigured");
  }
  try {
    const output = await observeHnsOwnerCreationSession(
      poll.session as unknown as HnsOwnerCreationTargetSession,
      options.targetObserver,
      observationHeader,
    );
    const target = strictJson(output, POLL_RESPONSE_MAX_BYTES);
    if (!isObject(target)) return errorResponse(502, "invalid_response");
    if (target.status === "unavailable") return errorResponse(503, "provider_unavailable");
    if (target.status === "rejected") return errorResponse(422, "provider_rejected");
    if (target.status !== "pending" && target.status !== "verified") {
      return errorResponse(502, "invalid_response");
    }
    return bytesResponse(output);
  } catch (error) {
    if (error instanceof HnsTargetObserverFacadeError) {
      return error.reason === "unavailable"
        ? errorResponse(503, "provider_unavailable")
        : error.reason === "misconfigured"
          ? errorResponse(502, "provider_misconfigured")
          : errorResponse(502, "invalid_response");
    }
    return errorResponse(502, "invalid_response");
  }
}

const app = {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === NAME_PROOF_PATH) {
      let nameProof: HnsNameProofRuntime | undefined;
      try {
        nameProof = composeHnsNameProofRuntime(env, request.signal);
      } catch {
        nameProof = undefined;
      }
      return handleRequest(request, env, {
        ...(nameProof === undefined ? {} : { nameProof }),
      });
    }
    let targetObserver: HnsTargetObserverRuntime | undefined;
    try {
      targetObserver = await composeHnsTargetObserverRuntime(env, request.signal);
    } catch {
      targetObserver = undefined;
    }
    return handleRequest(request, env, {
      ...(targetObserver === undefined ? {} : { targetObserver }),
    });
  },
};

export { app };
export default app;
