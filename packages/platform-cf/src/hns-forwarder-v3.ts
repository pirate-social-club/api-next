import {
  decodeHnsForwarderAuthorityHeader,
  encodeHnsForwarderAuthorityHeader,
  HNS_FORWARDER_AUTHORITY_HEADER,
  HNS_FORWARDER_BODY_SHA256_HEADER,
  HNS_FORWARDER_HOST_HEADER,
  HNS_FORWARDER_KEY_ID_HEADER,
  HNS_FORWARDER_NONCE_HEADER,
  HNS_FORWARDER_PATH_HEADER,
  HNS_FORWARDER_RESERVED_HEADERS,
  HNS_FORWARDER_SIGNATURE_HEADER,
  HNS_FORWARDER_TIMESTAMP_HEADER,
  type HnsForwarderHostAuthorityV1,
  type HnsForwarderV3PreimageInput,
  hnsForwarderV3Preimage,
  isCanonicalHnsForwarderHost,
  isHnsForwarderV3Signature,
} from "@pirate/application/hns-forwarder-v3";
import {
  type HnsForwarderGatewayAuthoritySourceV1,
  type HnsForwarderWorkerAuthoritySourceV1,
  type HnsHostAuthorityResolutionV1,
  hnsForwarderAuthorityMatchesState,
  resolveActiveHnsHostAuthority,
} from "@pirate/application/hns-host-serving";
import { Effect } from "effect";

export type { HnsForwarderWorkerAuthoritySourceV1 } from "@pirate/application/hns-host-serving";

export const HNS_FORWARDER_KEY_MIN_BYTES = 32 as const;
export const HNS_FORWARDER_BODY_LIMIT_MAX_BYTES = 16_777_216 as const;

export type HnsForwarderKeyRecordV1 = Readonly<{
  key_id: string;
  key_bytes: Uint8Array;
  signing_enabled: boolean;
  verify_not_before: number;
  verify_not_after: number;
}>;

export type HnsForwarderKeyRegistryV1 = Readonly<{
  signingKey: (nowSeconds: number) => HnsForwarderKeyRecordV1 | null;
  verificationKey: (keyId: string, nowSeconds: number) => HnsForwarderKeyRecordV1 | null;
}>;

export type HnsForwarderClockV1 = Readonly<{ nowUnixSeconds: () => number }>;
export type HnsForwarderNonceSourceV1 = Readonly<{ next: () => string }>;
export type HnsForwarderReplayStoreV1 = Readonly<{
  consume: (keyId: string, nonce: string) => Promise<boolean>;
}>;

export type HnsForwarderRuntimeLimitsV1 = Readonly<{
  max_body_bytes: number;
  freshness_window_seconds: number;
  future_clock_skew_seconds: number;
}>;

export type HnsForwarderGatewayInputV1 = Readonly<{
  method: string;
  normalized_host: string;
  path_and_query: string;
  headers: Headers;
  body_bytes: Uint8Array;
}>;

export type HnsForwarderGatewayEnvelopeV1 = Readonly<{
  headers: Headers;
  authority: HnsHostAuthorityResolutionV1;
  preimage: string;
}>;

export type HnsForwarderWorkerInputV1 = Readonly<{
  method: string;
  url: string;
  headers: Headers;
  body_bytes: Uint8Array;
}>;

export type HnsForwarderVerifiedRequestV1 = HnsHostAuthorityResolutionV1 &
  Readonly<{
    method: string;
    path_and_query: string;
    body_sha256: string;
    key_id: string;
    timestamp: string;
    nonce: string;
  }>;

export type HnsForwarderFailureReasonV1 =
  | "misconfigured"
  | "invalid_request"
  | "body_too_large"
  | "authority_unavailable"
  | "invalid_signature"
  | "stale"
  | "replayed";

export class HnsForwarderFailure extends Error {
  readonly name = "HnsForwarderFailure";
  constructor(readonly reason: HnsForwarderFailureReasonV1) {
    super(`HNS forwarder failed: ${reason}`);
  }
}

