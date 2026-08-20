import { validCommunityRouteRoot } from "@pirate/domain";
import { Sha256Hex, type Sha256Hex as Sha256HexValue } from "@pirate/domain/verification";
import { Option, Schema } from "effect";
import { NamespaceOwnershipRoute, NamespaceOwnershipUpstreamSessionReference } from "./adapter.ts";

export const HNS_OWNER_PROVIDER_ID = "hns.owner.v1" as const;
export const HNS_OWNER_MANIFEST_VERSION = "1" as const;
export const HNS_OWNER_PROTOCOL_VERSION = "hns-txt-v1" as const;
export const HNS_OWNER_IDENTITY_PREIMAGE_VERSION = "pirate-hns-provider-identity-v1" as const;
export const HNS_OWNER_REQUEST_PREIMAGE_VERSION = "pirate-namespace-start-v1" as const;
export const HNS_OWNER_EVIDENCE_PREIMAGE_VERSION = "pirate-hns-ownership-evidence-v1" as const;
export const HNS_OWNER_MAX_RESPONSE_BYTES = 1_048_576 as const;

export const HNS_OWNER_ACTOR_MAX_BYTES = 256 as const;
export const HNS_OWNER_INTENT_MAX_BYTES = 256 as const;
export const HNS_OWNER_CEREMONY_MAX_BYTES = 256 as const;
export const HNS_OWNER_PROVIDER_ID_MAX_BYTES = 256 as const;
export const HNS_OWNER_CONFIGURATION_KIND_MAX_BYTES = 256 as const;
export const HNS_OWNER_CONFIGURATION_VERSION_MAX_BYTES = 256 as const;
export const HNS_OWNER_PROTOCOL_MAX_BYTES = 256 as const;
export const HNS_OWNER_ENVIRONMENT_MAX_BYTES = 256 as const;
export const HNS_OWNER_SOURCE_MAX_BYTES = 256 as const;
export const HNS_OWNER_CHAIN_NETWORK_MAX_BYTES = 256 as const;
export const HNS_OWNER_CONFIGURATION_REFERENCE_MAX_BYTES = 512 as const;
export const HNS_OWNER_EVIDENCE_REFERENCE_MAX_BYTES = 512 as const;
export const HNS_OWNER_UPSTREAM_SESSION_REFERENCE_MAX_BYTES = 16_384 as const;
export const HNS_OWNER_CHALLENGE_NAME_MAX_BYTES = 255 as const;

const exactParseOptions = { onExcessProperty: "error" } as const;

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isSafeIdentifier(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) return false;
  }
  return true;
}

function boundedString(maxBytes: number, label: string) {
  return Schema.NonEmptyString.check(
    Schema.makeFilter((value) =>
      value.trim() === value && isSafeIdentifier(value) && utf8Length(value) <= maxBytes
        ? undefined
        : `Expected ${label} to be a bounded canonical UTF-8 value`,
    ),
  );
}

const ActorId = boundedString(HNS_OWNER_ACTOR_MAX_BYTES, "actor_id");
const IntentId = boundedString(HNS_OWNER_INTENT_MAX_BYTES, "creation_intent_id");
const CeremonyId = boundedString(HNS_OWNER_CEREMONY_MAX_BYTES, "ceremony_intent_id");
const ProviderId = boundedString(HNS_OWNER_PROVIDER_ID_MAX_BYTES, "provider_id");
const ConfigurationVersion = boundedString(
  HNS_OWNER_CONFIGURATION_VERSION_MAX_BYTES,
  "provider_configuration_version",
);
const ProtocolVersion = boundedString(HNS_OWNER_PROTOCOL_MAX_BYTES, "protocol_version");
const Environment = boundedString(HNS_OWNER_ENVIRONMENT_MAX_BYTES, "environment");
const OwnershipSource = Schema.Literals(["hns_parent_chain_txt", "owner_authoritative_dns_txt"]);
const ChainNetwork = boundedString(HNS_OWNER_CHAIN_NETWORK_MAX_BYTES, "chain_network");
const ProviderConfigurationReference = boundedString(
  HNS_OWNER_CONFIGURATION_REFERENCE_MAX_BYTES,
  "provider_configuration_reference",
);
const EvidenceReference = boundedString(
  HNS_OWNER_EVIDENCE_REFERENCE_MAX_BYTES,
  "evidence_reference",
);
const UpstreamSessionReference = boundedString(
  HNS_OWNER_UPSTREAM_SESSION_REFERENCE_MAX_BYTES,
  "upstream_session_ref",
);
const ChallengeName = boundedString(HNS_OWNER_CHALLENGE_NAME_MAX_BYTES, "challenge_name");
const ChallengeValue = boundedString(
  HNS_OWNER_UPSTREAM_SESSION_REFERENCE_MAX_BYTES + 64,
  "challenge_value",
);
const CanonicalIsoInstant = Schema.String.check(
  Schema.makeFilter((value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
      ? undefined
      : "Expected a canonical UTC ISO instant";
  }),
);
const PositiveSafeInteger = Schema.Int.check(
  Schema.makeFilter((value) =>
    Number.isSafeInteger(value) && value > 0 ? undefined : "Expected a positive safe integer",
  ),
);

