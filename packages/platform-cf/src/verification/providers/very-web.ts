import {
  type ProviderSessionStart,
  type VerificationProviderAdapter,
  type VerificationProviderCompleteInput,
  type VerificationProviderFailure,
  VerificationProviderInvalidResponse,
  VerificationProviderMisconfigured,
  type VerificationProviderPlanInput,
  VerificationProviderRejected,
  type VerificationProviderStartInput,
  VerificationProviderUnavailable,
  VerificationProviderUnboundRejected,
} from "@pirate/application/verification";
import {
  type Assertion,
  type CanonicalClaimIdentifier,
  type CanonicalIsoInstant,
  type EvidenceBundle,
  type ProofProviderManifest,
  type ProofSession,
  type ProviderConfigurationRef,
  Sha256Hex,
  type SubjectScope,
  type VerificationRequirement,
} from "@pirate/domain/verification";
import { DateTime, Effect, Option, Schema } from "effect";

export const VERY_WEB_PROVIDER_ID = "very.web" as const;
export const VERY_WEB_PROTOCOL_VERSION = "very-web-v1" as const;
export const VERY_WEB_METHOD = "palm_web" as const;
export const VERY_WEB_RP_SCOPE = "pirate-social" as const;
export const VERY_WEB_ISSUER = "https://verify.very.org" as const;
export const VERY_WEB_CONFIGURATION_REFERENCE = "very-web" as const;
export const VERY_WEB_CONFIGURATION_VERSION = "1" as const;
export const VERY_WEB_EVIDENCE_KIND = "very.web.server-verified.v1" as const;
export const VERY_WEB_HTTP_TIMEOUT_MS = 15_000 as const;
export const VERY_WEB_SESSION_TTL_SECONDS = 300 as const;
export const VERY_WEB_MAX_RESPONSE_BYTES = 1_048_576 as const;
export const VERY_WEB_MAX_SEALED_SESSION_REF_CHARS = 16_384 as const;
const VERY_WEB_CURATED_POLICY_VERSION = "curated-human-membership-v1" as const;

const VERY_WEB_CLAIMS = [
  "human.personhood",
  "credential.subject_unique",
] as const satisfies readonly CanonicalClaimIdentifier[];

type VeryWebPurpose = NonNullable<VerificationProviderStartInput["verification_purpose"]>;
type VeryWebIntentType = VeryWebPurpose["intent"];

const VERY_WEB_PURPOSE_LABELS: Readonly<Record<VeryWebIntentType, string>> = {
  community_creation: "Community Creation",
  community_join: "Community Join",
  post_create: "Post Create",
  comment_create: "Comment Create",
  post_access_18_plus: "18+ Post Access",
  commerce_pricing: "Commerce Pricing",
  qualifier_disclosure: "Qualifier Disclosure",
  profile_verification: "Profile Verification",
};

export const VERY_WEB_MANIFEST: ProofProviderManifest = {
  provider_id: VERY_WEB_PROVIDER_ID,
  manifest_version: "1",
  operation_deadlines: {
    plan_ms: 1_000,
    start_ms: 15_000,
    complete_ms: 50_000,
    callback_ms: 1_000,
  },
  callback_mode: "none",
  callback_header_allowlist: [],
  protocol_versions: [VERY_WEB_PROTOCOL_VERSION],
  environments: ["test", "development", "staging", "production"],
  supported_methods: [VERY_WEB_METHOD],
  claim_ids: [...VERY_WEB_CLAIMS],
  claim_capabilities: VERY_WEB_CLAIMS.map((claim_id) => ({
    claim_id,
    request_modes: ["dynamic" as const],
  })),
  presentation_kinds: ["embedded_sdk"],
  assurance_levels: ["provider_attested"],
  subject_key_scope_semantics: "issuer_rp_scope",
};

export type VeryWebClock = Readonly<{
  readonly now: () => CanonicalIsoInstant;
  readonly expiresAt: (now: CanonicalIsoInstant) => CanonicalIsoInstant;
}>;