const encoder = new TextEncoder();
const keyIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const noncePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const timestampPattern = /^(?:0|[1-9][0-9]{0,19})$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);
const handleClientAuthorityHeaders = [
  "cookie",
  "authorization",
  "x-csrf-token",
  "x-xsrf-token",
] as const;

function validWholeNumber(value: unknown, allowZero: boolean): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0)
  );
}

function validateLimits(limits: HnsForwarderRuntimeLimitsV1): void {
  if (
    !validWholeNumber(limits.max_body_bytes, false) ||
    limits.max_body_bytes > HNS_FORWARDER_BODY_LIMIT_MAX_BYTES ||
    !validWholeNumber(limits.freshness_window_seconds, false) ||
    !validWholeNumber(limits.future_clock_skew_seconds, true)
  ) {
    throw new HnsForwarderFailure("misconfigured");
  }
}

function validateKey(record: HnsForwarderKeyRecordV1): boolean {
  return (
    keyIdPattern.test(record.key_id) &&
    record.key_bytes.byteLength >= HNS_FORWARDER_KEY_MIN_BYTES &&
    validWholeNumber(record.verify_not_before, true) &&
    validWholeNumber(record.verify_not_after, false) &&
    record.verify_not_after > record.verify_not_before
  );
}

export function makeStaticHnsForwarderKeyRegistryV1(
  records: readonly HnsForwarderKeyRecordV1[],
): HnsForwarderKeyRegistryV1 {
  if (
    records.length === 0 ||
    records.some((record) => !validateKey(record)) ||
    new Set(records.map((record) => record.key_id)).size !== records.length ||
    records.filter((record) => record.signing_enabled).length !== 1
  ) {
    throw new HnsForwarderFailure("misconfigured");
  }
  const retained = records.map((record) =>
    Object.freeze({ ...record, key_bytes: new Uint8Array(record.key_bytes) }),
  );
  const current = (record: HnsForwarderKeyRecordV1, now: number) =>
    now >= record.verify_not_before && now <= record.verify_not_after;
  return Object.freeze({
    signingKey: (now) =>
      retained.find((record) => record.signing_enabled && current(record, now)) ?? null,
    verificationKey: (keyId, now) =>
      retained.find((record) => record.key_id === keyId && current(record, now)) ?? null,
  });
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

async function importHmacKey(bytes: Uint8Array, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

async function signPreimage(keyBytes: Uint8Array, preimage: string): Promise<string> {
  const key = await importHmacKey(keyBytes, "sign");
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(preimage));
  return `v3=${hex(new Uint8Array(signature))}`;
}

function signatureBytes(signature: string): Uint8Array {
  if (!isHnsForwarderV3Signature(signature)) throw new HnsForwarderFailure("invalid_signature");
  const value = signature.slice(3);
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

async function verifyPreimage(
  keyBytes: Uint8Array,
  signature: string,
  preimage: string,
): Promise<boolean> {
  const key = await importHmacKey(keyBytes, "verify");
  return crypto.subtle.verify("HMAC", key, signatureBytes(signature), encoder.encode(preimage));
}

function requestPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    throw new HnsForwarderFailure("invalid_request");
  }
}

function readHeader(headers: Headers, name: string): string {
  const value = headers.get(name);
  if (value === null) throw new HnsForwarderFailure("invalid_request");
  return value;
}

function validateBody(body: Uint8Array, limits: HnsForwarderRuntimeLimitsV1): void {
  if (body.byteLength > limits.max_body_bytes) throw new HnsForwarderFailure("body_too_large");
}

function validateClock(clock: HnsForwarderClockV1): number {
  const now = clock.nowUnixSeconds();
  if (!validWholeNumber(now, true)) throw new HnsForwarderFailure("misconfigured");
  return now;
}