export type HnsOwnerRoute = Schema.Schema.Type<typeof NamespaceOwnershipRoute>;

/** The strict semantic body returned by the target-owned HNS verifier. */
const HnsOwnerVerifiedObservation = Schema.Struct({
  status: Schema.Literal("verified"),
  provider_evidence_ref: EvidenceReference,
  upstream_session_ref: UpstreamSessionReference,
  ownership_source: OwnershipSource,
  challenge_name: ChallengeName,
  challenge_value: ChallengeValue,
  root_exists: Schema.Literal(true),
  root_control_verified: Schema.Literal(true),
  expiry_horizon_sufficient: Schema.Literal(true),
  chain_network: ChainNetwork,
  chain_anchor_height: PositiveSafeInteger,
  chain_anchor_block_hash: Sha256Hex,
  chain_anchor_median_time: PositiveSafeInteger,
  expiry_height: PositiveSafeInteger,
  observed_at: CanonicalIsoInstant,
  expires_at: CanonicalIsoInstant,
});
export type HnsOwnerVerifiedObservation = Schema.Schema.Type<typeof HnsOwnerVerifiedObservation>;

const HnsOwnerPendingObservation = Schema.Struct({ status: Schema.Literal("pending") });
const HnsOwnerResponse = Schema.Union([HnsOwnerPendingObservation, HnsOwnerVerifiedObservation]);
export type HnsOwnerResponse = Schema.Schema.Type<typeof HnsOwnerResponse>;

const HnsEvidenceConfiguration = Schema.Struct({
  kind: Schema.Literals(["managed", "dynamic"]),
  reference: ProviderConfigurationReference,
  version: ConfigurationVersion,
});

const HnsProviderIdentityInputSchema = Schema.Struct({
  provider_id: ProviderId,
  provider_configuration_kind: Schema.Literals(["managed", "dynamic"]),
  provider_configuration_reference: ProviderConfigurationReference,
  provider_configuration_version: ConfigurationVersion,
  protocol_version: ProtocolVersion,
  root_label: boundedString(63, "root_label").check(
    Schema.makeFilter((value) =>
      validCommunityRouteRoot("hns", value) ? undefined : "Expected a canonical HNS root label",
    ),
  ),
});

const HnsNamespaceStartInputSchema = Schema.Struct({
  actor_id: ActorId,
  creation_intent_id: IntentId,
  ceremony_intent_id: CeremonyId,
  requirement_hash: Sha256Hex,
  generation: PositiveSafeInteger,
  provider_id: ProviderId,
  provider_binding_hash: Sha256Hex,
  provider_configuration: HnsEvidenceConfiguration,
  protocol_version: ProtocolVersion,
  environment: Environment,
  route: NamespaceOwnershipRoute,
});

const HnsOwnershipEvidencePreimageInputSchema = Schema.Struct({
  actor_id: ActorId,
  creation_intent_id: IntentId,
  ceremony_intent_id: CeremonyId,
  requirement_hash: Sha256Hex,
  generation: PositiveSafeInteger,
  provider_id: ProviderId,
  provider_binding_hash: Sha256Hex,
  provider_configuration: HnsEvidenceConfiguration,
  protocol_version: ProtocolVersion,
  environment: Environment,
  route: NamespaceOwnershipRoute,
  request_hash: Sha256Hex,
  upstream_session_ref: UpstreamSessionReference,
  ownership_source: OwnershipSource,
  challenge_name: ChallengeName,
  root_exists: Schema.Literal(true),
  root_control_verified: Schema.Literal(true),
  expiry_horizon_sufficient: Schema.Literal(true),
  chain_network: ChainNetwork,
  chain_anchor_height: PositiveSafeInteger,
  chain_anchor_block_hash: Sha256Hex,
  chain_anchor_median_time: PositiveSafeInteger,
  expiry_height: PositiveSafeInteger,
  observed_at: CanonicalIsoInstant,
  expires_at: CanonicalIsoInstant,
  evidence_ref: EvidenceReference,
  provider_evidence_ref: EvidenceReference,
  observation_sha256: Sha256Hex,
  provider_identity_digest: Sha256Hex,
  challenge_value_sha256: Sha256Hex,
});

