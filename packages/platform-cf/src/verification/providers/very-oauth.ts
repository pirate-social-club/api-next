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
  CanonicalIsoInstant as CanonicalIsoInstantSchema,
  type EvidenceBundle,
  type ProofProviderManifest,
  type ProofSession,
  type ProviderConfigurationRef,
  Sha256Hex,
  type SubjectScope,
  type VerificationRequirement,
} from "@pirate/domain/verification";
import { DateTime, Effect, Option, Schema } from "effect";
import { createRemoteJWKSet, jwtVerify } from "jose";

export const VERY_OAUTH_PROVIDER_ID = "very.oauth" as const;
export const VERY_OAUTH_PROTOCOL_VERSION = "oauth2-oidc-v1" as const;
export const VERY_OAUTH_RP_SCOPE = "pirate-social" as const;
export const VERY_OAUTH_CONFIGURATION_REFERENCE = "very-oauth" as const;
export const VERY_OAUTH_CONFIGURATION_VERSION = "1" as const;
export const VERY_OAUTH_EVIDENCE_KIND = "very.oauth.id-token-userinfo.v1" as const;
export const VERY_OAUTH_HTTP_TIMEOUT_MS = 15_000 as const;
export const VERY_OAUTH_SESSION_TTL_SECONDS = 300 as const;
export const VERY_OAUTH_MAX_RESPONSE_BYTES = 1_048_576 as const;
export const VERY_OAUTH_ISSUER = "https://connect.very.org" as const;
const VERY_OAUTH_ID_TOKEN_CLOCK_SKEW_SECONDS = 60;

const VERY_OAUTH_CLAIMS = [
  "human.personhood",
  "credential.subject_unique",
] as const satisfies readonly CanonicalClaimIdentifier[];

export const VERY_OAUTH_MANIFEST: ProofProviderManifest = {
  provider_id: VERY_OAUTH_PROVIDER_ID,
  manifest_version: "1",
  operation_deadlines: { plan_ms: 1000, start_ms: 5000, complete_ms: 45_000, callback_ms: 1000 },
  callback_mode: "none",
  callback_header_allowlist: [],
  protocol_versions: [VERY_OAUTH_PROTOCOL_VERSION],
  environments: ["test", "development", "staging", "production"],
  supported_methods: ["palm_oauth"],
  claim_ids: [...VERY_OAUTH_CLAIMS],
  claim_capabilities: VERY_OAUTH_CLAIMS.map((claim_id) => ({
    claim_id,
    request_modes: ["dynamic" as const],
  })),
  presentation_kinds: ["redirect"],
  assurance_levels: ["provider_attested"],
  subject_key_scope_semantics: "issuer_rp_scope",
};

export type VeryOauthClock = Readonly<{
  readonly now: () => CanonicalIsoInstant;
  readonly expiresAt: (now: CanonicalIsoInstant) => CanonicalIsoInstant;
}>;

export type VeryOauthIdentifierKind =
  | "session"
  | "bundle"
  | "receipt"
  | "subject"
  | "binding"
  | "assertion";

export type VeryOauthIdentifiers = Readonly<{
  readonly next: (kind: VeryOauthIdentifierKind) => string;
}>;

export type VeryOauthRandomness = Readonly<{
  readonly bytes: (length: number) => Uint8Array;
}>;

export type VeryOauthDigest = Readonly<{
  readonly digest: (value: string) => Effect.Effect<string, VerificationProviderFailure>;
}>;

export type VeryOauthTransportResponse = Readonly<{
  readonly status: number;
  readonly body: unknown;
}>;

export type VeryOauthTransport = Readonly<{
  readonly token: (
    input: Readonly<{
      readonly url: string;
      readonly body: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly timeout_ms: number;
    }>,
  ) => Effect.Effect<VeryOauthTransportResponse, VerificationProviderFailure>;
  readonly userInfo: (
    input: Readonly<{
      readonly url: string;
      readonly access_token: string;
      readonly timeout_ms: number;
    }>,
  ) => Effect.Effect<VeryOauthTransportResponse, VerificationProviderFailure>;
}>;

