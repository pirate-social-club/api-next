const START_PATH = "/internal/hns-owner/v1/start";
const POLL_PATH = "/internal/hns-owner/v1/poll";
const SESSION_HEADER = "Pirate-Namespace-Session-Id";
const START_REQUEST_MAX_BYTES = 8_192;
const START_RESPONSE_MAX_BYTES = 65_536;
const POLL_REQUEST_MAX_BYTES = 32_768;
const POLL_RESPONSE_MAX_BYTES = 1_048_576;
const LEGACY_TIMEOUT_MS = 12_000;
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

const LEGACY_KEYS = new Set([
  "verified",
  "observation_provider",
  "ownership_source",
  "failure_reason",
  "observed_values",
  "owner_dns_nameservers",
  "root_exists",
  "root_control_verified",
  "expiry_root_exists",
  "expiry_horizon_sufficient",
  "expiry_height",
  "expiry_anchor_height",
  "expiry_anchor_block_hash",
  "expiry_anchor_median_time",
  "expiry_chain_network",
  "expiry_blocks_remaining",
  "expiry_horizon_blocks",
  "expiry_observation_provider",
  "routing_enabled",
  "pirate_dns_authority_verified",
  "control_class",
  "operation_class",
  "root_label",
  "zone_name",
  "challenge_name",
  "challenge_value",
  "challenge_txt_value",
  "provider_evidence_ref",
  "chain_network",
  "chain_anchor_height",
  "chain_anchor_block_hash",
  "chain_anchor_median_time",
  "observed_at",
  "expires_at",
]);

export type Env = Readonly<{
  readonly HNS_OWNERSHIP_SOURCE?: string;
  readonly HNS_CHALLENGE_TTL_SECONDS?: string;
  readonly HNS_EVIDENCE_TTL_SECONDS?: string;
  readonly HNS_LEGACY_VERIFIER_URL?: string;
  readonly HNS_LEGACY_VERIFIER_BEARER?: string;
  readonly HNS_PROVIDER_ENVIRONMENT?: string;
  readonly HNS_PROVIDER_CONFIGURATION_REFERENCE?: string;
  readonly HNS_PROVIDER_CONFIGURATION_VERSION?: string;
}>;

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
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

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

function legacyUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || !url.origin) return null;
    const path = url.pathname.replace(/\/+$/u, "");
    url.pathname = path.endsWith("/verify-txt") ? path : `${path}/verify-txt`;
    return url.toString();
  } catch {
    return null;
  }
}

async function boundedResponseBody(response: Response): Promise<Uint8Array | null> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/u.test(contentLength) || Number(contentLength) > POLL_RESPONSE_MAX_BYTES)
  )
    return null;
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total === 0 || total > POLL_RESPONSE_MAX_BYTES) {
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
  if (total === 0) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function legacyField(value: JsonObject, primary: string, fallback: string): unknown {
  return value[primary] ?? value[fallback];
}

function validLegacyShape(value: JsonObject): boolean {
  return Object.keys(value).every((key) => LEGACY_KEYS.has(key));
}

function legacyChallengeName(value: unknown, poll: PollInput, source: string): boolean {
  if (typeof value !== "string") return false;
  const normalized =
    source === "hns_parent_chain_txt" && value.endsWith(".") ? value.slice(0, -1) : value;
  return normalized === poll.challenge_name;
}

async function legacyEvidenceReference(bytes: Uint8Array): Promise<string> {
  const input = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(input).set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `legacy-ns1:sha256:${hex}`;
}

type LegacyMapping =
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "unavailable" }
  | { readonly kind: "invalid" };

function legacyRejectionReason(value: JsonObject): string {
  if (value.root_exists === false || value.failure_reason === "root_not_found")
    return "missing_root";
  if (
    value.failure_reason === "challenge_mismatch" ||
    value.failure_reason === "challenge_not_published"
  )
    return "challenge_mismatch";
  if (value.expiry_horizon_sufficient === false) return "insufficient_expiry";
  if (value.root_control_verified === false) return "control_failed";
  return "disputed";
}