const HnsOwnershipEvidenceInputSchema = Schema.Struct({
  actor_id: ActorId,
  creation_intent_id: IntentId,
  ceremony_intent_id: CeremonyId,
  requirement_hash: Sha256Hex,
  generation: PositiveSafeInteger,
  provider_id: ProviderId,
  provider_binding_hash: Sha256Hex,
  provider_configuration: HnsEvidenceConfiguration,
  protocol_version: ProtocolVersion,
  environment: Environment,
  route: NamespaceOwnershipRoute,
  request_hash: Sha256Hex,
  upstream_session_ref: UpstreamSessionReference,
  evidence_ref: EvidenceReference,
  raw_response_bytes: Schema.Uint8Array.check(
    Schema.makeFilter((value) =>
      value.byteLength > 0 && value.byteLength <= HNS_OWNER_MAX_RESPONSE_BYTES
        ? undefined
        : "Expected non-empty HNS response bytes no larger than 1 MiB",
    ),
  ),
});

export type HnsOwnerRawResponse = Readonly<{
  readonly response_bytes: Uint8Array;
  readonly response: HnsOwnerResponse;
}>;

export class HnsOwnerResponseDecodeError extends Error {
  readonly _tag = "HnsOwnerResponseDecodeError" as const;

  constructor(message: string) {
    super(message);
    this.name = "HnsOwnerResponseDecodeError";
  }
}

function assertNoDuplicateJsonObjectKeys(text: string): void {
  let cursor = 0;

  const skipWhitespace = () => {
    while (/\s/u.test(text[cursor] ?? "")) cursor += 1;
  };
  const parseString = (): string => {
    const start = cursor;
    cursor += 1;
    while (cursor < text.length) {
      const character = text[cursor];
      cursor += 1;
      if (character === '"') return JSON.parse(text.slice(start, cursor)) as string;
      if (character === "\\") {
        const escapeCode = text[cursor];
        cursor += 1;
        if (escapeCode === "u") cursor += 4;
      }
    }
    throw new SyntaxError("Unterminated JSON string");
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
        const key = parseString();
        if (keys.has(key)) throw new SyntaxError("Duplicate JSON object member");
        keys.add(key);
        skipWhitespace();
        cursor += 1;
        parseValue();
        skipWhitespace();
        if (text[cursor] === "}") {
          cursor += 1;
          return;
        }
        cursor += 1;
        skipWhitespace();
      }
      return;
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
        cursor += 1;
      }
      return;
    }
    if (token === '"') {
      parseString();
      return;
    }
    while (cursor < text.length && !/[\s,\]}]/u.test(text[cursor] ?? "")) cursor += 1;
  };

  parseValue();
  skipWhitespace();
  if (cursor !== text.length) throw new SyntaxError("Trailing JSON content");
}

/**
 * Decode exactly the bytes returned by the injected transport.  The returned
 * copy is the immutable-snapshot input; callers must not replace it with a
 * re-serialized semantic object.
 */
export function decodeHnsOwnerResponseBytes(value: unknown): HnsOwnerRawResponse {
  if (!(value instanceof Uint8Array)) {
    throw new HnsOwnerResponseDecodeError("HNS provider response must be Uint8Array bytes");
  }
  if (value.byteLength > HNS_OWNER_MAX_RESPONSE_BYTES) {
    throw new HnsOwnerResponseDecodeError("HNS provider response exceeds the 1 MiB byte bound");
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(value);
  } catch {
    throw new HnsOwnerResponseDecodeError("HNS provider response is not valid UTF-8");
  }

  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
    assertNoDuplicateJsonObjectKeys(text);
  } catch {
    throw new HnsOwnerResponseDecodeError(
      "HNS provider response is invalid JSON or contains duplicate object members",
    );
  }

  const response = Schema.decodeUnknownOption(HnsOwnerResponse, exactParseOptions)(json);
  if (Option.isNone(response)) {
    throw new HnsOwnerResponseDecodeError("HNS provider response failed its strict schema");
  }
  return { response_bytes: new Uint8Array(value), response: response.value };
}