export type VeryOauthIdTokenClaims = Readonly<{
  readonly issuer: string;
  readonly audience: string;
  readonly subject: string;
  readonly nonce: string;
}>;

export type VeryOauthIdTokenVerifier = (
  input: Readonly<{
    readonly id_token: string;
    readonly issuer: string;
    readonly audience: string;
    readonly jwks_url: string;
    readonly nonce: string;
  }>,
) => Effect.Effect<VeryOauthIdTokenClaims, VerificationProviderFailure>;

export type VeryOauthAdapterOptions = Readonly<{
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly userinfo_endpoint: string;
  readonly issuer: string;
  readonly jwks_url: string;
  readonly client_id: string;
  readonly client_secret: string;
  readonly redirect_uri: string;
  /** Exactly 32 bytes. This key is configuration, never derived from a request. */
  readonly sealing_key: Uint8Array;
  readonly transport: VeryOauthTransport;
  readonly clock: VeryOauthClock;
  readonly identifiers: VeryOauthIdentifiers;
  readonly randomness: VeryOauthRandomness;
  readonly digest: VeryOauthDigest;
  readonly id_token_verifier?: VeryOauthIdTokenVerifier;
}>;

const SealedSession = Schema.Struct({
  version: Schema.Literal(1),
  proof_session_id: Schema.NonEmptyString,
  actor_id: Schema.NonEmptyString,
  intent_id: Schema.NonEmptyString,
  request_hash: Sha256Hex,
  redirect_uri: Schema.NonEmptyString,
  issued_at: CanonicalIsoInstantSchema,
  expires_at: CanonicalIsoInstantSchema,
  state: Schema.NonEmptyString,
  nonce: Schema.NonEmptyString,
  code_verifier: Schema.NonEmptyString,
});
type SealedSession = Schema.Schema.Type<typeof SealedSession>;

const TokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  id_token: Schema.NonEmptyString,
});

const UserInfoResponse = Schema.Struct({ sub: Schema.NonEmptyString });

const ClientSubmission = Schema.Struct({
  code: Schema.NonEmptyString,
  state: Schema.NonEmptyString,
});
type ClientSubmission = Schema.Schema.Type<typeof ClientSubmission>;

const StrictClientSubmission = Schema.Unknown.check(
  Schema.makeFilter((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return "object";
    const keys = Object.keys(value);
    return keys.length === 2 && keys.every((key) => key === "code" || key === "state")
      ? undefined
      : "exactly code and state";
  }),
);

const SESSION_AAD = "pirate-api-next/very.oauth/session/v1";
const SESSION_PREFIX = "very.oauth.v1";

function invalid(operation: "plan" | "start" | "complete"): VerificationProviderInvalidResponse {
  return new VerificationProviderInvalidResponse({
    provider_id: VERY_OAUTH_PROVIDER_ID,
    operation,
  });
}

function rejected(operation: "start" | "complete"): VerificationProviderRejected {
  return new VerificationProviderRejected({ provider_id: VERY_OAUTH_PROVIDER_ID, operation });
}

function unbound(): VerificationProviderUnboundRejected {
  return new VerificationProviderUnboundRejected({
    provider_id: VERY_OAUTH_PROVIDER_ID,
    operation: "complete",
  });
}

function unavailable(operation: "start" | "complete"): VerificationProviderUnavailable {
  return new VerificationProviderUnavailable({
    provider_id: VERY_OAUTH_PROVIDER_ID,
    operation,
  });
}