export type VeryWebIdentifierKind =
  | "session"
  | "bundle"
  | "receipt"
  | "subject"
  | "binding"
  | "assertion";

export type VeryWebIdentifiers = Readonly<{
  readonly next: (kind: VeryWebIdentifierKind) => string;
}>;

export type VeryWebRandomness = Readonly<{
  readonly bytes: (length: number) => Uint8Array;
}>;

export type VeryWebDigest = Readonly<{
  readonly digest: (value: string) => Effect.Effect<string, VerificationProviderFailure>;
}>;

export type VeryWebTransportResponse = Readonly<{
  readonly status: number;
  readonly body: unknown;
}>;

export type VeryWebTransport = Readonly<{
  readonly createBridge: (
    input: Readonly<{
      readonly url: string;
      readonly body: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly timeout_ms: number;
    }>,
  ) => Effect.Effect<VeryWebTransportResponse, VerificationProviderFailure>;
  readonly bridgeStatus: (
    input: Readonly<{
      readonly url: string;
      readonly session_id: string;
      readonly timeout_ms: number;
    }>,
  ) => Effect.Effect<VeryWebTransportResponse, VerificationProviderFailure>;
  readonly verify: (
    input: Readonly<{
      readonly url: string;
      readonly proof: string;
      readonly timeout_ms: number;
    }>,
  ) => Effect.Effect<VeryWebTransportResponse, VerificationProviderFailure>;
}>;

export type VeryWebAdapterOptions = Readonly<{
  readonly app_id: string;
  readonly api_url: string;
  readonly verify_url: string;
  readonly bridge_api_url: string;
  /** Exactly 32 bytes. The server owns this key; the browser never supplies it. */
  readonly sealing_key: Uint8Array;
  readonly transport: VeryWebTransport;
  readonly clock: VeryWebClock;
  readonly identifiers: VeryWebIdentifiers;
  readonly randomness: VeryWebRandomness;
  readonly digest: VeryWebDigest;
}>;

type SealedSession = Readonly<{
  version: 1;
  proof_session_id: string;
  actor_id: string;
  intent_id: string;
  request_hash: string;
  issued_at: string;
  expires_at: string;
  bridge_session_id: string;
  bridge_key: string;
  binding_value: string;
}>;

type ClientSubmission = Readonly<{ mode: "widget"; proof: string }> | Readonly<{ mode: "bridge" }>;

const SESSION_AAD = "pirate-api-next/very.web/session/v1";
const SESSION_PREFIX = "very.web.v1";

function invalid(operation: "plan" | "start" | "complete") {
  return new VerificationProviderInvalidResponse({ provider_id: VERY_WEB_PROVIDER_ID, operation });
}

function rejected(operation: "start" | "complete") {
  return new VerificationProviderRejected({ provider_id: VERY_WEB_PROVIDER_ID, operation });
}

function unavailable(operation: "start" | "complete") {
  return new VerificationProviderUnavailable({ provider_id: VERY_WEB_PROVIDER_ID, operation });
}

function unbound() {
  return new VerificationProviderUnboundRejected({
    provider_id: VERY_WEB_PROVIDER_ID,
    operation: "complete",
  });
}

function misconfigured(operation: "plan" | "start" | "complete") {
  return new VerificationProviderMisconfigured({ provider_id: VERY_WEB_PROVIDER_ID, operation });
}

function sameConfiguration(
  left: ProviderConfigurationRef,
  right: ProviderConfigurationRef,
): boolean {
  return (
    left.kind === right.kind && left.reference === right.reference && left.version === right.version
  );
}

function sameScope(left: SubjectScope, right: SubjectScope): boolean {
  return (
    left.kind === "named" &&
    right.kind === "named" &&
    left.scope_semantics === "issuer_rp_scope" &&
    right.scope_semantics === "issuer_rp_scope" &&
    left.issuer === right.issuer &&
    left.rp_scope === right.rp_scope
  );
}

