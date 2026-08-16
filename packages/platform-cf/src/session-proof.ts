import {
  SessionProofRejected,
  type SessionProofVerifier,
} from "@pirate/application/use-cases/session-exchange";
import { Effect } from "effect";

export const SESSION_PROOF_MAX_TOKEN_LENGTH = 16 * 1024;
export const SESSION_PROOF_MAX_JWKS_BYTES = 64 * 1024;
export const SESSION_PROOF_FETCH_TIMEOUT_MS = 5_000;
export const SESSION_PROOF_CACHE_TTL_MS = 5 * 60 * 1_000;

const RSA_VERIFY_ALGORITHM = {
  name: "RSASSA-PKCS1-v1_5",
  hash: "SHA-256",
} as const;

type JsonObject = Record<string, unknown>;
type ValidJwk = JsonWebKey & {
  readonly kid: string;
  readonly n: string;
  readonly e: string;
};

export interface SessionProofProviderConfig {
  readonly jwksUrl: string;
  readonly issuer: string;
  readonly audience?: string;
}

export type SessionProofFetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface SessionProofAdapterOptions {
  readonly privy: SessionProofProviderConfig;
  readonly jwt: SessionProofProviderConfig;
  readonly fetcher?: SessionProofFetcher;
  readonly nowMs?: () => number;
  readonly fetchTimeoutMs?: number;
  readonly cacheTtlMs?: number;
}

type VerifiedProviderToken = {
  readonly sourceUserId: string;
  readonly classification: "user" | "device";
  readonly claims: JsonObject;
};

type CachedJwks = {
  readonly keys: readonly ValidJwk[];
  readonly expiresAt: number;
};