function misconfigured(
  operation: "plan" | "start" | "complete",
): VerificationProviderMisconfigured {
  return new VerificationProviderMisconfigured({ provider_id: VERY_OAUTH_PROVIDER_ID, operation });
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
    requirements.length === VERY_OAUTH_CLAIMS.length &&
    JSON.stringify(claimIds(requirements)) === JSON.stringify(ids) &&
    new Set(ids).size === VERY_OAUTH_CLAIMS.length &&
    VERY_OAUTH_CLAIMS.every((claim) => ids.includes(claim))
  );
}

function requestSupported(value: VeryOauthPlanInput): boolean {
  return (
    value.method === "palm_oauth" &&
    value.requested_requirements.length === VERY_OAUTH_CLAIMS.length &&
    exactClaims(value.requested_requirements, value.requested_claim_ids) &&
    value.subject_binding_intent !== "none" &&
    value.protocol_version === VERY_OAUTH_PROTOCOL_VERSION &&
    ["test", "development", "staging", "production"].includes(value.environment) &&
    sameScope(value.scope, expectedScope())
  );
}

export type VeryOauthPlanInput = VerificationProviderPlanInput;

function configRef(): ProviderConfigurationRef {
  return {
    kind: "dynamic",
    reference: VERY_OAUTH_CONFIGURATION_REFERENCE,
    version: VERY_OAUTH_CONFIGURATION_VERSION,
  };
}

function expectedScope(): SubjectScope {
  return {
    kind: "named",
    scope_semantics: "issuer_rp_scope",
    issuer: VERY_OAUTH_ISSUER,
    rp_scope: VERY_OAUTH_RP_SCOPE,
  };
}

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

function randomString(randomness: VeryOauthRandomness): string {
  return encodeBase64Url(randomness.bytes(32));
}

function pkceChallenge(verifier: string): Effect.Effect<string, VerificationProviderFailure> {
  return Effect.tryPromise({
    try: async () =>
      encodeBase64Url(
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
      ),
    catch: () => invalid("start"),
  });
}

function sealSession(
  session: SealedSession,
  keyBytes: Uint8Array,
  randomness: VeryOauthRandomness,
): Effect.Effect<string, VerificationProviderFailure> {
  return Effect.tryPromise({
    try: async () => {
      const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
      const iv = randomness.bytes(12);
      const plaintext = new TextEncoder().encode(JSON.stringify(session));
      const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(SESSION_AAD) },
          key,
          plaintext,
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
      const parts = value.split(".");
      if (parts.length !== 5 || `${parts[0]}.${parts[1]}.${parts[2]}` !== SESSION_PREFIX)
        throw new Error("invalid");
      const ivPart = parts[3];
      const ciphertextPart = parts[4];
      if (ivPart === undefined || ciphertextPart === undefined) throw new Error("invalid");
      const iv = decodeBase64Url(ivPart);
      const ciphertext = decodeBase64Url(ciphertextPart);
      if (
        iv === undefined ||
        ciphertext === undefined ||
        iv.length !== 12 ||
        ciphertext.length < 16
      )
        throw new Error("invalid");
      const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(SESSION_AAD) },
        key,
        ciphertext,
      );
      const decoded = Schema.decodeUnknownOption(SealedSession)(
        JSON.parse(new TextDecoder().decode(plaintext)),
      );
      if (Option.isNone(decoded)) throw new Error("invalid");
      return decoded.value;
    },
    catch: () => unbound(),
  });
}

function decodeSubmission(
  value: unknown,
): Effect.Effect<ClientSubmission, VerificationProviderFailure> {
  const strict = Schema.decodeUnknownOption(StrictClientSubmission)(value);
  if (Option.isNone(strict)) return Effect.fail(unbound());
  const decoded = Schema.decodeUnknownOption(ClientSubmission)(strict.value);
  return Option.isSome(decoded) ? Effect.succeed(decoded.value) : Effect.fail(unbound());
}

function decodeTokenResponse(
  value: unknown,
): Effect.Effect<Schema.Schema.Type<typeof TokenResponse>, VerificationProviderFailure> {
  const decoded = Schema.decodeUnknownOption(TokenResponse)(value);
  return Option.isSome(decoded) ? Effect.succeed(decoded.value) : Effect.fail(invalid("complete"));
}