function claimIds(
  requirements: readonly VerificationRequirement[],
): readonly CanonicalClaimIdentifier[] {
  return requirements.map((requirement) => requirement.claim_id);
}

function exactClaims(
  requirements: readonly VerificationRequirement[],
  ids: readonly CanonicalClaimIdentifier[],
): boolean {
  return (
    requirements.length === VERY_WEB_CLAIMS.length &&
    JSON.stringify(claimIds(requirements)) === JSON.stringify(ids) &&
    new Set(ids).size === VERY_WEB_CLAIMS.length &&
    VERY_WEB_CLAIMS.every((claim) => ids.includes(claim))
  );
}

function externalNullifier(purpose: VeryWebPurpose): string {
  const label = VERY_WEB_PURPOSE_LABELS[purpose.intent];
  return purpose.policy_id === undefined
    ? `Pirate - ${label}`
    : `Pirate - ${label} - ${purpose.policy_id}`;
}

function purposeSupported(purpose: VeryWebPurpose | undefined): boolean {
  return (
    purpose !== undefined &&
    VERY_WEB_PURPOSE_LABELS[purpose.intent] !== undefined &&
    (purpose.policy_id === undefined || purpose.policy_id === VERY_WEB_CURATED_POLICY_VERSION)
  );
}

function configRef(): ProviderConfigurationRef {
  return {
    kind: "dynamic",
    reference: VERY_WEB_CONFIGURATION_REFERENCE,
    version: VERY_WEB_CONFIGURATION_VERSION,
  };
}

function expectedScope(): SubjectScope {
  return {
    kind: "named",
    scope_semantics: "issuer_rp_scope",
    issuer: VERY_WEB_ISSUER,
    rp_scope: VERY_WEB_RP_SCOPE,
  };
}

function requestSupported(value: VeryWebPlanInput): boolean {
  return (
    value.method === VERY_WEB_METHOD &&
    value.requested_requirements.length === VERY_WEB_CLAIMS.length &&
    exactClaims(value.requested_requirements, value.requested_claim_ids) &&
    value.subject_binding_intent !== "none" &&
    value.protocol_version === VERY_WEB_PROTOCOL_VERSION &&
    ["test", "development", "staging", "production"].includes(value.environment) &&
    sameScope(value.scope, expectedScope()) &&
    purposeSupported(value.verification_purpose)
  );
}

export type VeryWebPlanInput = VerificationProviderPlanInput;

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
  try {
    const padded =
      value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function validConfigString(value: string): boolean {
  return value.length > 0 && value.trim() === value;
}

function validHttpsUrl(value: string): boolean {
  if (!validConfigString(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" && url.username === "" && url.password === "" && url.hash === ""
    );
  } catch {
    return false;
  }
}

function configurationValid(options: VeryWebAdapterOptions): boolean {
  return (
    options.sealing_key.byteLength === 32 &&
    validConfigString(options.app_id) &&
    validHttpsUrl(options.api_url) &&
    validHttpsUrl(options.verify_url) &&
    validHttpsUrl(options.bridge_api_url)
  );
}

function exactSessionExpiry(issuedAt: string, expiresAt: string): boolean {
  const issued = DateTime.make(issuedAt);
  const expires = DateTime.make(expiresAt);
  return (
    Option.isSome(issued) &&
    Option.isSome(expires) &&
    DateTime.toEpochMillis(expires.value) - DateTime.toEpochMillis(issued.value) ===
      VERY_WEB_SESSION_TTL_SECONDS * 1_000
  );
}

function sessionMatches(session: ProofSession): boolean {
  return (
    session.provider_id === VERY_WEB_PROVIDER_ID &&
    session.method === VERY_WEB_METHOD &&
    session.request_mode === "dynamic" &&
    sameConfiguration(session.provider_configuration, configRef()) &&
    sameScope(session.scope, expectedScope()) &&
    exactClaims(session.requested_requirements, session.requested_claim_ids) &&
    session.protocol_version === VERY_WEB_PROTOCOL_VERSION &&
    session.subject_binding_intent !== "none"
  );
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function decodeJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function sealSession(
  session: SealedSession,
  keyBytes: Uint8Array,
  randomness: VeryWebRandomness,
): Effect.Effect<string, VerificationProviderFailure> {
  return Effect.tryPromise({
    try: async () => {
      const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
      const iv = randomness.bytes(12);
      if (iv.byteLength !== 12) throw new Error("invalid randomness");
      const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: encodeJson(SESSION_AAD) },
          key,
          encodeJson(session),
        ),
      );
      return `${SESSION_PREFIX}.${encodeBase64Url(iv)}.${encodeBase64Url(ciphertext)}`;
    },
    catch: () => invalid("start"),
  });
}

