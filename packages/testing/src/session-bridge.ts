/**
 * Source-pinned session bridge characterization.
 *
 * This module is test-only. It contains no production token issuer, route,
 * repository, secret, or private-key fixture. Tests generate an ephemeral
 * RSA keypair and hand only the public verification material to consumers.
 */

export const PIRATE_SESSION_CONTRACT = {
  algorithm: "RS256",
  typ: "JWT",
  issuer: "pirate-api",
  audience: "pirate-app",
  defaultScope: "pirate_app_session",
  defaultTtlSeconds: 3_600,
} as const;

export type SessionClassification = "user" | "device";

export type SessionScope = {
  readonly value: string;
  readonly tokens: readonly string[];
};

export type CanonicalUserAliasResult = {
  readonly sourceUserId: string;
  readonly canonicalUserId: string;
  readonly aliasPath: readonly string[];
};

export type AuthenticatedPrincipal = {
  readonly userId: string;
  readonly classification: SessionClassification;
  readonly scope: SessionScope;
  readonly canonical: CanonicalUserAliasResult;
};

export type SafeAuthFailureCode =
  | "authentication_failed"
  | "invalid_token"
  | "invalid_claims"
  | "token_expired"
  | "token_not_yet_valid"
  | "insufficient_scope"
  | "classification_mismatch"
  | "control_plane_record_missing"
  | "canonical_alias_invalid";

export type SafeAuthFailure = {
  readonly _tag: "SafeAuthFailure";
  readonly code: SafeAuthFailureCode;
  readonly message: "Authentication failed" | "Insufficient OAuth scope";
};

export type SessionVerificationResult =
  | { readonly ok: true; readonly principal: AuthenticatedPrincipal }
  | { readonly ok: false; readonly failure: SafeAuthFailure };

/** The future api-next verifier consumes this shape; it is intentionally only a type. */
export type SessionVerifier = (input: {
  readonly token: string;
  readonly jwks: readonly SessionPublicJwk[];
  readonly controlPlane: ControlPlaneFixture;
  readonly requiredScope?: string;
  readonly requiredClassification?: SessionClassification;
  readonly nowSeconds?: number;
}) => Promise<SessionVerificationResult>;

export type OldSourceEvidence = {
  readonly path: string;
  readonly sha256: string;
};

export const OLD_SOURCE_EVIDENCE = {
  sessionToken: {
    path: "services/api/src/lib/auth/pirate-session-token.ts",
    sha256: "5f5f31e895b4891978fb10b275b29c8c2420d18d018f3b19af92aa4553a07ea8",
  },
  middleware: {
    path: "services/api/src/lib/auth-middleware.ts",
    sha256: "18c1554b01a2c8445e680c8705998d47c2908341794eb5aba839a5e3b5fb22b7",
  },
  authRoute: {
    path: "services/api/src/routes/auth.ts",
    sha256: "dd7cdf247b8d7c873306c2f02ef660e5917e13a91ef818e91886012df6b86923",
  },
  discoveryRoute: {
    path: "services/api/src/routes/discovery.ts",
    sha256: "5e06952039898692b37b553ceb8188f5eddd8568a6489c928c3f41db54812221",
  },
  userQueries: {
    path: "services/api/src/lib/auth/auth-db-user-queries.ts",
    sha256: "6ed12f9e117b36ccdb51ded8a41e3bbe2927595b5ec4ad834c6fafd97b2a65e9",
  },
  aliasService: {
    path: "services/api/src/lib/auth/account-alias-service.ts",
    sha256: "aa9762c57806418f926ca9ad55cfd11baa5814f262b7073f3fbe685675b5dfc0",
  },
  identityRepository: {
    path: "services/api/src/lib/auth/db-identity-repository.ts",
    sha256: "9e5836dc0f6766a24c5432a43f96ef445f0f4f666863ab63fd82853177db02e0",
  },
  oauthDevice: {
    path: "services/api/src/lib/oauth/device-authorization-service.ts",
    sha256: "6512e62b56db49b6f1dbee3415de7ce96442ff5c7006b26172d35d99b01140e8",
  },
  telegramOnboarding: {
    path: "services/api/src/lib/telegram/onboarding-service.ts",
    sha256: "dc9b4533995e4ffe09e576c28f6a466861cdc919291e07047a839078662459c1",
  },
  telegramRoute: {
    path: "services/api/src/routes/telegram.ts",
    sha256: "75ded3a6d7683bc23af6ed52afaf8dee693cf3f058a504693978cc61e25cd11e",
  },
  botRoute: {
    path: "services/api/src/routes/bot-users.ts",
    sha256: "7c8ef1fb615e583f6a80030ea4252c30b8c18bd0492b94be44c1f1999488ba21",
  },
  middlewareTest: {
    path: "services/api/src/lib/auth-middleware.test.ts",
    sha256: "cf7a268094740e7194378df4882356a9585c377cab9d572173e78ce3a2b0c27a",
  },
  authRouteTest: {
    path: "services/api/tests/routes/auth/auth-routes.test.ts",
    sha256: "bea8fdb389075826039a849cf91cccd58d3b4452da4236de2e427983adc21ba2",
  },
  discoveryRouteTest: {
    path: "services/api/tests/routes/discovery-routes.test.ts",
    sha256: "bc0d7ac021e016c31c374081ac542395e4ade9ce1953983892caf4f00e4803a9",
  },
} as const satisfies Record<string, OldSourceEvidence>;