function decodeUserInfo(
  value: unknown,
): Effect.Effect<Schema.Schema.Type<typeof UserInfoResponse>, VerificationProviderFailure> {
  const decoded = Schema.decodeUnknownOption(UserInfoResponse)(value);
  return Option.isSome(decoded) ? Effect.succeed(decoded.value) : Effect.fail(invalid("complete"));
}

function responseBody(
  response: VeryOauthTransportResponse,
): Effect.Effect<unknown, VerificationProviderFailure> {
  if (response.status === 429 || response.status >= 500)
    return Effect.fail(unavailable("complete"));
  if (response.status < 200 || response.status >= 300) return Effect.fail(rejected("complete"));
  try {
    if (
      new TextEncoder().encode(JSON.stringify(response.body)).byteLength >
      VERY_OAUTH_MAX_RESPONSE_BYTES
    ) {
      return Effect.fail(invalid("complete"));
    }
  } catch {
    return Effect.fail(invalid("complete"));
  }
  return Effect.succeed(response.body);
}

function validHttpsUrl(value: string): boolean {
  if (value.trim() !== value || value.length === 0) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" && url.username === "" && url.password === "" && url.hash === ""
    );
  } catch {
    return false;
  }
}

function validConfigString(value: string): boolean {
  return value.length > 0 && value.trim() === value;
}

function configurationValid(options: VeryOauthAdapterOptions): boolean {
  return (
    options.sealing_key.byteLength === 32 &&
    validConfigString(options.client_id) &&
    validConfigString(options.client_secret) &&
    validHttpsUrl(options.authorization_endpoint) &&
    validHttpsUrl(options.token_endpoint) &&
    validHttpsUrl(options.userinfo_endpoint) &&
    validHttpsUrl(options.issuer) &&
    validHttpsUrl(options.jwks_url) &&
    validHttpsUrl(options.redirect_uri)
  );
}

function sessionMatches(session: ProofSession): boolean {
  return (
    session.provider_id === VERY_OAUTH_PROVIDER_ID &&
    session.method === "palm_oauth" &&
    session.request_mode === "dynamic" &&
    sameConfiguration(session.provider_configuration, configRef()) &&
    sameScope(session.scope, expectedScope()) &&
    exactClaims(session.requested_requirements, session.requested_claim_ids) &&
    session.protocol_version === VERY_OAUTH_PROTOCOL_VERSION &&
    session.subject_binding_intent !== "none"
  );
}

function exactSessionExpiry(
  issuedAt: CanonicalIsoInstant,
  expiresAt: CanonicalIsoInstant,
): boolean {
  const issued = DateTime.make(issuedAt);
  const expires = DateTime.make(expiresAt);
  return (
    Option.isSome(issued) &&
    Option.isSome(expires) &&
    DateTime.toEpochMillis(expires.value) - DateTime.toEpochMillis(issued.value) ===
      VERY_OAUTH_SESSION_TTL_SECONDS * 1000
  );
}

function liveSession(
  session: ProofSession,
  sealed: SealedSession,
  now: CanonicalIsoInstant,
  redirectUri: string,
): boolean {
  if (
    sealed.proof_session_id !== session.id ||
    sealed.actor_id !== session.actor_id ||
    sealed.intent_id !== session.intent_id ||
    sealed.request_hash !== session.request_hash ||
    sealed.redirect_uri !== redirectUri ||
    sealed.issued_at !== session.started_at ||
    sealed.expires_at !== session.expires_at ||
    !exactSessionExpiry(sealed.issued_at, sealed.expires_at)
  )
    return false;
  const sessionTime = DateTime.make(sealed.issued_at);
  const nowTime = DateTime.make(now);
  if (Option.isNone(sessionTime) || Option.isNone(nowTime)) return false;
  return (
    DateTime.toEpochMillis(nowTime.value) >= DateTime.toEpochMillis(sessionTime.value) &&
    DateTime.toEpochMillis(nowTime.value) - DateTime.toEpochMillis(sessionTime.value) <=
      VERY_OAUTH_SESSION_TTL_SECONDS * 1000 &&
    sealed.expires_at > now
  );
}