function unsealSession(
  value: string,
  keyBytes: Uint8Array,
): Effect.Effect<SealedSession, VerificationProviderFailure> {
  return Effect.tryPromise({
    try: async () => {
      if (value.length === 0 || value.length > VERY_WEB_MAX_SEALED_SESSION_REF_CHARS)
        throw new Error("invalid");
      const parts = value.split(".");
      if (parts.length !== 5 || `${parts[0]}.${parts[1]}.${parts[2]}` !== SESSION_PREFIX)
        throw new Error("invalid");
      const iv = decodeBase64Url(parts[3] ?? "");
      const ciphertext = decodeBase64Url(parts[4] ?? "");
      if (
        iv === undefined ||
        ciphertext === undefined ||
        iv.byteLength !== 12 ||
        ciphertext.byteLength < 16
      )
        throw new Error("invalid");
      const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
      const plaintext = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: encodeJson(SESSION_AAD) },
          key,
          ciphertext,
        ),
      );
      const decoded = Schema.decodeUnknownOption(
        Schema.Struct({
          version: Schema.Literal(1),
          proof_session_id: Schema.NonEmptyString,
          actor_id: Schema.NonEmptyString,
          intent_id: Schema.NonEmptyString,
          request_hash: Sha256Hex,
          issued_at: Schema.NonEmptyString,
          expires_at: Schema.NonEmptyString,
          bridge_session_id: Schema.NonEmptyString,
          bridge_key: Schema.NonEmptyString,
          binding_value: Schema.NonEmptyString,
        }),
      )(decodeJson(plaintext));
      if (Option.isNone(decoded)) throw new Error("invalid");
      return decoded.value;
    },
    catch: () => unbound(),
  });
}

function randomBytes(
  randomness: VeryWebRandomness,
  length: number,
): Effect.Effect<Uint8Array, VerificationProviderFailure> {
  return Effect.try({
    try: () => {
      const bytes = randomness.bytes(length);
      if (bytes.byteLength !== length) throw new Error("invalid randomness");
      return bytes;
    },
    catch: () => invalid("start"),
  });
}

function strictSubmission(
  value: unknown,
): Effect.Effect<ClientSubmission, VerificationProviderFailure> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return Effect.fail(unbound());
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (record.mode === "bridge" && keys.length === 1) return Effect.succeed({ mode: "bridge" });
  if (
    record.mode === "widget" &&
    keys.length === 2 &&
    typeof record.proof === "string" &&
    record.proof.length > 0 &&
    record.proof.length <= VERY_WEB_MAX_RESPONSE_BYTES
  ) {
    return Effect.succeed({ mode: "widget", proof: record.proof });
  }
  return Effect.fail(unbound());
}

function responseBody(
  response: VeryWebTransportResponse,
  operation: "start" | "complete",
): Effect.Effect<unknown, VerificationProviderFailure> {
  if (response.status === 429 || response.status >= 500) return Effect.fail(unavailable(operation));
  if (response.status < 200 || response.status >= 300) return Effect.fail(rejected(operation));
  try {
    if (
      new TextEncoder().encode(JSON.stringify(response.body)).byteLength >
      VERY_WEB_MAX_RESPONSE_BYTES
    ) {
      return Effect.fail(invalid(operation));
    }
  } catch {
    return Effect.fail(invalid(operation));
  }
  return Effect.succeed(response.body);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
  }
  return undefined;
}