async function resolveAuthority(
  source: HnsForwarderGatewayAuthoritySourceV1 | HnsForwarderWorkerAuthoritySourceV1,
  normalizedHost: string,
): Promise<HnsHostAuthorityResolutionV1> {
  try {
    const state = await Effect.runPromise(source.resolve(normalizedHost));
    const resolution = resolveActiveHnsHostAuthority(state);
    if (resolution === null || resolution.normalized_host !== normalizedHost) {
      throw new HnsForwarderFailure("authority_unavailable");
    }
    return resolution;
  } catch (error) {
    if (error instanceof HnsForwarderFailure) throw error;
    throw new HnsForwarderFailure("authority_unavailable");
  }
}

function buildInput(
  input: Readonly<{
    key_id: string;
    timestamp: string;
    method: string;
    path_and_query: string;
    body_sha256: string;
    nonce: string;
  }>,
  authority: HnsHostAuthorityResolutionV1,
): HnsForwarderV3PreimageInput {
  return {
    ...input,
    normalized_host: authority.normalized_host,
    canonical_root: authority.canonical_root,
    community_id: authority.community_id,
    host_authority: authority.host_authority,
  };
}

export function makeHnsForwarderV3Gateway(
  options: Readonly<{
    authority_source: HnsForwarderGatewayAuthoritySourceV1;
    key_registry: HnsForwarderKeyRegistryV1;
    clock: HnsForwarderClockV1;
    nonce_source: HnsForwarderNonceSourceV1;
    limits: HnsForwarderRuntimeLimitsV1;
  }>,
) {
  validateLimits(options.limits);
  return Object.freeze({
    sign: async (input: HnsForwarderGatewayInputV1): Promise<HnsForwarderGatewayEnvelopeV1> => {
      validateBody(input.body_bytes, options.limits);
      if (!isCanonicalHnsForwarderHost(input.normalized_host)) {
        throw new HnsForwarderFailure("invalid_request");
      }
      const now = validateClock(options.clock);
      const key = options.key_registry.signingKey(now);
      if (key === null) throw new HnsForwarderFailure("misconfigured");
      const method = input.method.toUpperCase();
      const nonce = safeMethods.has(method) ? "" : options.nonce_source.next();
      if (nonce !== "" && !noncePattern.test(nonce)) {
        throw new HnsForwarderFailure("misconfigured");
      }
      const authority = await resolveAuthority(options.authority_source, input.normalized_host);
      const bodySha256 = await sha256(input.body_bytes);
      const timestamp = String(now);
      const preimageInput = buildInput(
        {
          key_id: key.key_id,
          timestamp,
          method,
          path_and_query: input.path_and_query,
          body_sha256: bodySha256,
          nonce,
        },
        authority,
      );
      let preimage: string;
      try {
        preimage = hnsForwarderV3Preimage(preimageInput);
      } catch {
        throw new HnsForwarderFailure("invalid_request");
      }
      const headers = new Headers(input.headers);
      for (const name of HNS_FORWARDER_RESERVED_HEADERS) headers.delete(name);
      if (authority.host_authority[0] === "handle_persona_v1") {
        for (const name of handleClientAuthorityHeaders) headers.delete(name);
      }
      headers.set(HNS_FORWARDER_HOST_HEADER, authority.normalized_host);
      headers.set(HNS_FORWARDER_KEY_ID_HEADER, key.key_id);
      headers.set(HNS_FORWARDER_TIMESTAMP_HEADER, timestamp);
      headers.set(HNS_FORWARDER_PATH_HEADER, input.path_and_query);
      headers.set(HNS_FORWARDER_BODY_SHA256_HEADER, bodySha256);
      headers.set(HNS_FORWARDER_NONCE_HEADER, nonce);
      headers.set(
        HNS_FORWARDER_AUTHORITY_HEADER,
        encodeHnsForwarderAuthorityHeader(authority.host_authority),
      );
      headers.set(HNS_FORWARDER_SIGNATURE_HEADER, await signPreimage(key.key_bytes, preimage));
      return { headers, authority, preimage };
    },
  });
}