function buildAssertion(
  requirement: VerificationRequirement,
  ids: VeryOauthIdentifiers,
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
  };
  if (requirement.claim_id === "human.personhood") {
    return {
      ...common,
      claim_id: requirement.claim_id,
      assurance: "provider_attested",
      value: { personhood: true },
    };
  }
  if (requirement.claim_id === "credential.subject_unique") {
    return {
      ...common,
      claim_id: requirement.claim_id,
      assurance: "provider_attested",
      value: { subject_unique: true },
    };
  }
  throw new Error("unsupported Very OAuth claim");
}

function evidenceBundle(
  session: ProofSession,
  subject: string,
  options: VeryOauthAdapterOptions,
): Effect.Effect<EvidenceBundle, VerificationProviderFailure> {
  const scope = session.scope;
  if (scope.kind !== "named") return Effect.fail(rejected("complete"));
  const observed_at = options.clock.now();
  const receipt_id = options.identifiers.next("receipt");
  const subject_key_id = options.identifiers.next("subject");
  const binding_group_id = options.identifiers.next("binding");
  const safeHashInput = JSON.stringify({
    provider: VERY_OAUTH_PROVIDER_ID,
    session_id: session.id,
    claims: session.requested_claim_ids,
  });
  return Effect.gen(function* () {
    const subject_digest = yield* options.digest.digest(subject).pipe(
      Effect.flatMap((value) => {
        const decoded = Schema.decodeUnknownOption(Sha256Hex)(value);
        return Option.isSome(decoded)
          ? Effect.succeed(decoded.value)
          : Effect.fail(invalid("complete"));
      }),
    );
    const evidence_hash = yield* options.digest.digest(safeHashInput).pipe(
      Effect.flatMap((value) => {
        const decoded = Schema.decodeUnknownOption(Sha256Hex)(value);
        return Option.isSome(decoded)
          ? Effect.succeed(decoded.value)
          : Effect.fail(invalid("complete"));
      }),
    );
    const assertions = session.requested_requirements.map((requirement) =>
      buildAssertion(
        requirement,
        options.identifiers,
        subject_key_id,
        receipt_id,
        binding_group_id,
        observed_at,
      ),
    );
    return {
      id: options.identifiers.next("bundle"),
      proof_session_id: session.id,
      receipts: [
        {
          id: receipt_id,
          proof_session_id: session.id,
          provider_id: VERY_OAUTH_PROVIDER_ID,
          issuer: scope.issuer,
          method: session.method,
          scope,
          provider_configuration: session.provider_configuration,
          protocol_version: session.protocol_version,
          environment: session.environment,
          provenance_kind: "proof_session",
          evidence_kind: VERY_OAUTH_EVIDENCE_KIND,
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
      assertions,
    } satisfies EvidenceBundle;
  });
}

function defaultIdTokenVerifier(options: VeryOauthAdapterOptions): VeryOauthIdTokenVerifier {
  return ({ id_token, issuer, audience, jwks_url, nonce }) =>
    Effect.tryPromise({
      try: async () => {
        const jwks = createRemoteJWKSet(new URL(jwks_url), {
          timeoutDuration: VERY_OAUTH_HTTP_TIMEOUT_MS,
        });
        const current = DateTime.make(options.clock.now());
        if (Option.isNone(current)) throw new Error("invalid");
        const currentMillis = DateTime.toEpochMillis(current.value);
        const verified = await jwtVerify(id_token, jwks, {
          issuer,
          audience,
          currentDate: new Date(currentMillis),
        });
        const payload = verified.payload;
        const tokenAudience = payload.aud;
        const issuedAt = payload.iat;
        const expiresAt = payload.exp;
        if (
          payload.iss !== issuer ||
          typeof tokenAudience !== "string" ||
          tokenAudience !== audience ||
          typeof issuedAt !== "number" ||
          !Number.isFinite(issuedAt) ||
          typeof expiresAt !== "number" ||
          !Number.isFinite(expiresAt) ||
          issuedAt > currentMillis / 1000 + VERY_OAUTH_ID_TOKEN_CLOCK_SKEW_SECONDS ||
          expiresAt <= currentMillis / 1000 ||
          expiresAt <= issuedAt ||
          typeof payload.sub !== "string" ||
          payload.sub.length === 0 ||
          payload.nonce !== nonce
        )
          throw new Error("invalid");
        return { issuer, audience, subject: payload.sub, nonce };
      },
      catch: () => rejected("complete"),
    });
}

function formBody(values: Readonly<Record<string, string>>): string {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) body.set(key, value);
  return body.toString();
}

export function makeVeryOauthFetchTransport(fetcher: typeof fetch = fetch): VeryOauthTransport {
  const request = (
    input: Parameters<typeof fetch>[0],
    init: RequestInit,
    operation: "start" | "complete",
  ) =>
    Effect.tryPromise({
      try: async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), VERY_OAUTH_HTTP_TIMEOUT_MS);
        try {
          const response = await fetcher(input, { ...init, signal: controller.signal });
          const contentLength = response.headers.get("content-length");
          if (contentLength !== null && Number(contentLength) > VERY_OAUTH_MAX_RESPONSE_BYTES) {
            throw invalid(operation);
          }
          let body: unknown;
          const text = await response.text();
          if (new TextEncoder().encode(text).byteLength > VERY_OAUTH_MAX_RESPONSE_BYTES) {
            throw invalid(operation);
          }
          try {
            body = JSON.parse(text) as unknown;
          } catch {
            body = undefined;
          }
          if (response.status === 429 || response.status >= 500) throw unavailable(operation);
          if (response.status < 200 || response.status >= 300) throw rejected(operation);
          return { status: response.status, body } satisfies VeryOauthTransportResponse;
        } finally {
          clearTimeout(timeout);
        }
      },
      catch: (error) =>
        error instanceof VerificationProviderRejected ||
        error instanceof VerificationProviderMisconfigured ||
        error instanceof VerificationProviderUnavailable ||
        error instanceof VerificationProviderInvalidResponse
          ? error
          : unavailable(operation),
    });
  return {
    token: ({ url, body, headers }) => request(url, { method: "POST", headers, body }, "complete"),
    userInfo: ({ url, access_token }) =>
      request(
        url,
        {
          method: "GET",
          headers: { accept: "application/json", authorization: `Bearer ${access_token}` },
        },
        "complete",
      ),
  };
}