export type ControlPlaneUserRecord = {
  readonly userId: string;
};

export type ControlPlaneAliasRecord = {
  readonly sourceUserId: string;
  readonly canonicalUserId: string;
  readonly kind: "alias" | "merge";
  readonly status: "active" | "finalizing" | "completed" | "inactive";
};

export type ControlPlaneFixture = {
  readonly users: readonly ControlPlaneUserRecord[];
  readonly aliases: readonly ControlPlaneAliasRecord[];
};

export type ExchangeProofType =
  | "jwt_based_auth"
  | "telegram_mini_app_init_data"
  | "oauth_device_code"
  | "bot_admin_token";

export type SessionCredentialDescriptor =
  | {
      readonly credentialType: "exchange-proof";
      readonly exchangeProof: ExchangeProofType;
      readonly resultingCredential: "bearer-session";
    }
  | {
      readonly credentialType: "bearer-session";
    };

export type JwtClaimName = "iss" | "aud" | "sub" | "scope" | "iat" | "exp" | "nbf";

export type SessionTokenRecipe = {
  readonly header?: Readonly<Record<string, unknown>>;
  readonly claims?: Readonly<Record<string, unknown>>;
  readonly omitClaims?: readonly JwtClaimName[];
  readonly signature?: "valid" | "malformed";
};

export type SessionVectorExpectation = {
  readonly oldReference: "accept" | "reject";
  readonly contract: "accept" | "reject";
  readonly oldFailure?: SafeAuthFailureCode;
  readonly contractFailure?: SafeAuthFailureCode;
  readonly note?: string;
};

export type SessionConformanceVector = {
  readonly id: string;
  readonly description: string;
  readonly credential: SessionCredentialDescriptor;
  readonly recipe: SessionTokenRecipe;
  readonly controlPlane: ControlPlaneFixture;
  readonly requiredScope?: string;
  readonly requiredClassification?: SessionClassification;
  readonly expectedPrincipal?: {
    readonly userId: string;
    readonly classification: SessionClassification;
    readonly scope: string;
    readonly canonicalUserId: string;
  };
  readonly sourceEvidence: readonly OldSourceEvidence[];
  readonly expectation: SessionVectorExpectation;
};

export type SessionPublicJwk = {
  readonly kty: "RSA";
  readonly n: string;
  readonly e: string;
  readonly alg: "RS256";
  readonly use: "sig";
  readonly key_ops: readonly ["verify"];
  readonly kid: string;
};

export type SessionJwks = {
  readonly keys: readonly [SessionPublicJwk];
};

type TestKey = object;

type TestSubtle = {
  generateKey(
    algorithm: unknown,
    extractable: boolean,
    usages: readonly string[],
  ): Promise<{ readonly publicKey: TestKey; readonly privateKey: TestKey }>;
  sign(algorithm: unknown, key: TestKey, data: Uint8Array): Promise<ArrayBuffer>;
  verify(
    algorithm: unknown,
    key: TestKey,
    signature: Uint8Array,
    data: Uint8Array,
  ): Promise<boolean>;
  exportKey(format: "jwk", key: TestKey): Promise<Record<string, unknown>>;
  digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer>;
};