function verifyResult(
  value: unknown,
  expectedBinding: string,
): Effect.Effect<string, VerificationProviderFailure> {
  const root = record(value) ?? {};
  const status = typeof root.status === "string" ? root.status : "";
  if (["pending", "processing", "received"].includes(status))
    return Effect.fail(unavailable("complete"));
  // @veryai/widget 1.0.22 checks the top-level verifier status strictly
  // against "valid". Do not accept guessed boolean or nested success shapes.
  if (status !== "valid") return Effect.fail(rejected("complete"));
  const actualBinding = stringField(root, [
    "pseudonym",
    "challenge",
    "externalNullifier",
    "external_nullifier",
  ]);
  if (actualBinding === undefined || actualBinding !== expectedBinding)
    return Effect.fail(rejected("complete"));
  const subject = stringField(root, [
    "subject",
    "sub",
    "nullifier_hash",
    "nullifierHash",
    "external_user_id",
  ]);
  if (subject === undefined || subject === "0") return Effect.fail(invalid("complete"));
  return Effect.succeed(subject);
}

function bridgeProof(
  value: unknown,
  keyBytes: Uint8Array,
): Effect.Effect<string, VerificationProviderFailure> {
  const root = record(value);
  const status = typeof root?.status === "string" ? root.status : "";
  if (status === "pending" || status === "received") return Effect.fail(unavailable("complete"));
  if (status === "error") return Effect.fail(rejected("complete"));
  const response = record(root?.response);
  const iv = typeof response?.iv === "string" ? decodeBase64(response.iv) : undefined;
  const payload =
    typeof response?.payload === "string" ? decodeBase64(response.payload) : undefined;
  if (status !== "completed" || iv === undefined || payload === undefined)
    return Effect.fail(invalid("complete"));
  return Effect.tryPromise({
    try: async () => {
      const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
      const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, payload);
      return new TextDecoder().decode(plaintext);
    },
    catch: () => invalid("complete"),
  });
}