export function makeHnsForwarderV3WorkerValidator(
  options: Readonly<{
    authority_source: HnsForwarderWorkerAuthoritySourceV1;
    key_registry: HnsForwarderKeyRegistryV1;
    replay_store: HnsForwarderReplayStoreV1;
    clock: HnsForwarderClockV1;
    limits: HnsForwarderRuntimeLimitsV1;
  }>,
) {
  validateLimits(options.limits);
  return Object.freeze({
    verify: async (input: HnsForwarderWorkerInputV1): Promise<HnsForwarderVerifiedRequestV1> => {
      validateBody(input.body_bytes, options.limits);
      const now = validateClock(options.clock);
      const normalizedHost = readHeader(input.headers, HNS_FORWARDER_HOST_HEADER);
      const keyId = readHeader(input.headers, HNS_FORWARDER_KEY_ID_HEADER);
      const timestamp = readHeader(input.headers, HNS_FORWARDER_TIMESTAMP_HEADER);
      const pathAndQuery = readHeader(input.headers, HNS_FORWARDER_PATH_HEADER);
      const bodySha256 = readHeader(input.headers, HNS_FORWARDER_BODY_SHA256_HEADER);
      const nonce = readHeader(input.headers, HNS_FORWARDER_NONCE_HEADER);
      const signature = readHeader(input.headers, HNS_FORWARDER_SIGNATURE_HEADER);
      const authorityHeader = readHeader(input.headers, HNS_FORWARDER_AUTHORITY_HEADER);
      if (
        !keyIdPattern.test(keyId) ||
        !timestampPattern.test(timestamp) ||
        !sha256Pattern.test(bodySha256) ||
        pathAndQuery !== requestPath(input.url)
      ) {
        throw new HnsForwarderFailure("invalid_request");
      }
      const timestampNumber = Number(timestamp);
      if (
        !Number.isSafeInteger(timestampNumber) ||
        timestampNumber < now - options.limits.freshness_window_seconds ||
        timestampNumber > now + options.limits.future_clock_skew_seconds
      ) {
        throw new HnsForwarderFailure("stale");
      }
      if (bodySha256 !== (await sha256(input.body_bytes))) {
        throw new HnsForwarderFailure("invalid_request");
      }
      let authority: HnsForwarderHostAuthorityV1;
      try {
        authority = decodeHnsForwarderAuthorityHeader(authorityHeader);
      } catch {
        throw new HnsForwarderFailure("invalid_request");
      }
      // V3 does not carry canonical_root or community_id in separate headers. A
      // source-closed lookup is therefore required to reconstruct the signed
      // preimage, but that lookup is never accepted as the authorization
      // decision. Current authority is resolved again only after the HMAC has
      // authenticated the envelope.
      const preimageAuthority = await resolveAuthority(options.authority_source, normalizedHost);
      const exactInput = buildInput(
        {
          key_id: keyId,
          timestamp,
          method: input.method,
          path_and_query: pathAndQuery,
          body_sha256: bodySha256,
          nonce,
        },
        preimageAuthority,
      );
      let preimage: string;
      try {
        preimage = hnsForwarderV3Preimage(exactInput);
      } catch {
        throw new HnsForwarderFailure("invalid_request");
      }
      const key = options.key_registry.verificationKey(keyId, now);
      if (key === null || !(await verifyPreimage(key.key_bytes, signature, preimage))) {
        throw new HnsForwarderFailure("invalid_signature");
      }
      const current = await resolveAuthority(options.authority_source, normalizedHost);
      if (
        !hnsForwarderAuthorityMatchesState(preimageAuthority.host_authority, current.state) ||
        preimageAuthority.community_id !== current.community_id ||
        preimageAuthority.canonical_root !== current.canonical_root
      ) {
        throw new HnsForwarderFailure("authority_unavailable");
      }
      if (!hnsForwarderAuthorityMatchesState(authority, current.state)) {
        throw new HnsForwarderFailure("authority_unavailable");
      }
      if (!safeMethods.has(input.method)) {
        if (!(await options.replay_store.consume(keyId, nonce))) {
          throw new HnsForwarderFailure("replayed");
        }
      }
      return {
        ...current,
        method: input.method,
        path_and_query: pathAndQuery,
        body_sha256: bodySha256,
        key_id: keyId,
        timestamp,
        nonce,
      };
    },
  });
}