function subtle(): TestSubtle {
  const cryptoLike = globalThis as typeof globalThis & {
    crypto?: { readonly subtle?: TestSubtle };
  };
  const value = cryptoLike.crypto?.subtle;
  if (!value) throw new Error("WebCrypto is required for session conformance tests");
  return value;
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function base64UrlDecode(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function encodeJson(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeJson(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function safeFailure(code: SafeAuthFailureCode): SafeAuthFailure {
  return {
    _tag: "SafeAuthFailure",
    code,
    message: code === "insufficient_scope" ? "Insufficient OAuth scope" : "Authentication failed",
  };
}

function resultFailure(code: SafeAuthFailureCode): SessionVerificationResult {
  return { ok: false, failure: safeFailure(code) };
}

function userExists(controlPlane: ControlPlaneFixture, userId: string): boolean {
  return controlPlane.users.some((user) => user.userId === userId);
}

function aliasFor(
  controlPlane: ControlPlaneFixture,
  sourceUserId: string,
): ControlPlaneAliasRecord | null {
  return (
    controlPlane.aliases.find(
      (alias) =>
        alias.sourceUserId === sourceUserId &&
        ((alias.kind === "alias" && alias.status === "active") ||
          (alias.kind === "merge" &&
            (alias.status === "finalizing" || alias.status === "completed"))),
    ) ?? null
  );
}

function resolveCanonicalAsOldReference(
  controlPlane: ControlPlaneFixture,
  sourceUserId: string,
): CanonicalUserAliasResult | null {
  const visited = new Set<string>();
  const aliasPath: string[] = [];
  let current = sourceUserId;
  for (let depth = 0; depth < 8; depth += 1) {
    if (visited.has(current)) return null;
    visited.add(current);
    const alias = aliasFor(controlPlane, current);
    if (!alias) {
      return { sourceUserId, canonicalUserId: current, aliasPath };
    }
    aliasPath.push(current);
    current = alias.canonicalUserId;
  }
  return null;
}

function audienceMatches(value: unknown, expected: string): boolean {
  if (typeof value === "string") return value === expected;
  return Array.isArray(value) && value.some((item) => item === expected);
}

/**
 * Documentation-only characterization of the pre-hardening reference. The
 * executable conformance proof uses the byte-pinned verifier fixture instead.
 * This preserves the historical divergences without presenting them as the
 * current old API behavior.
 */
export async function verifyOldReferenceBearerSession(input: {
  readonly token: string;
  readonly publicKey: TestKey;
  readonly controlPlane: ControlPlaneFixture;
  readonly requiredScope?: string;
  readonly nowSeconds?: number;
}): Promise<SessionVerificationResult> {
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const parts = input.token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    return resultFailure("invalid_token");
  }

  const header = decodeJson(parts[0]);
  const payload = decodeJson(parts[1]);
  if (!header || !payload || typeof header.alg !== "string") {
    return resultFailure("invalid_token");
  }

  // The old signer and RSA key import are RS256-only. A different algorithm
  // is not a usable signature with the configured RSA key and is fail-closed
  // in the reference harness.
  if (header.alg !== PIRATE_SESSION_CONTRACT.algorithm) {
    return resultFailure("invalid_token");
  }

  let signature: Uint8Array;
  try {
    signature = base64UrlDecode(parts[2]);
  } catch {
    return resultFailure("invalid_token");
  }
  const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const validSignature = await subtle()
    .verify({ name: "RSASSA-PKCS1-v1_5" }, input.publicKey, signature, signingInput)
    .catch(() => false);
  if (!validSignature) return resultFailure("invalid_token");

  if (
    payload.iss !== PIRATE_SESSION_CONTRACT.issuer ||
    !audienceMatches(payload.aud, PIRATE_SESSION_CONTRACT.audience)
  ) {
    return resultFailure("invalid_claims");
  }

  if (payload.exp !== undefined) {
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
      return resultFailure("invalid_claims");
    }
    if (payload.exp <= nowSeconds) return resultFailure("token_expired");
  }
  if (payload.nbf !== undefined) {
    if (typeof payload.nbf !== "number" || !Number.isFinite(payload.nbf)) {
      return resultFailure("invalid_claims");
    }
    if (payload.nbf > nowSeconds) return resultFailure("token_not_yet_valid");
  }

  const rawUserId = typeof payload.sub === "string" ? payload.sub.trim() : "";
  if (!rawUserId) return resultFailure("authentication_failed");
  if (!userExists(input.controlPlane, rawUserId)) {
    return resultFailure("control_plane_record_missing");
  }

  const canonical = resolveCanonicalAsOldReference(input.controlPlane, rawUserId);
  if (!canonical) return resultFailure("canonical_alias_invalid");

  const scopeValue =
    typeof payload.scope === "string" && payload.scope.trim()
      ? payload.scope.trim()
      : PIRATE_SESSION_CONTRACT.defaultScope;
  const classification: SessionClassification =
    scopeValue === PIRATE_SESSION_CONTRACT.defaultScope ? "user" : "device";
  const scope: SessionScope = {
    value: scopeValue,
    tokens: scopeValue.split(/\s+/).filter(Boolean),
  };

  // This is the old requireScope behavior: user sessions bypass endpoint
  // scope checks; only non-default (device) sessions need the requested token.
  if (
    classification === "device" &&
    input.requiredScope &&
    !scope.tokens.includes(input.requiredScope)
  ) {
    return resultFailure("insufficient_scope");
  }

  return {
    ok: true,
    principal: {
      userId: canonical.canonicalUserId,
      classification,
      scope,
      canonical,
    },
  };
}

export async function createEphemeralSessionKeyPair(): Promise<{
  readonly privateKey: TestKey;
  readonly publicKey: TestKey;
  readonly publicJwk: SessionPublicJwk;
  readonly jwks: SessionJwks;
}> {
  const pair = await subtle().generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2_048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const exported = await subtle().exportKey("jwk", pair.publicKey);
  const n = typeof exported.n === "string" ? exported.n : "";
  const e = typeof exported.e === "string" ? exported.e : "";
  if (!n || !e || exported.kty !== "RSA") {
    throw new Error("Ephemeral RSA public key did not export as an RSA JWK");
  }
  const thumbprintInput = JSON.stringify({ e, kty: "RSA", n });
  const digest = await subtle().digest("SHA-256", new TextEncoder().encode(thumbprintInput));
  const publicJwk: SessionPublicJwk = {
    kty: "RSA",
    n,
    e,
    alg: "RS256",
    use: "sig",
    key_ops: ["verify"],
    kid: base64UrlEncode(new Uint8Array(digest)),
  };
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicJwk,
    jwks: { keys: [publicJwk] },
  };
}

export async function signSessionToken(input: {
  readonly privateKey: TestKey;
  readonly nowSeconds: number;
  readonly recipe: SessionTokenRecipe;
}): Promise<string> {
  const header: Record<string, unknown> = {
    alg: PIRATE_SESSION_CONTRACT.algorithm,
    typ: PIRATE_SESSION_CONTRACT.typ,
    ...input.recipe.header,
  };
  const claims: Record<string, unknown> = {
    iss: PIRATE_SESSION_CONTRACT.issuer,
    aud: PIRATE_SESSION_CONTRACT.audience,
    sub: "usr_session_vector",
    scope: PIRATE_SESSION_CONTRACT.defaultScope,
    iat: input.nowSeconds,
    exp: input.nowSeconds + PIRATE_SESSION_CONTRACT.defaultTtlSeconds,
    ...input.recipe.claims,
  };
  for (const claim of input.recipe.omitClaims ?? []) delete claims[claim];

  const encodedHeader = encodeJson(header);
  const encodedClaims = encodeJson(claims);
  const signingInput = new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`);
  const signature = await subtle().sign(
    { name: "RSASSA-PKCS1-v1_5" },
    input.privateKey,
    signingInput,
  );
  const encodedSignature = base64UrlEncode(new Uint8Array(signature));
  if (input.recipe.signature === "malformed") {
    const replacement = encodedSignature[0] === "A" ? "B" : "A";
    return `${encodedHeader}.${encodedClaims}.${replacement}${encodedSignature.slice(1)}`;
  }
  return `${encodedHeader}.${encodedClaims}.${encodedSignature}`;
}

function users(...userIds: string[]): readonly ControlPlaneUserRecord[] {
  return userIds.map((userId) => ({ userId }));
}

function bearerEvidence(...evidence: OldSourceEvidence[]): readonly OldSourceEvidence[] {
  return evidence;
}

const normalControlPlane: ControlPlaneFixture = { users: users("usr_session_vector"), aliases: [] };
const deviceControlPlane: ControlPlaneFixture = { users: users("usr_device_vector"), aliases: [] };

export const SESSION_CONFORMANCE_CORPUS: readonly SessionConformanceVector[] = [
  {
    id: "valid-normal-pirate-application-session",
    description: "JWT or Privy application exchange yields the default user bearer session.",
    credential: {
      credentialType: "exchange-proof",
      exchangeProof: "jwt_based_auth",
      resultingCredential: "bearer-session",
    },
    recipe: { claims: { sub: "usr_session_vector" } },
    controlPlane: normalControlPlane,
    expectedPrincipal: {
      userId: "usr_session_vector",
      classification: "user",
      scope: "pirate_app_session",
      canonicalUserId: "usr_session_vector",
    },
    sourceEvidence: bearerEvidence(
      OLD_SOURCE_EVIDENCE.authRoute,
      OLD_SOURCE_EVIDENCE.sessionToken,
      OLD_SOURCE_EVIDENCE.middleware,
      OLD_SOURCE_EVIDENCE.authRouteTest,
    ),
    expectation: { oldReference: "accept", contract: "accept" },
  },
  {
    id: "valid-telegram-mini-app-session",
    description: "Telegram Mini App exchange mints the same default-scope bearer session.",
    credential: {
      credentialType: "exchange-proof",
      exchangeProof: "telegram_mini_app_init_data",
      resultingCredential: "bearer-session",
    },
    recipe: { claims: { sub: "usr_telegram_vector" } },
    controlPlane: { users: users("usr_telegram_vector"), aliases: [] },
    expectedPrincipal: {
      userId: "usr_telegram_vector",
      classification: "user",
      scope: "pirate_app_session",
      canonicalUserId: "usr_telegram_vector",
    },
    sourceEvidence: bearerEvidence(
      OLD_SOURCE_EVIDENCE.telegramRoute,
      OLD_SOURCE_EVIDENCE.telegramOnboarding,
      OLD_SOURCE_EVIDENCE.sessionToken,
    ),
    expectation: { oldReference: "accept", contract: "accept" },
  },
  {
    id: "valid-bot-admin-session",
    description: "Bot provisioning token issuance also mints the default user bearer session.",
    credential: {
      credentialType: "exchange-proof",
      exchangeProof: "bot_admin_token",
      resultingCredential: "bearer-session",
    },
    recipe: { claims: { sub: "usr_bot_vector" } },
    controlPlane: { users: users("usr_bot_vector"), aliases: [] },
    expectedPrincipal: {
      userId: "usr_bot_vector",
      classification: "user",
      scope: "pirate_app_session",
      canonicalUserId: "usr_bot_vector",
    },
    sourceEvidence: bearerEvidence(
      OLD_SOURCE_EVIDENCE.botRoute,
      OLD_SOURCE_EVIDENCE.sessionToken,
      OLD_SOURCE_EVIDENCE.middleware,
    ),
    expectation: { oldReference: "accept", contract: "accept" },
  },
  {
    id: "valid-oauth-device-session",
    description:
      "OAuth device token issuance uses the shared mint with requested non-default scope.",
    credential: {
      credentialType: "exchange-proof",
      exchangeProof: "oauth_device_code",
      resultingCredential: "bearer-session",
    },
    recipe: { claims: { sub: "usr_device_vector", scope: "profile:read" } },
    controlPlane: deviceControlPlane,
    requiredScope: "profile:read",
    expectedPrincipal: {
      userId: "usr_device_vector",
      classification: "device",
      scope: "profile:read",
      canonicalUserId: "usr_device_vector",
    },
    sourceEvidence: bearerEvidence(
      OLD_SOURCE_EVIDENCE.oauthDevice,
      OLD_SOURCE_EVIDENCE.sessionToken,
      OLD_SOURCE_EVIDENCE.middleware,
      OLD_SOURCE_EVIDENCE.authRouteTest,
    ),
    expectation: { oldReference: "accept", contract: "accept" },
  },
  {
    id: "valid-oauth-device-multiple-scopes",
    description: "Device scopes are whitespace-delimited and required-scope checks exact tokens.",
    credential: {
      credentialType: "exchange-proof",
      exchangeProof: "oauth_device_code",
      resultingCredential: "bearer-session",
    },
    recipe: { claims: { sub: "usr_device_vector", scope: "live_room:attach profile:read" } },
    controlPlane: deviceControlPlane,
    requiredScope: "profile:read",
    expectedPrincipal: {
      userId: "usr_device_vector",
      classification: "device",
      scope: "live_room:attach profile:read",
      canonicalUserId: "usr_device_vector",
    },
    sourceEvidence: bearerEvidence(
      OLD_SOURCE_EVIDENCE.oauthDevice,
      OLD_SOURCE_EVIDENCE.middleware,
      OLD_SOURCE_EVIDENCE.authRouteTest,
    ),
    expectation: { oldReference: "accept", contract: "accept" },
  },
  {
    id: "valid-user-session-required-scope-bypass",
    description:
      "The old requireScope implementation lets a default user session pass a device scope check.",
    credential: { credentialType: "bearer-session" },
    recipe: { claims: { sub: "usr_session_vector" } },
    controlPlane: normalControlPlane,
    requiredScope: "profile:read",
    expectedPrincipal: {
      userId: "usr_session_vector",
      classification: "user",
      scope: "pirate_app_session",
      canonicalUserId: "usr_session_vector",
    },
    sourceEvidence: bearerEvidence(
      OLD_SOURCE_EVIDENCE.middleware,
      OLD_SOURCE_EVIDENCE.middlewareTest,
    ),
    expectation: {
      oldReference: "accept",
      contract: "accept",
      note: "Endpoint policy may later add an explicit user/device classification guard.",
    },
  },
  {
    id: "valid-canonical-user-alias",
    description: "A present source user resolves through an active alias to the canonical user id.",
    credential: { credentialType: "bearer-session" },
    recipe: { claims: { sub: "usr_alias_source" } },
    controlPlane: {
      users: users("usr_alias_source", "usr_alias_canonical"),
      aliases: [
        {
          sourceUserId: "usr_alias_source",
          canonicalUserId: "usr_alias_canonical",
          kind: "alias",
          status: "active",
        },
      ],
    },
    expectedPrincipal: {
      userId: "usr_alias_canonical",
      classification: "user",
      scope: "pirate_app_session",
      canonicalUserId: "usr_alias_canonical",
    },
    sourceEvidence: bearerEvidence(
      OLD_SOURCE_EVIDENCE.middleware,
      OLD_SOURCE_EVIDENCE.aliasService,
      OLD_SOURCE_EVIDENCE.userQueries,
    ),
    expectation: { oldReference: "accept", contract: "accept" },
  },
  {
    id: "valid-default-scope-when-omitted",
    description: "The old verifier treats an omitted scope claim as pirate_app_session.",
    credential: { credentialType: "bearer-session" },
    recipe: { omitClaims: ["scope"] },
    controlPlane: normalControlPlane,
    expectedPrincipal: {
      userId: "usr_session_vector",
      classification: "user",
      scope: "pirate_app_session",
      canonicalUserId: "usr_session_vector",
    },
    sourceEvidence: bearerEvidence(
      OLD_SOURCE_EVIDENCE.sessionToken,
      OLD_SOURCE_EVIDENCE.middleware,
    ),
    expectation: { oldReference: "accept", contract: "accept" },
  },
  {
    id: "valid-default-scope-when-empty",
    description: "The old verifier trims an empty scope and falls back to pirate_app_session.",
    credential: { credentialType: "bearer-session" },
    recipe: { claims: { scope: "   " } },
    controlPlane: normalControlPlane,
    expectedPrincipal: {
      userId: "usr_session_vector",
      classification: "user",
      scope: "pirate_app_session",
      canonicalUserId: "usr_session_vector",
    },
    sourceEvidence: bearerEvidence(
      OLD_SOURCE_EVIDENCE.sessionToken,
      OLD_SOURCE_EVIDENCE.middleware,
    ),
    expectation: { oldReference: "accept", contract: "accept" },
  },
  {
    id: "reject-wrong-algorithm",
    description: "A deliberately non-RS256 protected header is rejected.",
    credential: { credentialType: "bearer-session" },
    recipe: { header: { alg: "HS256" } },
    controlPlane: normalControlPlane,
    sourceEvidence: bearerEvidence(
      OLD_SOURCE_EVIDENCE.sessionToken,
      OLD_SOURCE_EVIDENCE.middleware,
    ),
    expectation: {
      oldReference: "reject",
      contract: "reject",
      oldFailure: "invalid_token",
      contractFailure: "invalid_token",
    },
  },
  {
    id: "reject-wrong-typ-contract",
    description: "The old verifier does not inspect typ; the decided contract requires JWT.",
    credential: { credentialType: "bearer-session" },
    recipe: { header: { typ: "not-jwt" } },
    controlPlane: normalControlPlane,
    sourceEvidence: bearerEvidence(
      OLD_SOURCE_EVIDENCE.sessionToken,
      OLD_SOURCE_EVIDENCE.middleware,
    ),
    expectation: {
      oldReference: "accept",
      contract: "reject",
      contractFailure: "invalid_token",
      note: "Old source sets typ on issuance but passes no typ requirement to jwtVerify.",
    },
  },
  {
    id: "reject-wrong-issuer",
    description: "Issuer mismatch is rejected by jwtVerify claim validation.",
    credential: { credentialType: "bearer-session" },
    recipe: { claims: { iss: "unexpected-issuer" } },
    controlPlane: normalControlPlane,
    sourceEvidence: bearerEvidence(
      OLD_SOURCE_EVIDENCE.sessionToken,
      OLD_SOURCE_EVIDENCE.middleware,
      OLD_SOURCE_EVIDENCE.authRouteTest,
    ),
    expectation: {
      oldReference: "reject",
      contract: "reject",
      oldFailure: "invalid_claims",
      contractFailure: "invalid_claims",
    },
  },
  {
    id: "reject-wrong-audience",
    description: "Audience mismatch is rejected by jwtVerify claim validation.",
    credential: { credentialType: "bearer-session" },
    recipe: { claims: { aud: "unexpected-audience" } },
    controlPlane: normalControlPlane,
    sourceEvidence: bearerEvidence(
      OLD_SOURCE_EVIDENCE.sessionToken,
      OLD_SOURCE_EVIDENCE.middleware,
      OLD_SOURCE_EVIDENCE.authRouteTest,
    ),
    expectation: {
      oldReference: "reject",
      contract: "reject",
      oldFailure: "invalid_claims",
      contractFailure: "invalid_claims",
    },
  },
  {
    id: "reject-missing-sub",
    description: "Missing subject fails after signature and standard claim verification.",
    credential: { credentialType: "bearer-session" },
    recipe: { omitClaims: ["sub"] },
    controlPlane: normalControlPlane,
    sourceEvidence: bearerEvidence(
      OLD_SOURCE_EVIDENCE.sessionToken,
      OLD_SOURCE_EVIDENCE.middleware,
    ),
    expectation: {
      oldReference: "reject",
      contract: "reject",
      oldFailure: "authentication_failed",
      contractFailure: "authentication_failed",
    },
  },
  {
    id: "reject-empty-sub",
    description: "Whitespace-only subject fails the old middleware's trim check.",
    credential: { credentialType: "bearer-session" },
    recipe: { claims: { sub: "   " } },
    controlPlane: normalControlPlane,
    sourceEvidence: bearerEvidence(
      OLD_SOURCE_EVIDENCE.sessionToken,
      OLD_SOURCE_EVIDENCE.middleware,
    ),
    expectation: {
      oldReference: "reject",
      contract: "reject",
      oldFailure: "authentication_failed",
      contractFailure: "authentication_failed",
    },
  },
  {
    id: "contract-reject-missing-iat",
    description:
      "The old verifier accepts a signed token without iat; the decided contract requires it.",
    credential: { credentialType: "bearer-session" },
    recipe: { omitClaims: ["iat"] },
    controlPlane: normalControlPlane,
    sourceEvidence: bearerEvidence(
      OLD_SOURCE_EVIDENCE.sessionToken,
      OLD_SOURCE_EVIDENCE.middleware,
    ),
    expectation: {
      oldReference: "accept",
      contract: "reject",
      contractFailure: "invalid_claims",
      note: "Unsupported by old verification code: iat is set during minting but not required during verify.",
    },
  },
  {
    id: "contract-reject-missing-exp",
    description:
      "The old verifier accepts a signed token without exp; the decided contract requires it.",
    credential: { credentialType: "bearer-session" },
    recipe: { omitClaims: ["exp"] },
    controlPlane: normalControlPlane,
    sourceEvidence: bearerEvidence(
      OLD_SOURCE_EVIDENCE.sessionToken,
      OLD_SOURCE_EVIDENCE.middleware,
    ),
    expectation: {
      oldReference: "accept",
      contract: "reject",
      contractFailure: "invalid_claims",
      note: "Unsupported by old verification code: exp is set during minting but not required during verify.",
    },
  },
  {
    id: "reject-malformed-exp",
    description: "A non-numeric exp claim is rejected by JWT claim validation.",
    credential: { credentialType: "bearer-session" },
    recipe: { claims: { exp: "never" } },
    controlPlane: normalControlPlane,
    sourceEvidence: bearerEvidence(OLD_SOURCE_EVIDENCE.sessionToken),
    expectation: {
      oldReference: "reject",
      contract: "reject",
      oldFailure: "invalid_claims",
      contractFailure: "invalid_claims",
    },
  },
  {
    id: "reject-zero-ttl-exp",
    description: "An exp equal to the verification time is expired and rejected.",
    credential: { credentialType: "bearer-session" },
    recipe: { claims: { exp: 0 } },
    controlPlane: normalControlPlane,
    sourceEvidence: bearerEvidence(
      OLD_SOURCE_EVIDENCE.sessionToken,
      OLD_SOURCE_EVIDENCE.authRouteTest,
    ),
    expectation: {
      oldReference: "reject",
      contract: "reject",
      oldFailure: "token_expired",
      contractFailure: "token_expired",
    },
  },
  {
    id: "reject-negative-ttl-exp",
    description: "A negative exp is expired and rejected.",
    credential: { credentialType: "bearer-session" },
    recipe: { claims: { exp: -1 } },
    controlPlane: normalControlPlane,
    sourceEvidence: bearerEvidence(OLD_SOURCE_EVIDENCE.sessionToken),
    expectation: {
      oldReference: "reject",
      contract: "reject",
      oldFailure: "token_expired",
      contractFailure: "token_expired",
    },
  },
  {
    id: "reject-expired",
    description: "An otherwise valid token whose exp is in the past is rejected.",
    credential: { credentialType: "bearer-session" },
    recipe: { claims: { exp: 1_700_000_000 } },
    controlPlane: normalControlPlane,
    sourceEvidence: bearerEvidence(
      OLD_SOURCE_EVIDENCE.sessionToken,
      OLD_SOURCE_EVIDENCE.authRouteTest,
    ),
    expectation: {
      oldReference: "reject",
      contract: "reject",
      oldFailure: "token_expired",
      contractFailure: "token_expired",
    },
  },
  {
    id: "reject-not-yet-valid",
    description: "A future nbf is rejected by JWT claim validation.",
    credential: { credentialType: "bearer-session" },
    recipe: { claims: { nbf: 4_000_000_000 } },
    controlPlane: normalControlPlane,
    sourceEvidence: bearerEvidence(OLD_SOURCE_EVIDENCE.sessionToken),
    expectation: {
      oldReference: "reject",
      contract: "reject",
      oldFailure: "token_not_yet_valid",
      contractFailure: "token_not_yet_valid",
    },
  },
  {
    id: "reject-missing-required-scope",
    description: "A device token without the required scope is rejected.",
    credential: { credentialType: "bearer-session" },
    recipe: { claims: { sub: "usr_device_vector", scope: "profile:read" } },
    controlPlane: deviceControlPlane,
    requiredScope: "live_room:manage",
    sourceEvidence: bearerEvidence(
      OLD_SOURCE_EVIDENCE.middleware,
      OLD_SOURCE_EVIDENCE.authRouteTest,
    ),
    expectation: {
      oldReference: "reject",
      contract: "reject",
      oldFailure: "insufficient_scope",
      contractFailure: "insufficient_scope",
    },
  },
  {
    id: "reject-wrong-required-scope",
    description: "A device token with a different scope is rejected.",
    credential: { credentialType: "bearer-session" },
    recipe: { claims: { sub: "usr_device_vector", scope: "live_room:attach" } },
    controlPlane: deviceControlPlane,
    requiredScope: "profile:read",
    sourceEvidence: bearerEvidence(OLD_SOURCE_EVIDENCE.middleware, OLD_SOURCE_EVIDENCE.oauthDevice),
    expectation: {
      oldReference: "reject",
      contract: "reject",
      oldFailure: "insufficient_scope",
      contractFailure: "insufficient_scope",
    },
  },
  {
    id: "reject-malformed-signature",
    description: "A signature mutation is rejected without exposing the token.",
    credential: { credentialType: "bearer-session" },
    recipe: { signature: "malformed" },
    controlPlane: normalControlPlane,
    sourceEvidence: bearerEvidence(
      OLD_SOURCE_EVIDENCE.sessionToken,
      OLD_SOURCE_EVIDENCE.middlewareTest,
    ),
    expectation: {
      oldReference: "reject",
      contract: "reject",
      oldFailure: "invalid_token",
      contractFailure: "invalid_token",
    },
  },
  {
    id: "reject-wrong-public-key",
    description:
      "The valid token is rejected when verified against a deliberately different RSA key.",
    credential: { credentialType: "bearer-session" },
    recipe: {},
    controlPlane: normalControlPlane,
    sourceEvidence: bearerEvidence(
      OLD_SOURCE_EVIDENCE.sessionToken,
      OLD_SOURCE_EVIDENCE.discoveryRouteTest,
    ),
    expectation: {
      oldReference: "reject",
      contract: "reject",
      oldFailure: "invalid_token",
      contractFailure: "invalid_token",
    },
  },
  {
    id: "contract-reject-classification-mismatch",
    description: "The old middleware has no classification guard; the future contract records one.",
    credential: { credentialType: "bearer-session" },
    recipe: { claims: { sub: "usr_session_vector" } },
    controlPlane: normalControlPlane,
    requiredClassification: "device",
    sourceEvidence: bearerEvidence(
      OLD_SOURCE_EVIDENCE.middleware,
      OLD_SOURCE_EVIDENCE.middlewareTest,
    ),
    expectation: {
      oldReference: "accept",
      contract: "reject",
      contractFailure: "classification_mismatch",
      note: "The old middleware's route policy does not define a classification mismatch guard.",
    },
  },
  {
    id: "reject-unknown-control-plane-user",
    description: "A signed token for a user absent from the control plane is rejected.",
    credential: { credentialType: "bearer-session" },
    recipe: { claims: { sub: "usr_missing_control_plane" } },
    controlPlane: normalControlPlane,
    sourceEvidence: bearerEvidence(
      OLD_SOURCE_EVIDENCE.middleware,
      OLD_SOURCE_EVIDENCE.userQueries,
      OLD_SOURCE_EVIDENCE.identityRepository,
      OLD_SOURCE_EVIDENCE.authRouteTest,
    ),
    expectation: {
      oldReference: "reject",
      contract: "reject",
      oldFailure: "control_plane_record_missing",
      contractFailure: "control_plane_record_missing",
    },
  },
  {
    id: "contract-reject-missing-canonical-user",
    description:
      "The old alias resolver returns a missing canonical target; the future contract must fail closed.",
    credential: { credentialType: "bearer-session" },
    recipe: { claims: { sub: "usr_alias_source" } },
    controlPlane: {
      users: users("usr_alias_source"),
      aliases: [
        {
          sourceUserId: "usr_alias_source",
          canonicalUserId: "usr_missing_canonical",
          kind: "alias",
          status: "active",
        },
      ],
    },
    sourceEvidence: bearerEvidence(
      OLD_SOURCE_EVIDENCE.middleware,
      OLD_SOURCE_EVIDENCE.aliasService,
      OLD_SOURCE_EVIDENCE.userQueries,
    ),
    expectation: {
      oldReference: "accept",
      contract: "reject",
      contractFailure: "control_plane_record_missing",
      note: "Old middleware checks the source user before alias resolution but does not re-check the canonical target.",
    },
  },
  {
    id: "reject-canonical-alias-cycle",
    description: "An alias cycle cannot resolve to a safe canonical principal.",
    credential: { credentialType: "bearer-session" },
    recipe: { claims: { sub: "usr_alias_source" } },
    controlPlane: {
      users: users("usr_alias_source", "usr_alias_target"),
      aliases: [
        {
          sourceUserId: "usr_alias_source",
          canonicalUserId: "usr_alias_target",
          kind: "alias",
          status: "active",
        },
        {
          sourceUserId: "usr_alias_target",
          canonicalUserId: "usr_alias_source",
          kind: "alias",
          status: "active",
        },
      ],
    },
    sourceEvidence: bearerEvidence(
      OLD_SOURCE_EVIDENCE.aliasService,
      OLD_SOURCE_EVIDENCE.middleware,
    ),
    expectation: {
      oldReference: "reject",
      contract: "reject",
      oldFailure: "canonical_alias_invalid",
      contractFailure: "canonical_alias_invalid",
    },
  },
  {
    id: "contract-reject-malformed-iat",
    description:
      "The old verifier does not validate iat's type; the future contract requires a numeric timestamp.",
    credential: { credentialType: "bearer-session" },
    recipe: { claims: { iat: "now" } },
    controlPlane: normalControlPlane,
    sourceEvidence: bearerEvidence(OLD_SOURCE_EVIDENCE.sessionToken),
    expectation: {
      oldReference: "accept",
      contract: "reject",
      contractFailure: "invalid_claims",
      note: "Unsupported by old verification code: iat is minted but not validated.",
    },
  },
  {
    id: "contract-reject-nonstring-scope",
    description:
      "The old verifier defaults a non-string scope; the future contract should reject malformed scope claims.",
    credential: { credentialType: "bearer-session" },
    recipe: { claims: { scope: 42 } },
    controlPlane: normalControlPlane,
    sourceEvidence: bearerEvidence(
      OLD_SOURCE_EVIDENCE.sessionToken,
      OLD_SOURCE_EVIDENCE.middleware,
    ),
    expectation: {
      oldReference: "accept",
      contract: "reject",
      contractFailure: "invalid_claims",
      note: "Old source uses a string check and falls back to the default scope.",
    },
  },
] as const;

export type MaterializedSessionVector = SessionConformanceVector & {
  readonly token: string;
  readonly verificationKey: TestKey;
  readonly publicJwk: SessionPublicJwk;
};

export type MaterializedSessionCorpus = {
  readonly nowSeconds: number;
  readonly keyPair: Awaited<ReturnType<typeof createEphemeralSessionKeyPair>>;
  readonly wrongKeyPair: Awaited<ReturnType<typeof createEphemeralSessionKeyPair>>;
  readonly vectors: readonly MaterializedSessionVector[];
};

export async function materializeSessionCorpus(
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<MaterializedSessionCorpus> {
  const keyPair = await createEphemeralSessionKeyPair();
  const wrongKeyPair = await createEphemeralSessionKeyPair();
  const vectors = await Promise.all(
    SESSION_CONFORMANCE_CORPUS.map(async (vector) => ({
      ...vector,
      token: await signSessionToken({
        privateKey: keyPair.privateKey,
        nowSeconds,
        recipe: vector.recipe,
      }),
      verificationKey:
        vector.id === "reject-wrong-public-key" ? wrongKeyPair.publicKey : keyPair.publicKey,
      publicJwk: keyPair.publicJwk,
    })),
  );
  return { nowSeconds, keyPair, wrongKeyPair, vectors };
}

export async function inspectSessionToken(token: string): Promise<{
  readonly header: Record<string, unknown>;
  readonly claims: Record<string, unknown>;
}> {
  const parts = token.split(".");
  const header = parts[0] ? decodeJson(parts[0]) : null;
  const claims = parts[1] ? decodeJson(parts[1]) : null;
  if (!header || !claims) throw new Error("Malformed test token");
  return { header, claims };
}