export function hnsOwnerChallengeValue(upstream_session_ref: string): string {
  const decoded = Schema.decodeUnknownSync(
    NamespaceOwnershipUpstreamSessionReference,
    exactParseOptions,
  )(upstream_session_ref);
  return `pirate-verification=${decoded}`;
}

function sha256Bytes(bytes: Uint8Array): Promise<Sha256HexValue> {
  return crypto.subtle.digest("SHA-256", bytes).then((digest) => {
    const hex = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return Schema.decodeUnknownSync(Sha256Hex)(hex);
  });
}

export function sha256Utf8(value: string): Promise<Sha256HexValue> {
  return sha256Bytes(new TextEncoder().encode(value));
}

export function hnsOwnerChallengeValueSha256(
  upstream_session_ref: string,
): Promise<Sha256HexValue> {
  return sha256Utf8(hnsOwnerChallengeValue(upstream_session_ref));
}

export type HnsProviderIdentityInput = Schema.Schema.Type<typeof HnsProviderIdentityInputSchema>;

export function hnsProviderIdentityPreimage(input: HnsProviderIdentityInput): string {
  const decoded = Schema.decodeUnknownSync(
    HnsProviderIdentityInputSchema,
    exactParseOptions,
  )(input);
  if (decoded.provider_id !== HNS_OWNER_PROVIDER_ID) {
    throw new TypeError("HNS provider identity must use hns.owner.v1");
  }
  return JSON.stringify([
    HNS_OWNER_IDENTITY_PREIMAGE_VERSION,
    decoded.provider_id,
    decoded.provider_configuration_kind,
    decoded.provider_configuration_reference,
    decoded.provider_configuration_version,
    decoded.protocol_version,
    "hns",
    decoded.root_label,
  ]);
}

export function hnsProviderIdentityDigest(
  input: HnsProviderIdentityInput,
): Promise<Sha256HexValue> {
  return sha256Utf8(hnsProviderIdentityPreimage(input));
}

export type HnsNamespaceStartInput = Schema.Schema.Type<typeof HnsNamespaceStartInputSchema>;

function assertHnsStartInput(input: HnsNamespaceStartInput): void {
  if (
    input.provider_id !== HNS_OWNER_PROVIDER_ID ||
    input.route.family !== "hns" ||
    input.route.app_host !== null
  ) {
    throw new TypeError("HNS start input must use hns.owner.v1 and an ownership-only HNS route");
  }
}

export function hnsNamespaceStartPreimage(input: HnsNamespaceStartInput): string {
  const decoded = Schema.decodeUnknownSync(HnsNamespaceStartInputSchema, exactParseOptions)(input);
  assertHnsStartInput(decoded);
  return JSON.stringify([
    HNS_OWNER_REQUEST_PREIMAGE_VERSION,
    decoded.actor_id,
    decoded.creation_intent_id,
    decoded.ceremony_intent_id,
    "namespace_ownership",
    decoded.requirement_hash,
    decoded.generation,
    decoded.provider_id,
    decoded.provider_binding_hash,
    decoded.provider_configuration.kind,
    decoded.provider_configuration.reference,
    decoded.provider_configuration.version,
    decoded.protocol_version,
    decoded.environment,
    "hns",
    decoded.route.root_label,
    decoded.route.root_label_display,
    decoded.route.path_segment,
  ]);
}

export function hnsNamespaceStartHash(input: HnsNamespaceStartInput): Promise<Sha256HexValue> {
  return sha256Utf8(hnsNamespaceStartPreimage(input));
}

export type HnsOwnershipEvidenceInput = Schema.Schema.Type<typeof HnsOwnershipEvidenceInputSchema>;

export type HnsOwnershipEvidencePreimageInput = Schema.Schema.Type<
  typeof HnsOwnershipEvidencePreimageInputSchema
>;