function expectedObservation(
  value: JsonObject,
  poll: PollInput,
  source: string,
  observedAt: string,
  evidenceExpiresAt: string,
  providerEvidenceRef: string,
): JsonObject | null {
  if (
    !validLegacyShape(value) ||
    value.verified !== true ||
    value.ownership_source !== source ||
    !legacyChallengeName(value.challenge_name, poll, source)
  )
    return null;
  const expectedChallenge = `pirate-verification=${poll.upstream_session_ref}`;
  if (value.challenge_value !== undefined && value.challenge_value !== expectedChallenge)
    return null;
  if (
    !Array.isArray(value.observed_values) ||
    !value.observed_values.every((entry) => typeof entry === "string") ||
    !value.observed_values.includes(expectedChallenge) ||
    (value.root_label !== undefined && value.root_label !== poll.root_label) ||
    (value.zone_name !== undefined && value.zone_name !== `${poll.root_label}.`)
  )
    return null;
  const rootExists = value.root_exists;
  const rootControlVerified = value.root_control_verified;
  const expirySufficient = value.expiry_horizon_sufficient;
  const network = legacyField(value, "chain_network", "expiry_chain_network");
  const anchorHeight = legacyField(value, "chain_anchor_height", "expiry_anchor_height");
  const anchorHash = legacyField(value, "chain_anchor_block_hash", "expiry_anchor_block_hash");
  const anchorMedianTime = legacyField(
    value,
    "chain_anchor_median_time",
    "expiry_anchor_median_time",
  );
  if (
    rootExists !== true ||
    rootControlVerified !== true ||
    expirySufficient !== true ||
    !safeText(network, 256) ||
    !positiveInteger(anchorHeight) ||
    !sha256Hex(anchorHash) ||
    !positiveInteger(anchorMedianTime) ||
    !positiveInteger(value.expiry_height) ||
    !canonicalInstant(observedAt) ||
    !canonicalInstant(evidenceExpiresAt) ||
    Date.parse(evidenceExpiresAt) <= Date.parse(observedAt) ||
    !safeText(providerEvidenceRef, 512)
  )
    return null;
  return {
    ownership_source: source,
    challenge_name: poll.challenge_name,
    challenge_value: expectedChallenge,
    root_exists: true,
    root_control_verified: true,
    expiry_horizon_sufficient: true,
    chain_network: network,
    chain_anchor_height: anchorHeight,
    chain_anchor_block_hash: anchorHash,
    chain_anchor_median_time: anchorMedianTime,
    expiry_height: value.expiry_height,
    observed_at: observedAt,
    expires_at: evidenceExpiresAt,
    provider_evidence_ref: providerEvidenceRef,
  };
}

async function mapLegacy(
  value: unknown,
  rawBytes: Uint8Array,
  poll: PollInput,
  source: string,
  evidenceTtl: number,
): Promise<LegacyMapping> {
  if (!isObject(value) || !validLegacyShape(value) || typeof value.verified !== "boolean")
    return { kind: "invalid" };
  if (value.verified === false) {
    if (value.ownership_source !== undefined && value.ownership_source !== null)
      return { kind: "invalid" };
    if (
      value.challenge_name !== undefined &&
      !legacyChallengeName(value.challenge_name, poll, source)
    )
      return { kind: "invalid" };
    if (
      value.challenge_value !== undefined &&
      value.challenge_value !== `pirate-verification=${poll.upstream_session_ref}`
    )
      return { kind: "invalid" };
    if (
      value.failure_reason === "root_resource_unavailable" ||
      value.failure_reason === "ownership_observation_unavailable"
    ) {
      return { kind: "unavailable" };
    }
    if (value.failure_reason === "challenge_not_published" && poll.operation === "creation") {
      return {
        kind: "bytes",
        bytes: new TextEncoder().encode(JSON.stringify({ status: "pending" })),
      };
    }
    if (poll.operation === "route_revalidation") {
      return {
        kind: "bytes",
        bytes: new TextEncoder().encode(
          JSON.stringify({ status: "rejected", reason_code: legacyRejectionReason(value) }),
        ),
      };
    }
    return { kind: "rejected", reason: legacyRejectionReason(value) };
  }
  const observedAt = new Date().toISOString();
  const evidenceExpiresAt = new Date(Date.parse(observedAt) + evidenceTtl * 1_000).toISOString();
  const providerEvidenceRef = await legacyEvidenceReference(rawBytes);
  const observation = expectedObservation(
    value,
    poll,
    source,
    observedAt,
    evidenceExpiresAt,
    providerEvidenceRef,
  );
  if (observation === null) return { kind: "invalid" };
  const output =
    poll.operation === "route_revalidation"
      ? { status: "verified", observation }
      : {
          status: "verified",
          provider_evidence_ref: observation.provider_evidence_ref,
          upstream_session_ref: poll.upstream_session_ref,
          ...observation,
        };
  const bytes = new TextEncoder().encode(JSON.stringify(output));
  return bytes.byteLength > POLL_RESPONSE_MAX_BYTES
    ? { kind: "invalid" }
    : { kind: "bytes", bytes };
}

