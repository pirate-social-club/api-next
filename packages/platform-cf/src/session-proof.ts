import { PersonaWalletProofRejected, type PersonaWalletProofVerifier } from "@pirate/application";
import {
  SessionProofRejected,
  type SessionProofVerifier,
} from "@pirate/application/use-cases/session-exchange";
import { Effect } from "effect";

export const SESSION_PROOF_MAX_TOKEN_LENGTH = 16 * 1024;
export const SESSION_PROOF_MAX_JWKS_BYTES = 64 * 1024;
export const SESSION_PROOF_MAX_USER_BYTES = 64 * 1024;
export const SESSION_PROOF_FETCH_TIMEOUT_MS = 5_000;
export const SESSION_PROOF_CACHE_TTL_MS = 5 * 60 * 1_000;

const RSA_VERIFY_ALGORITHM = {
  name: "RSASSA-PKCS1-v1_5",
  hash: "SHA-256",
} as const;
const RSA_IMPORT_ALGORITHM = RSA_VERIFY_ALGORITHM;
const EC_VERIFY_ALGORITHM = {
  name: "ECDSA",
  hash: "SHA-256",
} as const;
const EC_IMPORT_ALGORITHM = {
  name: "ECDSA",
  namedCurve: "P-256",
} as const;

type JsonObject = Record<string, unknown>;
type ValidJwkBase = {
  readonly use: "sig";
  readonly kid: string;
  readonly key_ops?: readonly ["verify"];
};
type ValidRsaJwk = ValidJwkBase & {
  readonly kty: "RSA";
  readonly alg: "RS256";
  readonly n: string;
  readonly e: string;
};
type ValidEcJwk = ValidJwkBase & {
  readonly kty: "EC";
  readonly alg: "ES256";
  readonly crv: "P-256";
  readonly x: string;
  readonly y: string;
};
type ValidJwk = ValidRsaJwk | ValidEcJwk;

type RsaJwkImporter = {
  readonly importKey: (
    format: "jwk",
    keyData: ValidRsaJwk,
    algorithm: typeof RSA_VERIFY_ALGORITHM,
    extractable: false,
    usages: readonly ["verify"],
  ) => Promise<CryptoKey>;
};

type EcJwkImporter = {
  readonly importKey: (
    format: "jwk",
    keyData: ValidEcJwk,
    algorithm: typeof EC_IMPORT_ALGORITHM,
    extractable: false,
    usages: readonly ["verify"],
  ) => Promise<CryptoKey>;
};

export interface SessionProofProviderConfig {
  readonly jwksUrl: string;
  readonly issuer: string;
  readonly audience: string;
}

/**
 * Privy server-API credentials for the linked-wallet lookup. The access token
 * alone does not carry wallet attestation; the account's provider-owned
 * linked accounts do.
 */
export interface SessionProofPrivyApiConfig {
  readonly apiUrl: string;
  readonly appId: string;
  readonly appSecret: string;
}

export type SessionProofFetcher = (input: string, init?: RequestInit) => Promise<Response>;

const SESSION_PROOF_FAILURE_REASONS = new Set([
  "invalid token",
  "invalid header",
  "JWKS request failed",
  "JWKS response too large",
  "unknown key",
  "algorithm mismatch",
  "invalid ECDSA signature",
  "invalid signature",
  "invalid issuer",
  "invalid audience",
  "expired token",
  "future token",
  "not yet valid",
  "identity mismatch",
  "wallet mismatch",
]);

function safeSessionProofFailureReason(error: unknown): string {
  if (!(error instanceof Error) || !SESSION_PROOF_FAILURE_REASONS.has(error.message)) {
    return "internal_error";
  }
  return error.message.replaceAll(" ", "_").toLowerCase();
}

export interface SessionProofAdapterOptions {
  readonly privy: SessionProofProviderConfig;
  readonly privyApi?: SessionProofPrivyApiConfig;
  readonly fetcher?: SessionProofFetcher;
  readonly nowMs?: () => number;
  readonly fetchTimeoutMs?: number;
  readonly cacheTtlMs?: number;
}

type VerifiedProviderToken = {
  readonly sourceUserId: string;
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

function configuredApiUrl(value: string): string {
  const url = new URL(configuredString(value));
  if (url.protocol !== "https:") throw new Error("provider API URL must use HTTPS");
  return url.toString().replace(/\/+$/u, "");
}

function configuredString(value: string): string {
  if (!value || value.trim() !== value || value.includes("\r") || value.includes("\n")) {
    throw new Error("invalid provider configuration");
  }
  return value;
}

function base64UrlMember(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]+$/u.test(value);
}