export function hnsOwnershipEvidencePreimage(input: HnsOwnershipEvidencePreimageInput): string {
  const decoded = Schema.decodeUnknownSync(
    HnsOwnershipEvidencePreimageInputSchema,
    exactParseOptions,
  )(input);
  assertHnsStartInput(decoded);
  return JSON.stringify([
    HNS_OWNER_EVIDENCE_PREIMAGE_VERSION,
    decoded.actor_id,
    decoded.creation_intent_id,
    "namespace_ownership",
    decoded.requirement_hash,
    decoded.ceremony_intent_id,
    decoded.generation,
    decoded.request_hash,
    decoded.provider_id,
    decoded.provider_binding_hash,
    decoded.provider_configuration.kind,
    decoded.provider_configuration.reference,
    decoded.provider_configuration.version,
    decoded.protocol_version,
    decoded.environment,
    "hns",
    decoded.route.root_label,
    decoded.route.root_label_display,
    decoded.route.path_segment,
    decoded.upstream_session_ref,
    decoded.ownership_source,
    decoded.challenge_name,
    decoded.challenge_value_sha256,
    decoded.root_exists,
    decoded.root_control_verified,
    decoded.expiry_horizon_sufficient,
    decoded.chain_network,
    decoded.chain_anchor_height,
    decoded.chain_anchor_block_hash,
    decoded.chain_anchor_median_time,
    decoded.expiry_height,
    decoded.observed_at,
    decoded.expires_at,
    decoded.evidence_ref,
    decoded.provider_evidence_ref,
    decoded.observation_sha256,
    decoded.provider_identity_digest,
  ]);
}

export type HnsOwnershipEvidenceEnvelope = Readonly<{
  readonly version: "pirate-hns-ownership-evidence-v1";
  readonly actor_id: string;
  readonly creation_intent_id: string;
  readonly requirement: "namespace_ownership";
  readonly requirement_hash: Sha256HexValue;
  readonly ceremony_intent_id: string;
  readonly generation: number;
  readonly request_hash: Sha256HexValue;
  readonly provider_id: string;
  readonly provider_binding_hash: Sha256HexValue;
  readonly provider_configuration_kind: "managed" | "dynamic";
  readonly provider_configuration_reference: string;
  readonly provider_configuration_version: string;
  readonly protocol_version: string;
  readonly environment: string;
  readonly family: "hns";
  readonly root_label: string;
  readonly root_label_display: string;
  readonly path_segment: string;
  readonly upstream_session_ref: string;
  readonly ownership_source: HnsOwnerVerifiedObservation["ownership_source"];
  readonly challenge_name: string;
  readonly challenge_value_sha256: Sha256HexValue;
  readonly root_exists: true;
  readonly root_control_verified: true;
  readonly expiry_horizon_sufficient: true;
  readonly chain_network: string;
  readonly chain_anchor_height: number;
  readonly chain_anchor_block_hash: Sha256HexValue;
  readonly chain_anchor_median_time: number;
  readonly expiry_height: number;
  readonly observed_at: string;
  readonly expires_at: string;
  readonly evidence_ref: string;
  readonly provider_evidence_ref: string;
  readonly observation_sha256: Sha256HexValue;
  readonly provider_identity_digest: Sha256HexValue;
  readonly evidence_digest: Sha256HexValue;
}>;