async function pollLegacy(
  poll: PollInput,
  env: Env,
  source: string,
  fetcher: Fetcher,
): Promise<Response> {
  const url =
    env.HNS_LEGACY_VERIFIER_URL === undefined ? null : legacyUrl(env.HNS_LEGACY_VERIFIER_URL);
  const bearer = env.HNS_LEGACY_VERIFIER_BEARER;
  const ttl = evidenceTtlSeconds(env);
  if (url === null || bearer === undefined || !safeText(bearer, 16_384) || ttl === null)
    return errorResponse(502, "provider_misconfigured");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LEGACY_TIMEOUT_MS);
  try {
    const response = await fetcher(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        root_label: poll.root_label,
        challenge_host: poll.challenge_name,
        challenge_txt_value: `pirate-verification=${poll.upstream_session_ref}`,
      }),
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel();
      return errorResponse(503, "provider_unavailable");
    }
    if ([400, 404, 409, 422].includes(response.status)) {
      await response.body?.cancel();
      return errorResponse(422, "provider_rejected");
    }
    if (response.status !== 200 || response.headers.get("content-type") !== "application/json") {
      await response.body?.cancel();
      return errorResponse(502, "invalid_response");
    }
    const body = await boundedResponseBody(response);
    if (body === null) return errorResponse(502, "invalid_response");
    let decoded: unknown;
    try {
      decoded = strictJson(body, POLL_RESPONSE_MAX_BYTES);
    } catch {
      return errorResponse(502, "invalid_response");
    }
    const mapped = await mapLegacy(decoded, body, poll, source, ttl);
    if (mapped.kind === "invalid") return errorResponse(502, "invalid_response");
    if (mapped.kind === "unavailable") return errorResponse(503, "provider_unavailable");
    if (mapped.kind === "rejected") return errorResponse(422, "provider_rejected");
    return bytesResponse(mapped.bytes);
  } catch {
    return errorResponse(503, "provider_unavailable");
  } finally {
    clearTimeout(timeout);
  }
}

export async function handleRequest(
  request: Request,
  env: Env,
  options: Readonly<{ readonly fetcher?: Fetcher }> = {},
): Promise<Response> {
  const url = new URL(request.url);
  const source = configuredSource(env);
  const pinned = pinnedConfiguration(env);
  const evidenceTtl = evidenceTtlSeconds(env);
  if (url.pathname !== START_PATH && url.pathname !== POLL_PATH)
    return errorResponse(404, "not_found");
  if (request.method !== "POST") return errorResponse(405, "method_not_allowed");
  const header = sessionHeader(request);
  if (header === null) return errorResponse(400, "invalid_request");
  const expectedContentType = "application/json";
  if (request.headers.get("content-type") !== expectedContentType)
    return errorResponse(400, "invalid_request");
  const expectedAccept =
    url.pathname === START_PATH ? "application/json" : "application/octet-stream";
  if (request.headers.get("accept") !== expectedAccept)
    return errorResponse(400, "invalid_request");
  if (source === null || pinned === null || evidenceTtl === null)
    return errorResponse(502, "provider_misconfigured");
  const maxBytes = url.pathname === START_PATH ? START_REQUEST_MAX_BYTES : POLL_REQUEST_MAX_BYTES;
  const body = await boundedBody(request, maxBytes);
  if (body === null) return errorResponse(400, "invalid_request");
  let decoded: unknown;
  try {
    decoded = strictJson(body, maxBytes);
  } catch {
    return errorResponse(400, "invalid_request");
  }
  if (url.pathname === START_PATH) {
    const input = parseStart(decoded);
    const ttl = challengeTtlSeconds(env);
    if (input === null) return errorResponse(400, "invalid_request");
    if (ttl === null) return errorResponse(502, "provider_misconfigured");
    if (
      !matchesPinnedConfiguration(input.provider_configuration, pinned) ||
      input.environment !== pinned.environment
    )
      return errorResponse(422, "provider_rejected");
    return startResponse(input, source, ttl);
  }
  const poll = parsePoll(decoded, header, source);
  if (poll === null) return errorResponse(400, "invalid_request");
  if (!sessionMatchesPinned(poll, pinned)) return errorResponse(422, "provider_rejected");
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  return pollLegacy(poll, env, source, fetcher);
}

const app = {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};

export { app };
export default app;