function decodeBase64(value: string): Uint8Array | undefined {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function buildAssertion(
  requirement: VerificationRequirement,
  ids: VeryWebIdentifiers,
  subjectKeyId: string,
  receiptId: string,
  bindingGroupId: string,
  observedAt: CanonicalIsoInstant,
): Assertion {
  const common = {
    id: ids.next("assertion"),
    subject_key_id: subjectKeyId,
    evidence_receipt_id: receiptId,
    binding_group_id: bindingGroupId,
    observed_at: observedAt,
    assurance: "provider_attested" as const,
  };
  if (requirement.claim_id === "human.personhood")
    return { ...common, claim_id: requirement.claim_id, value: { personhood: true } };
  if (requirement.claim_id === "credential.subject_unique")
    return { ...common, claim_id: requirement.claim_id, value: { subject_unique: true } };
  throw new Error("unsupported Very web claim");
}

function evidenceBundle(
  session: ProofSession,
  subject: string,
  options: VeryWebAdapterOptions,
): Effect.Effect<EvidenceBundle, VerificationProviderFailure> {
  const scope = session.scope;
  if (scope.kind !== "named") return Effect.fail(rejected("complete"));
  const observed_at = options.clock.now();
  const receipt_id = options.identifiers.next("receipt");
  const subject_key_id = options.identifiers.next("subject");
  const binding_group_id = options.identifiers.next("binding");
  return Effect.gen(function* () {
    const subject_digest = yield* options.digest.digest(subject).pipe(
      Effect.flatMap((value) => {
        const decoded = Schema.decodeUnknownOption(Sha256Hex)(value);
        return Option.isSome(decoded)
          ? Effect.succeed(decoded.value)
          : Effect.fail(invalid("complete"));
      }),
    );
    const evidence_hash = yield* options.digest
      .digest(
        JSON.stringify({
          provider: VERY_WEB_PROVIDER_ID,
          session_id: session.id,
          claims: session.requested_claim_ids,
        }),
      )
      .pipe(
        Effect.flatMap((value) => {
          const decoded = Schema.decodeUnknownOption(Sha256Hex)(value);
          return Option.isSome(decoded)
            ? Effect.succeed(decoded.value)
            : Effect.fail(invalid("complete"));
        }),
      );
    return {
      id: options.identifiers.next("bundle"),
      proof_session_id: session.id,
      receipts: [
        {
          id: receipt_id,
          proof_session_id: session.id,
          provider_id: VERY_WEB_PROVIDER_ID,
          issuer: scope.issuer,
          method: session.method,
          scope,
          provider_configuration: session.provider_configuration,
          protocol_version: session.protocol_version,
          environment: session.environment,
          provenance_kind: "proof_session",
          evidence_kind: VERY_WEB_EVIDENCE_KIND,
          evidence_hash,
          observed_at,
          subject_key_id,
        },
      ],
      subject_keys: [
        {
          id: subject_key_id,
          issuer: scope.issuer,
          method: session.method,
          scope,
          subject_digest,
        },
      ],
      binding_groups: [{ id: binding_group_id, kind: "same_subject", subject_key_id }],
      assertions: session.requested_requirements.map((requirement) =>
        buildAssertion(
          requirement,
          options.identifiers,
          subject_key_id,
          receipt_id,
          binding_group_id,
          observed_at,
        ),
      ),
    } satisfies EvidenceBundle;
  });
}

function payloadQuery(purpose: VeryWebPurpose, bindingValue: string) {
  return {
    conditions: [
      { identifier: "val", operation: "IN", value: { from: "1743436800", to: "2043436800" } },
    ],
    options: {
      expiredAtLowerBound: "1743436800",
      externalNullifier: externalNullifier(purpose),
      equalCheckId: "0",
      pseudonym: bindingValue,
    },
  };
}

function bridgeUrl(base: string, path: string): string {
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
}

function base64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function readBoundedResponseBody(
  response: Response,
  operation: "start" | "complete",
): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > VERY_WEB_MAX_RESPONSE_BYTES) {
      throw invalid(operation);
    }
  }
  const bytes: Uint8Array[] = [];
  let total = 0;
  if (response.body === null) {
    const text = await response.text();
    const encoded = new TextEncoder().encode(text);
    if (encoded.byteLength > VERY_WEB_MAX_RESPONSE_BYTES) throw invalid(operation);
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(encoded)) as unknown;
    } catch {
      return null;
    }
  }
  const reader = response.body.getReader();
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > VERY_WEB_MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the bounded-response classification if cancellation fails.
        }
        throw invalid(operation);
      }
      bytes.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const encoded = new Uint8Array(total);
  let offset = 0;
  for (const part of bytes) {
    encoded.set(part, offset);
    offset += part.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(encoded)) as unknown;
  } catch {
    return null;
  }
}

function encryptedLaunch(
  key: CryptoKey,
  iv: Uint8Array,
  launch: Readonly<{ app_id: string; context: string; query: unknown; type_id: string }>,
): Effect.Effect<string, VerificationProviderFailure> {
  return Effect.tryPromise({
    try: async () =>
      base64(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv },
          key,
          encodeJson({
            appId: launch.app_id,
            idpContext: launch.context,
            idpQuery: JSON.stringify(launch.query),
            idpTypeId: launch.type_id,
          }),
        ),
      ),
    catch: () => invalid("start"),
  });
}

export function validVeryWebOptions(options: VeryWebAdapterOptions): boolean {
  return configurationValid(options);
}