function exactP256Coordinate(value: unknown): value is string {
  if (!base64UrlMember(value)) return false;
  try {
    return base64UrlDecode(value).byteLength === 32;
  } catch {
    return false;
  }
}

function commonJwkIsValid(key: JsonObject): boolean {
  return (
    key.use === "sig" &&
    typeof key.kid === "string" &&
    /^[A-Za-z0-9._-]{1,256}$/u.test(key.kid) &&
    (key.key_ops === undefined ||
      (Array.isArray(key.key_ops) && key.key_ops.length === 1 && key.key_ops[0] === "verify"))
  );
}

function validateJwk(value: unknown): ValidJwk {
  const key = object(value);
  if (!commonJwkIsValid(key)) throw new Error("invalid JWKS key");
  if (
    key.kty === "RSA" &&
    key.alg === "RS256" &&
    base64UrlMember(key.n) &&
    base64UrlMember(key.e) &&
    !["d", "dp", "dq", "p", "q", "qi", "oth"].some((member) => member in key)
  ) {
    return key as unknown as ValidRsaJwk;
  }
  if (
    key.kty === "EC" &&
    key.alg === "ES256" &&
    key.crv === "P-256" &&
    exactP256Coordinate(key.x) &&
    exactP256Coordinate(key.y) &&
    !("d" in key)
  ) {
    return key as unknown as ValidEcJwk;
  }
  throw new Error("invalid JWKS key");
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

function canonicalWalletAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const canonical = value.toLowerCase();
  return /^0x[0-9a-f]{40}$/u.test(canonical) ? canonical : null;
}

const PRIVY_LINKED_WALLET_TYPE = "wallet";
const PRIVY_ETHEREUM_CHAIN_TYPE = "ethereum";

/**
 * Mirrors the legacy control-plane rule: only provider-attested Ethereum
 * wallet accounts count, addresses are canonical lowercase, and duplicates
 * collapse. A structurally unexpected document is rejected whole.
 */
function collectLinkedEthereumWallets(document: unknown): readonly string[] {
  const accounts = object(document).linked_accounts;
  if (!Array.isArray(accounts)) throw new Error("invalid provider user document");
  const wallets = new Set<string>();
  for (const account of accounts) {
    if (account === null || typeof account !== "object" || Array.isArray(account)) continue;
    const record = account as JsonObject;
    if (
      record.type !== PRIVY_LINKED_WALLET_TYPE ||
      record.chain_type !== PRIVY_ETHEREUM_CHAIN_TYPE
    ) {
      continue;
    }
    const address = canonicalWalletAddress(record.address);
    if (address !== null) wallets.add(address);
  }
  return [...wallets];
}

type PrivyEmbeddedEvmWallet = Readonly<{
  privyWalletId: string | null;
  hdWalletIndex: number;
  address: string;
}>;