function object(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("object required");
  }
  return value as JsonObject;
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid base64url");
  const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat(
    (4 - (value.length % 4)) % 4,
  )}`;
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function decodeJson(value: string): JsonObject {
  return object(JSON.parse(new TextDecoder().decode(base64UrlDecode(value))));
}

function positiveBound(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("invalid bound");
  return value;
}

function configuredUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("JWKS URL must use HTTPS");
  return url.toString();
}

function configuredString(value: string): string {
  if (!value || value.trim() !== value || value.includes("\r") || value.includes("\n")) {
    throw new Error("invalid provider configuration");
  }
  return value;
}

function validateJwk(value: unknown): ValidJwk {
  const key = object(value);
  if (
    key.kty !== "RSA" ||
    key.alg !== "RS256" ||
    key.use !== "sig" ||
    typeof key.kid !== "string" ||
    !/^[A-Za-z0-9._-]{1,256}$/u.test(key.kid) ||
    typeof key.n !== "string" ||
    typeof key.e !== "string" ||
    (key.key_ops !== undefined &&
      (!Array.isArray(key.key_ops) || !key.key_ops.includes("verify"))) ||
    ["d", "dp", "dq", "p", "q", "qi", "oth"].some((member) => member in key)
  ) {
    throw new Error("invalid JWKS key");
  }
  return key as unknown as ValidJwk;
}

function validateJwks(value: unknown): readonly ValidJwk[] {
  const keys = object(value).keys;
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > 16) {
    throw new Error("invalid JWKS document");
  }
  return keys.map(validateJwk);
}

function claimString(claims: JsonObject, name: string): string {
  const value = claims[name];
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error("invalid claim");
  }
  return value;
}

function claimTime(claims: JsonObject, name: string): number | undefined {
  const value = claims[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("invalid time");
  return value;
}

function audienceMatches(value: unknown, expected: string): boolean {
  return typeof value === "string"
    ? value === expected
    : Array.isArray(value) &&
        value.every((item) => typeof item === "string") &&
        value.includes(expected);
}

function classify(claims: JsonObject): "user" | "device" {
  const explicit = claims.classification;
  if (explicit !== undefined) {
    if (explicit !== "user" && explicit !== "device") throw new Error("invalid classification");
    return explicit;
  }
  const scope = claims.scope;
  if (scope !== undefined && typeof scope !== "string") throw new Error("invalid scope");
  return scope === undefined || scope === "pirate_app_session" ? "user" : "device";
}

function sourceUserId(claims: JsonObject): string {
  const value = "sub" in claims ? claims.sub : claims.user_id;
  return claimString({ source: value }, "source");
}

/**
 * Build Privy and generic JWT proof adapters. JWKS documents are cached only
 * after complete validation; an unknown kid gets one bounded refresh.
 */
export function makeJwksSessionProofVerifier(
  options: SessionProofAdapterOptions,
): SessionProofVerifier {
  const fetcher = options.fetcher ?? fetch;
  const nowMs = options.nowMs ?? Date.now;
  const fetchTimeoutMs = positiveBound(options.fetchTimeoutMs, SESSION_PROOF_FETCH_TIMEOUT_MS);
  const cacheTtlMs = positiveBound(options.cacheTtlMs, SESSION_PROOF_CACHE_TTL_MS);
  const cache = new Map<string, CachedJwks>();
  const providers = {
    privy: {
      ...options.privy,
      jwksUrl: configuredUrl(options.privy.jwksUrl),
      issuer: configuredString(options.privy.issuer),
      ...(options.privy.audience === undefined
        ? {}
        : { audience: configuredString(options.privy.audience) }),
    },
    jwt: {
      ...options.jwt,
      jwksUrl: configuredUrl(options.jwt.jwksUrl),
      issuer: configuredString(options.jwt.issuer),
      ...(options.jwt.audience === undefined
        ? {}
        : { audience: configuredString(options.jwt.audience) }),
    },
  };

  const getJwks = async (url: string, forceRefresh = false): Promise<readonly ValidJwk[]> => {
    const cached = cache.get(url);
    if (!forceRefresh && cached !== undefined && cached.expiresAt > nowMs()) return cached.keys;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
    try {
      const response = await fetcher(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("JWKS request failed");
      const body = await response.text();
      if (body.length > SESSION_PROOF_MAX_JWKS_BYTES) throw new Error("JWKS response too large");
      const keys = validateJwks(JSON.parse(body));
      cache.set(url, { keys, expiresAt: nowMs() + cacheTtlMs });
      return keys;
    } finally {
      clearTimeout(timeout);
    }
  };

  const verifyProviderToken = async (
    token: string,
    provider: SessionProofProviderConfig,
  ): Promise<VerifiedProviderToken> => {
    if (
      typeof token !== "string" ||
      token.length === 0 ||
      token.length > SESSION_PROOF_MAX_TOKEN_LENGTH
    ) {
      throw new Error("invalid token");
    }
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((part) => part.length === 0))
      throw new Error("invalid token");
    const header = decodeJson(parts[0] as string);
    const claims = decodeJson(parts[1] as string);
    if (header.alg !== "RS256" || header.typ !== "JWT" || typeof header.kid !== "string") {
      throw new Error("invalid header");
    }

    let keys = await getJwks(provider.jwksUrl);
    let jwk = keys.find((key) => key.kid === header.kid);
    if (jwk === undefined) {
      keys = await getJwks(provider.jwksUrl, true);
      jwk = keys.find((key) => key.kid === header.kid);
    }
    if (jwk === undefined) throw new Error("unknown key");
    const key = await crypto.subtle.importKey("jwk", jwk, RSA_VERIFY_ALGORITHM, false, ["verify"]);
    const valid = await crypto.subtle.verify(
      RSA_VERIFY_ALGORITHM,
      key,
      (() => {
        const signature = base64UrlDecode(parts[2] as string);
        const owned = new Uint8Array(new ArrayBuffer(signature.byteLength));
        owned.set(signature);
        return owned;
      })(),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    if (!valid) throw new Error("invalid signature");

    if (claims.iss !== provider.issuer) throw new Error("invalid issuer");
    if (provider.audience !== undefined && !audienceMatches(claims.aud, provider.audience)) {
      throw new Error("invalid audience");
    }
    const now = Math.floor(nowMs() / 1_000);
    const exp = claimTime(claims, "exp");
    if (exp === undefined || exp <= now) throw new Error("expired token");
    const iat = claimTime(claims, "iat");
    if (iat !== undefined && iat > now) throw new Error("future token");
    const nbf = claimTime(claims, "nbf");
    if (nbf !== undefined && nbf > now) throw new Error("not yet valid");
    return {
      sourceUserId: sourceUserId(claims),
      classification: classify(claims),
      claims,
    };
  };

  const run = <A>(operation: () => Promise<A>): Effect.Effect<A, SessionProofRejected> =>
    Effect.tryPromise({
      try: operation,
      catch: () => new SessionProofRejected(),
    });

  return {
    verifyJwt: ({ jwt }) =>
      run(() => verifyProviderToken(jwt, providers.jwt)).pipe(
        Effect.map(({ sourceUserId, classification }) => ({ sourceUserId, classification })),
      ),
    verifyPrivy: ({ accessToken, identityToken, walletAddress }) =>
      run(async () => {
        const access = await verifyProviderToken(accessToken, providers.privy);
        if (identityToken !== null) {
          const identity = await verifyProviderToken(identityToken, providers.privy);
          if (identity.sourceUserId !== access.sourceUserId) throw new Error("identity mismatch");
        }
        if (walletAddress !== null) {
          const claimed = access.claims.wallet_address ?? access.claims.walletAddress;
          if (typeof claimed !== "string" || claimed !== walletAddress) {
            throw new Error("wallet mismatch");
          }
        }
        return {
          sourceUserId: access.sourceUserId,
          classification: access.classification,
        };
      }),
  };
}