export function makeVeryOauthProvider(
  options: VeryOauthAdapterOptions,
): VerificationProviderAdapter {
  const configured = configurationValid(options);
  const idTokenVerifier = options.id_token_verifier ?? defaultIdTokenVerifier(options);
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
    manifest: VERY_OAUTH_MANIFEST,
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
      )
        return Effect.fail(rejected("start"));
      const issued_at = options.clock.now();
      const expires_at = options.clock.expiresAt(issued_at);
      if (!exactSessionExpiry(issued_at, expires_at)) return Effect.fail(rejected("start"));
      const sessionId = options.identifiers.next("session");
      const state = randomString(options.randomness);
      const nonce = randomString(options.randomness);
      const code_verifier = randomString(options.randomness);
      return pkceChallenge(code_verifier).pipe(
        Effect.flatMap((code_challenge) =>
          sealSession(
            {
              version: 1,
              proof_session_id: sessionId,
              actor_id: input.actor_id,
              intent_id: input.intent_id,
              request_hash: input.request_hash,
              redirect_uri: options.redirect_uri,
              issued_at,
              expires_at,
              state,
              nonce,
              code_verifier,
            },
            options.sealing_key,
            options.randomness,
          ).pipe(
            Effect.map((upstream_session_ref) => {
              const authorization = new URL(options.authorization_endpoint);
              authorization.searchParams.set("response_type", "code");
              authorization.searchParams.set("client_id", options.client_id);
              authorization.searchParams.set("redirect_uri", options.redirect_uri);
              authorization.searchParams.set("scope", "openid");
              authorization.searchParams.set("state", state);
              authorization.searchParams.set("nonce", nonce);
              authorization.searchParams.set("code_challenge", code_challenge);
              authorization.searchParams.set("code_challenge_method", "S256");
              const started_at = issued_at;
              const session: ProofSession = {
                id: sessionId,
                actor_id: input.actor_id,
                intent_id: input.intent_id,
                request_hash: input.request_hash,
                provider_id: VERY_OAUTH_PROVIDER_ID,
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
                started_at,
                expires_at,
              };
              return {
                session,
                presentation: {
                  kind: "redirect",
                  session_id: sessionId,
                  url: authorization.toString(),
                },
              };
            }),
          ),
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
      )
        return Effect.fail(unbound());
      return unsealSession(input.session.upstream_session_ref, options.sealing_key).pipe(
        Effect.filterOrFail(
          (sealed) => liveSession(input.session, sealed, options.clock.now(), options.redirect_uri),
          () => unbound(),
        ),
        Effect.flatMap((sealed) =>
          decodeSubmission(input.submission.payload).pipe(
            Effect.map((submission) => ({ sealed, submission })),
          ),
        ),
        Effect.filterOrFail(
          ({ sealed, submission }) => submission.state === sealed.state,
          () => unbound(),
        ),
        Effect.flatMap(({ sealed, submission }) =>
          options.transport
            .token({
              url: options.token_endpoint,
              body: formBody({
                grant_type: "authorization_code",
                client_id: options.client_id,
                client_secret: options.client_secret,
                code: submission.code,
                redirect_uri: options.redirect_uri,
                code_verifier: sealed.code_verifier,
              }),
              headers: {
                accept: "application/json",
                "content-type": "application/x-www-form-urlencoded",
              },
              timeout_ms: VERY_OAUTH_HTTP_TIMEOUT_MS,
            })
            .pipe(
              Effect.flatMap(responseBody),
              Effect.flatMap(decodeTokenResponse),
              Effect.map((token) => ({ sealed, token })),
            ),
        ),
        Effect.flatMap(({ sealed, token }) =>
          idTokenVerifier({
            id_token: token.id_token,
            issuer: options.issuer,
            audience: options.client_id,
            jwks_url: options.jwks_url,
            nonce: sealed.nonce,
          }).pipe(
            Effect.filterOrFail(
              (claims) =>
                claims.issuer === options.issuer &&
                claims.audience === options.client_id &&
                claims.nonce === sealed.nonce &&
                claims.subject.length > 0,
              () => rejected("complete"),
            ),
            Effect.map((claims) => ({ token, claims })),
          ),
        ),
        Effect.flatMap(({ token, claims }) =>
          options.transport
            .userInfo({
              url: options.userinfo_endpoint,
              access_token: token.access_token,
              timeout_ms: VERY_OAUTH_HTTP_TIMEOUT_MS,
            })
            .pipe(
              Effect.flatMap(responseBody),
              Effect.flatMap(decodeUserInfo),
              Effect.filterOrFail(
                (userInfo) => userInfo.sub === claims.subject,
                () => rejected("complete"),
              ),
              Effect.as(claims.subject),
            ),
        ),
        Effect.flatMap((subject) => evidenceBundle(input.session, subject, options)),
      );
    },
  };
}