/** Persona assignments accept only provider-owned embedded EVM wallets. */
function collectPrivyEmbeddedEvmWallets(document: unknown): readonly PrivyEmbeddedEvmWallet[] {
  const accounts = object(document).linked_accounts;
  if (!Array.isArray(accounts)) throw new Error("invalid provider user document");
  const wallets: PrivyEmbeddedEvmWallet[] = [];
  for (const account of accounts) {
    if (account === null || typeof account !== "object" || Array.isArray(account)) continue;
    const record = account as JsonObject;
    if (
      record.type !== PRIVY_LINKED_WALLET_TYPE ||
      record.chain_type !== PRIVY_ETHEREUM_CHAIN_TYPE ||
      record.wallet_client !== "privy" ||
      record.wallet_client_type !== "privy" ||
      record.connector_type !== "embedded" ||
      record.imported !== false
    ) {
      continue;
    }
    const address = canonicalWalletAddress(record.address);
    const walletIndex = record.wallet_index;
    const walletId = record.id;
    if (
      address === null ||
      typeof walletIndex !== "number" ||
      !Number.isSafeInteger(walletIndex) ||
      walletIndex < 0 ||
      (walletId !== null &&
        (typeof walletId !== "string" ||
          walletId.length === 0 ||
          walletId.length > 128 ||
          walletId.trim() !== walletId))
    ) {
      throw new Error("invalid provider embedded wallet");
    }
    wallets.push({
      privyWalletId: walletId as string | null,
      hdWalletIndex: walletIndex,
      address,
    });
  }
  return wallets;
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

/**
 * Privy is an external identity proof, not an api-next session or machine
 * credential. Its documented subject is `sub`; api-next classification and
 * scopes are intentionally not accepted on this boundary.
 */
function directPrivySubject(claims: JsonObject): string {
  if (
    "user_id" in claims ||
    "userId" in claims ||
    "classification" in claims ||
    "scope" in claims
  ) {
    throw new Error("unsupported Privy identity claims");
  }
  return claimString(claims, "sub");
}

/**
 * Build Privy and generic JWT proof adapters. JWKS documents are cached only
 * after complete validation; an unknown kid gets one bounded refresh.
 */
export function makeJwksSessionProofVerifier(
  options: SessionProofAdapterOptions,
): SessionProofVerifier & PersonaWalletProofVerifier {
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
      audience: configuredString(options.privy.audience),
    },
  };
  const privyApi =
    options.privyApi === undefined
      ? undefined
      : {
          apiUrl: configuredApiUrl(options.privyApi.apiUrl),
          appId: configuredString(options.privyApi.appId),
          appSecret: configuredString(options.privyApi.appSecret),
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

  /**
   * Reads the bounded provider user document. Session exchange treats an
   * unavailable document as walletless; persona-wallet attestation fails
   * closed. Neither caller receives provider response detail.
   */
  const lookupPrivyUser = async (sourceUserId: string): Promise<unknown | undefined> => {
    if (privyApi === undefined) return undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
    try {
      const response = await fetcher(
        `${privyApi.apiUrl}/api/v1/users/${encodeURIComponent(sourceUserId)}`,
        {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: `Basic ${btoa(`${privyApi.appId}:${privyApi.appSecret}`)}`,
            "privy-app-id": privyApi.appId,
          },
          signal: controller.signal,
        },
      );
      if (!response.ok) return undefined;
      const body = await response.text();
      if (body.length > SESSION_PROOF_MAX_USER_BYTES) return undefined;
      const document = object(JSON.parse(body));
      if (document.id !== sourceUserId) return undefined;
      return document;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  };

  const lookupLinkedEthereumWallets = async (
    sourceUserId: string,
  ): Promise<readonly string[] | undefined> => {
    const document = await lookupPrivyUser(sourceUserId);
    return document === undefined ? undefined : collectLinkedEthereumWallets(document);
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
    if (
      (header.alg !== "RS256" && header.alg !== "ES256") ||
      header.typ !== "JWT" ||
      typeof header.kid !== "string" ||
      !/^[A-Za-z0-9._-]{1,256}$/u.test(header.kid)
    ) {
      throw new Error("invalid header");
    }

    let keys = await getJwks(provider.jwksUrl);
    let jwk = keys.find((key) => key.kid === header.kid);
    if (jwk === undefined) {
      keys = await getJwks(provider.jwksUrl, true);
      jwk = keys.find((key) => key.kid === header.kid);
    }
    if (jwk === undefined) throw new Error("unknown key");
    const signature = base64UrlDecode(parts[2] as string);
    const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    let valid: boolean;
    if (header.alg === "RS256") {
      if (jwk.kty !== "RSA" || jwk.alg !== "RS256") throw new Error("algorithm mismatch");
      const key = await (crypto.subtle as unknown as RsaJwkImporter).importKey(
        "jwk",
        jwk,
        RSA_IMPORT_ALGORITHM,
        false,
        ["verify"],
      );
      valid = await crypto.subtle.verify(RSA_VERIFY_ALGORITHM, key, signature, signingInput);
    } else {
      if (jwk.kty !== "EC" || jwk.alg !== "ES256" || jwk.crv !== "P-256") {
        throw new Error("algorithm mismatch");
      }
      if (signature.byteLength !== 64) throw new Error("invalid ECDSA signature");
      const key = await (crypto.subtle as unknown as EcJwkImporter).importKey(
        "jwk",
        jwk,
        EC_IMPORT_ALGORITHM,
        false,
        ["verify"],
      );
      valid = await crypto.subtle.verify(EC_VERIFY_ALGORITHM, key, signature, signingInput);
    }
    if (!valid) throw new Error("invalid signature");

    if (claims.iss !== provider.issuer) throw new Error("invalid issuer");
    if (!audienceMatches(claims.aud, provider.audience)) {
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
      sourceUserId: directPrivySubject(claims),
      claims,
    };
  };

  const run = <A>(operation: () => Promise<A>): Effect.Effect<A, SessionProofRejected> =>
    Effect.tryPromise({
      try: operation,
      catch: (error) => {
        console.warn("session_proof_rejected", safeSessionProofFailureReason(error));
        return new SessionProofRejected();
      },
    });

  const runPersonaWalletProof = <A>(
    operation: () => Promise<A>,
  ): Effect.Effect<A, PersonaWalletProofRejected> =>
    Effect.tryPromise({
      try: operation,
      catch: (error) =>
        error instanceof PersonaWalletProofRejected
          ? error
          : new PersonaWalletProofRejected({ reason: "invalid" }),
    });

  return {
    verifyPrivy: ({ accessToken, identityToken, walletAddress }) =>
      run(async () => {
        const access = await verifyProviderToken(accessToken, providers.privy);
        if (identityToken !== null) {
          const identity = await verifyProviderToken(identityToken, providers.privy);
          if (identity.sourceUserId !== access.sourceUserId) throw new Error("identity mismatch");
        }
        const snakeClaim = access.claims.wallet_address;
        const camelClaim = access.claims.walletAddress;
        const claimedSnake = snakeClaim === undefined ? null : canonicalWalletAddress(snakeClaim);
        const claimedCamel = camelClaim === undefined ? null : canonicalWalletAddress(camelClaim);
        if (
          (snakeClaim !== undefined && claimedSnake === null) ||
          (camelClaim !== undefined && claimedCamel === null) ||
          (snakeClaim !== undefined && camelClaim !== undefined && claimedSnake !== claimedCamel)
        ) {
          throw new Error("wallet mismatch");
        }
        const claimedWallet = claimedSnake ?? claimedCamel;
        const requestedWallet =
          walletAddress === null ? null : canonicalWalletAddress(walletAddress);
        if (walletAddress !== null && requestedWallet === null) {
          throw new Error("wallet mismatch");
        }
        let resolvedWallet = claimedWallet;
        if (resolvedWallet === null && privyApi !== undefined) {
          const linkedWallets = await lookupLinkedEthereumWallets(access.sourceUserId);
          if (linkedWallets !== undefined) {
            if (requestedWallet !== null && linkedWallets.includes(requestedWallet)) {
              resolvedWallet = requestedWallet;
            } else if (requestedWallet === null && linkedWallets.length === 1) {
              // Exactly one provider-linked wallet is unambiguous; with zero
              // or several, auth never picks from incidental ordering.
              resolvedWallet = linkedWallets[0] ?? null;
            }
          }
        }
        if (requestedWallet !== null && resolvedWallet !== requestedWallet) {
          throw new Error("wallet mismatch");
        }
        return {
          sourceUserId: access.sourceUserId,
          // Direct Privy proofs are accepted only as external user identity;
          // machine/session classification is owned by api-next tokens.
          classification: "user",
          ...(resolvedWallet === null ? {} : { walletAddress: resolvedWallet }),
        };
      }),
    verifyPrivyEmbeddedEvmWallet: ({ accessToken, identityToken, hdWalletIndex }) =>
      runPersonaWalletProof(async () => {
        if (!Number.isSafeInteger(hdWalletIndex) || hdWalletIndex < 0) {
          throw new PersonaWalletProofRejected({ reason: "invalid" });
        }
        const access = await verifyProviderToken(accessToken, providers.privy);
        if (identityToken !== null) {
          const identity = await verifyProviderToken(identityToken, providers.privy);
          if (identity.sourceUserId !== access.sourceUserId) {
            throw new PersonaWalletProofRejected({ reason: "invalid" });
          }
        }
        const document = await lookupPrivyUser(access.sourceUserId);
        if (document === undefined) {
          throw new PersonaWalletProofRejected({ reason: "unavailable" });
        }
        let wallets: readonly PrivyEmbeddedEvmWallet[];
        try {
          wallets = collectPrivyEmbeddedEvmWallets(document).filter(
            (wallet) => wallet.hdWalletIndex === hdWalletIndex,
          );
        } catch {
          throw new PersonaWalletProofRejected({ reason: "unavailable" });
        }
        if (wallets.length !== 1) {
          throw new PersonaWalletProofRejected({ reason: "unavailable" });
        }
        const wallet = wallets[0] as PrivyEmbeddedEvmWallet;
        return { sourceUserId: access.sourceUserId, ...wallet };
      }),
  };
}