export function makeVeryWebProvider(options: VeryWebAdapterOptions): VerificationProviderAdapter {
  const configured = configurationValid(options);
  const plan = (input: VerificationProviderPlanInput) =>
    Effect.succeed(
      !configured
        ? { status: "unknown" as const }
        : requestSupported(input)
          ? {
              status: "supported" as const,
              request_mode: "dynamic" as const,
              provider_configuration: configRef(),
            }
          : { status: "unsupported" as const },
    );

  return {
    manifest: VERY_WEB_MANIFEST,
    plan,
    start: (
      input: VerificationProviderStartInput,
    ): Effect.Effect<ProviderSessionStart, VerificationProviderFailure> => {
      if (!configured) return Effect.fail(misconfigured("start"));
      if (
        !requestSupported(input) ||
        input.request_mode !== "dynamic" ||
        !sameConfiguration(input.provider_configuration, configRef()) ||
        !sameScope(input.scope, expectedScope())
      ) {
        return Effect.fail(rejected("start"));
      }
      const purpose = input.verification_purpose;
      if (purpose === undefined || !purposeSupported(purpose)) {
        return Effect.fail(rejected("start"));
      }
      const issued_at = options.clock.now();
      const expires_at = options.clock.expiresAt(issued_at);
      if (!exactSessionExpiry(issued_at, expires_at)) return Effect.fail(rejected("start"));
      const sessionId = options.identifiers.next("session");
      const bindingValue = sessionId;
      return Effect.all({
        keyBytes: randomBytes(options.randomness, 32),
        ivBytes: randomBytes(options.randomness, 12),
      }).pipe(
        Effect.flatMap(({ keyBytes, ivBytes }) =>
          Effect.gen(function* () {
            const key = yield* Effect.tryPromise({
              try: () => crypto.subtle.importKey("raw", keyBytes, "AES-GCM", true, ["encrypt"]),
              catch: () => invalid("start"),
            });
            const query = payloadQuery(purpose, bindingValue);
            const launch = {
              app_id: options.app_id,
              context: "Veros - Palm Verification Timestamp",
              type_id: "3",
              query,
            };
            const payload = yield* encryptedLaunch(key, ivBytes, launch);
            const bridge = yield* options.transport
              .createBridge({
                url: bridgeUrl(options.bridge_api_url, "sessions"),
                body: JSON.stringify({ iv: base64(ownedArrayBuffer(ivBytes)), payload }),
                headers: { accept: "application/json", "content-type": "application/json" },
                timeout_ms: VERY_WEB_HTTP_TIMEOUT_MS,
              })
              .pipe(Effect.flatMap((response) => responseBody(response, "start")));
            const bridgeRecord = record(bridge);
            const bridgeSessionId =
              typeof bridgeRecord?.sessionId === "string" ? bridgeRecord.sessionId : "";
            if (bridgeSessionId.trim() === "") return yield* Effect.fail(invalid("start"));
            const keyBase64 = base64(ownedArrayBuffer(keyBytes));
            const deeplink = `veros://verify?${new URLSearchParams({ sessionId: bridgeSessionId, key: keyBase64, action: "verify" }).toString()}`;
            const upstream_session_ref = yield* sealSession(
              {
                version: 1,
                proof_session_id: sessionId,
                actor_id: input.actor_id,
                intent_id: input.intent_id,
                request_hash: input.request_hash,
                issued_at,
                expires_at,
                bridge_session_id: bridgeSessionId,
                bridge_key: keyBase64,
                binding_value: bindingValue,
              },
              options.sealing_key,
              options.randomness,
            );
            const session: ProofSession = {
              id: sessionId,
              actor_id: input.actor_id,
              intent_id: input.intent_id,
              request_hash: input.request_hash,
              provider_id: VERY_WEB_PROVIDER_ID,
              upstream_session_ref,
              provider_configuration: input.provider_configuration,
              method: input.method,
              scope: input.scope,
              request_mode: input.request_mode,
              requested_requirements: input.requested_requirements,
              requested_claim_ids: input.requested_claim_ids,
              subject_binding_intent: input.subject_binding_intent,
              protocol_version: input.protocol_version,
              environment: input.environment,
              status: "pending",
              started_at: issued_at,
              expires_at,
            };
            return {
              session,
              presentation: {
                kind: "embedded_sdk",
                session_id: sessionId,
                protocol: "very-widget",
                version: "1",
                payload: {
                  app_id: options.app_id,
                  api_url: options.api_url,
                  context: launch.context,
                  type_id: launch.type_id,
                  query: JSON.stringify(launch.query),
                  verify_url: options.verify_url,
                  mobile: {
                    uri: deeplink,
                    poll_url: `/verification/sessions/${sessionId}/complete`,
                  },
                },
              },
            };
          }),
        ),
      );
    },
    complete: (input: VerificationProviderCompleteInput) => {
      if (!configured) return Effect.fail(misconfigured("complete"));
      if (
        !sessionMatches(input.session) ||
        input.session.status !== "pending" ||
        input.session.upstream_session_ref === undefined ||
        input.submission.channel !== "client_result"
      ) {
        return Effect.fail(unbound());
      }
      return unsealSession(input.session.upstream_session_ref, options.sealing_key).pipe(
        Effect.filterOrFail(
          (sealed) =>
            sealed.proof_session_id === input.session.id &&
            sealed.actor_id === input.session.actor_id &&
            sealed.intent_id === input.session.intent_id &&
            sealed.request_hash === input.session.request_hash &&
            sealed.issued_at === input.session.started_at &&
            sealed.expires_at === input.session.expires_at &&
            exactSessionExpiry(sealed.issued_at, sealed.expires_at) &&
            sealed.expires_at > options.clock.now(),
          () => unbound(),
        ),
        Effect.flatMap((sealed) =>
          strictSubmission(input.submission.payload).pipe(
            Effect.map((submission) => ({ sealed, submission })),
          ),
        ),
        Effect.flatMap(({ sealed, submission }) => {
          const proof =
            submission.mode === "widget"
              ? Effect.succeed(submission.proof)
              : options.transport
                  .bridgeStatus({
                    url: bridgeUrl(
                      options.bridge_api_url,
                      `session/${encodeURIComponent(sealed.bridge_session_id)}`,
                    ),
                    session_id: sealed.bridge_session_id,
                    timeout_ms: VERY_WEB_HTTP_TIMEOUT_MS,
                  })
                  .pipe(
                    Effect.flatMap((response) => responseBody(response, "complete")),
                    Effect.flatMap((body) =>
                      bridgeProof(body, decodeBase64(sealed.bridge_key) ?? new Uint8Array()),
                    ),
                  );
          return proof.pipe(
            Effect.flatMap((value) =>
              options.transport
                .verify({
                  url: options.verify_url,
                  proof: value,
                  timeout_ms: VERY_WEB_HTTP_TIMEOUT_MS,
                })
                .pipe(
                  Effect.flatMap((response) => responseBody(response, "complete")),
                  Effect.flatMap((body) => verifyResult(body, sealed.binding_value)),
                ),
            ),
          );
        }),
        Effect.flatMap((subject) => evidenceBundle(input.session, subject, options)),
      );
    },
  };
}

type VeryWebFetch = (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>;

export function makeVeryWebFetchTransport(fetcher: VeryWebFetch = fetch): VeryWebTransport {
  const request = (url: string, init: RequestInit, operation: "start" | "complete") =>
    Effect.tryPromise({
      try: async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), VERY_WEB_HTTP_TIMEOUT_MS);
        try {
          const response = await fetcher(url, { ...init, signal: controller.signal });
          const body = await readBoundedResponseBody(response, operation);
          return { status: response.status, body } satisfies VeryWebTransportResponse;
        } finally {
          clearTimeout(timer);
        }
      },
      catch: (error) =>
        error instanceof VerificationProviderInvalidResponse ||
        error instanceof VerificationProviderRejected ||
        error instanceof VerificationProviderUnavailable
          ? error
          : unavailable(operation),
    });
  return {
    createBridge: ({ url, body, headers }) =>
      request(url, { method: "POST", body, headers }, "start"),
    bridgeStatus: ({ url }) =>
      request(url, { method: "GET", headers: { accept: "application/json" } }, "complete"),
    verify: ({ url, proof }) =>
      request(
        url,
        {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ proof }),
        },
        "complete",
      ),
  };
}