export async function buildHnsOwnershipEvidence(
  input: HnsOwnershipEvidenceInput,
): Promise<HnsOwnershipEvidenceEnvelope> {
  const decodedInput = Schema.decodeUnknownSync(
    HnsOwnershipEvidenceInputSchema,
    exactParseOptions,
  )(input);
  const rawResponse = decodeHnsOwnerResponseBytes(decodedInput.raw_response_bytes);
  if (rawResponse.response.status !== "verified") {
    throw new TypeError("Pending HNS observations cannot produce ownership evidence");
  }
  const observation = rawResponse.response;
  if (decodedInput.provider_id !== HNS_OWNER_PROVIDER_ID || decodedInput.route.family !== "hns") {
    throw new TypeError("HNS ownership evidence must use hns.owner.v1 and an HNS route");
  }
  if (decodedInput.route.app_host !== null) {
    throw new TypeError("HNS ownership evidence cannot authorize an application host");
  }
  if (Date.parse(observation.expires_at) <= Date.parse(observation.observed_at)) {
    throw new TypeError("HNS ownership evidence must expire after observation");
  }
  if (
    observation.upstream_session_ref !== decodedInput.upstream_session_ref ||
    observation.challenge_name !== `_pirate.${decodedInput.route.root_label}` ||
    observation.challenge_value !== hnsOwnerChallengeValue(decodedInput.upstream_session_ref)
  ) {
    throw new TypeError("HNS challenge name is not bound to the requested root");
  }
  const expectedRequestHash = await hnsNamespaceStartHash({
    actor_id: decodedInput.actor_id,
    creation_intent_id: decodedInput.creation_intent_id,
    ceremony_intent_id: decodedInput.ceremony_intent_id,
    requirement_hash: decodedInput.requirement_hash,
    generation: decodedInput.generation,
    provider_id: decodedInput.provider_id,
    provider_binding_hash: decodedInput.provider_binding_hash,
    provider_configuration: decodedInput.provider_configuration,
    protocol_version: decodedInput.protocol_version,
    environment: decodedInput.environment,
    route: decodedInput.route,
  });
  if (decodedInput.request_hash !== expectedRequestHash) {
    throw new TypeError("HNS start request hash does not match the bound session input");
  }
  const observation_sha256 = await sha256Bytes(rawResponse.response_bytes);
  const provider_identity_digest = await hnsProviderIdentityDigest({
    provider_id: decodedInput.provider_id,
    provider_configuration_kind: decodedInput.provider_configuration.kind,
    provider_configuration_reference: decodedInput.provider_configuration.reference,
    provider_configuration_version: decodedInput.provider_configuration.version,
    protocol_version: decodedInput.protocol_version,
    root_label: decodedInput.route.root_label,
  });
  const challenge_value_sha256 = await hnsOwnerChallengeValueSha256(
    decodedInput.upstream_session_ref,
  );
  const evidenceInput: HnsOwnershipEvidencePreimageInput = {
    actor_id: decodedInput.actor_id,
    creation_intent_id: decodedInput.creation_intent_id,
    ceremony_intent_id: decodedInput.ceremony_intent_id,
    requirement_hash: decodedInput.requirement_hash,
    generation: decodedInput.generation,
    provider_id: decodedInput.provider_id,
    provider_binding_hash: decodedInput.provider_binding_hash,
    provider_configuration: decodedInput.provider_configuration,
    protocol_version: decodedInput.protocol_version,
    environment: decodedInput.environment,
    route: decodedInput.route,
    request_hash: decodedInput.request_hash,
    upstream_session_ref: observation.upstream_session_ref,
    ownership_source: observation.ownership_source,
    challenge_name: observation.challenge_name,
    root_exists: observation.root_exists,
    root_control_verified: observation.root_control_verified,
    expiry_horizon_sufficient: observation.expiry_horizon_sufficient,
    chain_network: observation.chain_network,
    chain_anchor_height: observation.chain_anchor_height,
    chain_anchor_block_hash: observation.chain_anchor_block_hash,
    chain_anchor_median_time: observation.chain_anchor_median_time,
    expiry_height: observation.expiry_height,
    observed_at: observation.observed_at,
    expires_at: observation.expires_at,
    evidence_ref: decodedInput.evidence_ref,
    provider_evidence_ref: observation.provider_evidence_ref,
    observation_sha256,
    provider_identity_digest,
    challenge_value_sha256,
  };
  const evidence_preimage = hnsOwnershipEvidencePreimage(evidenceInput);
  const evidence_digest = await sha256Utf8(evidence_preimage);
  return {
    version: HNS_OWNER_EVIDENCE_PREIMAGE_VERSION,
    actor_id: decodedInput.actor_id,
    creation_intent_id: decodedInput.creation_intent_id,
    requirement: "namespace_ownership",
    requirement_hash: decodedInput.requirement_hash,
    ceremony_intent_id: decodedInput.ceremony_intent_id,
    generation: decodedInput.generation,
    request_hash: decodedInput.request_hash,
    provider_id: decodedInput.provider_id,
    provider_binding_hash: decodedInput.provider_binding_hash,
    provider_configuration_kind: decodedInput.provider_configuration.kind,
    provider_configuration_reference: decodedInput.provider_configuration.reference,
    provider_configuration_version: decodedInput.provider_configuration.version,
    protocol_version: decodedInput.protocol_version,
    environment: decodedInput.environment,
    family: "hns",
    root_label: decodedInput.route.root_label,
    root_label_display: decodedInput.route.root_label_display,
    path_segment: decodedInput.route.path_segment,
    upstream_session_ref: observation.upstream_session_ref,
    ownership_source: observation.ownership_source,
    challenge_name: observation.challenge_name,
    challenge_value_sha256,
    root_exists: true,
    root_control_verified: true,
    expiry_horizon_sufficient: true,
    chain_network: observation.chain_network,
    chain_anchor_height: observation.chain_anchor_height,
    chain_anchor_block_hash: observation.chain_anchor_block_hash,
    chain_anchor_median_time: observation.chain_anchor_median_time,
    expiry_height: observation.expiry_height,
    observed_at: observation.observed_at,
    expires_at: observation.expires_at,
    evidence_ref: decodedInput.evidence_ref,
    provider_evidence_ref: observation.provider_evidence_ref,
    observation_sha256,
    provider_identity_digest,
    evidence_digest,
  };
}
