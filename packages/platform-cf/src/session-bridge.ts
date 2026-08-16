import { Data } from "effect";

const SESSION_ALGORITHM = "RS256" as const;
const SESSION_TYPE = "JWT" as const;
const DEFAULT_ISSUER = "pirate-api";
const DEFAULT_AUDIENCE = "pirate-app";
const DEFAULT_SCOPE = "pirate_app_session";
const DEFAULT_TTL_SECONDS = 3_600;
/** Conservative bound for this fixed-claim bearer token before any decoding. */
export const MAX_SESSION_TOKEN_LENGTH = 16 * 1024;
const RSA_IMPORT_ALGORITHM = {
  name: "RSASSA-PKCS1-v1_5",
  hash: "SHA-256",
} as const;

const PRIVATE_JWK_MEMBERS = new Set(["d", "dp", "dq", "p", "q", "qi", "oth"]);

export type SessionBridgeErrorCode =
  | "configuration_invalid"
  | "key_import_failed"
  | "key_pair_mismatch"
  | "token_malformed"
  | "token_header_invalid"
  | "token_signature_invalid"
  | "subject_invalid"
  | "claims_invalid"
  | "token_expired"
  | "token_not_yet_valid";

/** Safe for an HTTP boundary: it carries no token, PEM, provider error, or key. */
export class SessionBridgeError extends Data.TaggedError("SessionBridgeError")<{
  readonly code: SessionBridgeErrorCode;
  readonly operation: "configure" | "mint" | "verify" | "jwks";
}> {}

export interface SessionBridgeEnvironment {
  readonly PIRATE_APP_JWT_PRIVATE_KEY?: string;
  readonly PIRATE_APP_JWT_PUBLIC_KEY?: string;
  readonly PIRATE_APP_JWT_ISSUER?: string;
  readonly PIRATE_APP_JWT_AUDIENCE?: string;
  readonly PIRATE_APP_JWT_TTL_SECONDS?: string;
}

export interface SessionBridgeOptions {
  readonly privateKeyPem?: string;
  readonly publicKeyPem: string;
  readonly issuer?: string;
  readonly audience?: string;
  readonly defaultScope?: string;
  readonly defaultTtlSeconds?: number;
  readonly nowSeconds?: () => number;
}

export interface SessionClaimsInput {
  readonly sub: string;
  readonly scope?: string;
  readonly iat?: number;
  readonly exp?: number;
  readonly ttlSeconds?: number;
}

export interface VerifiedSessionClaims {
  readonly iss: string;
  readonly aud: string;
  readonly sub: string;
  readonly scope: string;
  readonly iat: number;
  readonly exp: number;
  readonly nbf?: number;
}

export interface SessionPublicJwk {
  readonly kty: "RSA";
  readonly n: string;
  readonly e: string;
  readonly alg: typeof SESSION_ALGORITHM;
  readonly use: "sig";
  readonly key_ops: readonly ["verify"];
  readonly kid: string;
}

export interface SessionJwks {
  readonly keys: readonly [SessionPublicJwk];
}

export interface SessionBridge {
  readonly issuer: string;
  readonly audience: string;
  readonly defaultScope: string;
  readonly defaultTtlSeconds: number;
  readonly sign: (claims: SessionClaimsInput) => Promise<string>;
  readonly verify: (token: string) => Promise<VerifiedSessionClaims>;
  readonly jwks: () => SessionJwks;
}

function error(
  operation: SessionBridgeError["operation"],
  code: SessionBridgeErrorCode,
): SessionBridgeError {
  return new SessionBridgeError({ operation, code });
}

function configuredString(
  value: string | undefined,
  fallback: string | undefined,
  operation: SessionBridgeError["operation"],
): string {
  const resolved = (value ?? fallback)?.trim();
  if (!resolved || resolved.includes("\n") || resolved.includes("\r")) {
    throw error(operation, "configuration_invalid");
  }
  return resolved;
}

function positiveInteger(value: number, operation: SessionBridgeError["operation"]): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw error(operation, "configuration_invalid");
  }
  return value;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid base64url");
  const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat(
    (4 - (value.length % 4)) % 4,
  )}`;
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encodeJson(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeJson(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(value)));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON object required");
  }
  return parsed as Record<string, unknown>;
}

function pemToDer(pem: string, label: "PRIVATE KEY" | "PUBLIC KEY"): ArrayBuffer {
  const normalized = pem.trim();
  const prefix = `-----BEGIN ${label}-----`;
  const suffix = `-----END ${label}-----`;
  if (!normalized.startsWith(prefix) || !normalized.endsWith(suffix)) {
    throw new Error("invalid PEM");
  }
  const body = normalized
    .slice(prefix.length, normalized.length - suffix.length)
    .replace(/\s+/gu, "")
    .replace(/=+$/u, "");
  if (!body) throw new Error("empty PEM");
  const bytes = base64UrlDecode(body.replaceAll("+", "-").replaceAll("/", "_"));
  const owned = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  owned.set(bytes);
  return owned.buffer;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    pemToDer(pem, "PRIVATE KEY"),
    RSA_IMPORT_ALGORITHM,
    false,
    ["sign"],
  );
}

async function importPublicKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("spki", pemToDer(pem, "PUBLIC KEY"), RSA_IMPORT_ALGORITHM, true, [
    "verify",
  ]);
}

async function thumbprint(n: string, e: string): Promise<string> {
  const canonical = JSON.stringify({ e, kty: "RSA", n });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return base64UrlEncode(new Uint8Array(digest));
}

async function publicMaterial(publicKey: CryptoKey): Promise<SessionPublicJwk> {
  const exported = await crypto.subtle.exportKey("jwk", publicKey);
  if (typeof exported !== "object" || exported === null || Array.isArray(exported)) {
    throw new Error("invalid public JWK");
  }
  const exportedJwk = exported as unknown as Record<string, unknown>;
  if (
    exportedJwk.kty !== "RSA" ||
    typeof exportedJwk.n !== "string" ||
    typeof exportedJwk.e !== "string" ||
    Object.entries(exportedJwk).some(
      ([member, value]) => PRIVATE_JWK_MEMBERS.has(member) && value !== undefined,
    )
  ) {
    throw new Error("invalid public JWK");
  }
  const n = exportedJwk.n;
  const e = exportedJwk.e;
  return {
    kty: "RSA",
    n,
    e,
    alg: SESSION_ALGORITHM,
    use: "sig",
    key_ops: ["verify"],
    kid: await thumbprint(n, e),
  };
}

function validateConfiguredValue(
  value: string,
  operation: SessionBridgeError["operation"],
): string {
  if (!value || value.trim() !== value || value.includes("\n") || value.includes("\r")) {
    throw error(operation, "configuration_invalid");
  }
  return value;
}

function validatePemValue(value: string, operation: SessionBridgeError["operation"]): string {
  if (!value || value.trim() !== value || value.includes("\r")) {
    throw error(operation, "configuration_invalid");
  }
  return value;
}

function validateClaimsInput(
  input: SessionClaimsInput,
  issuer: string,
  audience: string,
  defaultScope: string,
  defaultTtlSeconds: number,
  nowSeconds: number,
): { readonly payload: VerifiedSessionClaims } {
  const sub = validateConfiguredValue(input.sub, "mint");
  const scope = validateConfiguredValue(input.scope ?? defaultScope, "mint");
  const iat = input.iat ?? nowSeconds;
  positiveInteger(iat, "mint");
  if (iat > nowSeconds) throw error("mint", "claims_invalid");
  const ttlSeconds = input.ttlSeconds ?? defaultTtlSeconds;
  positiveInteger(ttlSeconds, "mint");
  const exp = input.exp ?? iat + ttlSeconds;
  positiveInteger(exp, "mint");
  if (exp <= iat) throw error("mint", "claims_invalid");
  if (input.exp !== undefined && input.ttlSeconds !== undefined) {
    throw error("mint", "claims_invalid");
  }
  return { payload: { iss: issuer, aud: audience, sub, scope, iat, exp } };
}

function validateHeader(header: Record<string, unknown>, kid: string): void {
  const keys = Object.keys(header).sort();
  if (
    keys.some((key) => key !== "alg" && key !== "kid" && key !== "typ") ||
    header.alg !== SESSION_ALGORITHM ||
    header.typ !== SESSION_TYPE ||
    (header.kid !== undefined && header.kid !== kid)
  ) {
    throw error("verify", "token_header_invalid");
  }
}

function requiredString(
  claims: Record<string, unknown>,
  name: "iss" | "aud" | "sub" | "scope",
): string {
  const value = claims[name];
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    if (name === "sub") throw error("verify", "subject_invalid");
    throw error("verify", "claims_invalid");
  }
  return value;
}

function requiredTime(claims: Record<string, unknown>, name: "iat" | "exp"): number {
  const value = claims[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || (name === "iat" && value <= 0)) {
    throw error("verify", "claims_invalid");
  }
  return value;
}

function optionalTime(claims: Record<string, unknown>, name: "nbf"): number | undefined {
  const value = claims[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw error("verify", "claims_invalid");
  }
  return value;
}

function makeEnvironmentOptions(environment: SessionBridgeEnvironment): SessionBridgeOptions {
  const privateKeyPem = environment.PIRATE_APP_JWT_PRIVATE_KEY?.trim();
  const publicKeyPem = environment.PIRATE_APP_JWT_PUBLIC_KEY?.trim();
  const ttlRaw = environment.PIRATE_APP_JWT_TTL_SECONDS;
  const ttl = ttlRaw === undefined ? DEFAULT_TTL_SECONDS : Number(ttlRaw);
  if (ttlRaw !== undefined && !/^\d+$/u.test(ttlRaw.trim())) {
    throw error("configure", "configuration_invalid");
  }
  return {
    ...(privateKeyPem === undefined ? {} : { privateKeyPem }),
    publicKeyPem: publicKeyPem ?? "",
    issuer: environment.PIRATE_APP_JWT_ISSUER?.trim() || DEFAULT_ISSUER,
    audience: environment.PIRATE_APP_JWT_AUDIENCE?.trim() || DEFAULT_AUDIENCE,
    defaultTtlSeconds: ttl,
  };
}

/** Import one environment's same-key material and construct the platform primitive. */
export async function makeSessionBridgeFromEnv(
  environment: SessionBridgeEnvironment,
): Promise<SessionBridge> {
  return makeSessionBridge(makeEnvironmentOptions(environment));
}

/**
 * Construct the WebCrypto-only session primitive. Application classification,
 * alias resolution, and HTTP bearer extraction remain outside this module.
 */
export async function makeSessionBridge(options: SessionBridgeOptions): Promise<SessionBridge> {
  const publicKeyPem = validatePemValue(options.publicKeyPem, "configure");
  const issuer = configuredString(options.issuer, DEFAULT_ISSUER, "configure");
  const audience = configuredString(options.audience, DEFAULT_AUDIENCE, "configure");
  const defaultScope = configuredString(options.defaultScope, DEFAULT_SCOPE, "configure");
  const defaultTtlSeconds = positiveInteger(
    options.defaultTtlSeconds ?? DEFAULT_TTL_SECONDS,
    "configure",
  );
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1_000));

  let publicKey: CryptoKey;
  try {
    publicKey = await importPublicKey(publicKeyPem);
  } catch {
    throw error("configure", "key_import_failed");
  }

  let privateKey: CryptoKey | undefined;
  if (options.privateKeyPem !== undefined) {
    try {
      privateKey = await importPrivateKey(validatePemValue(options.privateKeyPem, "configure"));
      const probe = crypto.getRandomValues(new Uint8Array(32));
      const probeSignature = await crypto.subtle.sign(
        { name: "RSASSA-PKCS1-v1_5" },
        privateKey,
        probe,
      );
      const matchingPair = await crypto.subtle.verify(
        { name: "RSASSA-PKCS1-v1_5" },
        publicKey,
        probeSignature,
        probe,
      );
      if (!matchingPair) {
        throw error("configure", "key_pair_mismatch");
      }
    } catch (cause) {
      if (cause instanceof SessionBridgeError) throw cause;
      throw error("configure", "key_import_failed");
    }
  }

  let publicJwk: SessionPublicJwk;
  try {
    publicJwk = await publicMaterial(publicKey);
  } catch {
    throw error("configure", "key_import_failed");
  }

  const sign = async (input: SessionClaimsInput): Promise<string> => {
    if (privateKey === undefined) throw error("mint", "configuration_invalid");
    const now = nowSeconds();
    if (!Number.isSafeInteger(now) || now <= 0) throw error("mint", "claims_invalid");
    const { payload } = validateClaimsInput(
      input,
      issuer,
      audience,
      defaultScope,
      defaultTtlSeconds,
      now,
    );
    const encodedHeader = encodeJson({
      alg: SESSION_ALGORITHM,
      typ: SESSION_TYPE,
      kid: publicJwk.kid,
    });
    const encodedPayload = encodeJson(payload);
    const signingInput = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
    try {
      const signature = await crypto.subtle.sign(
        { name: "RSASSA-PKCS1-v1_5" },
        privateKey,
        signingInput,
      );
      return `${encodedHeader}.${encodedPayload}.${base64UrlEncode(new Uint8Array(signature))}`;
    } catch {
      throw error("mint", "key_import_failed");
    }
  };

  const verify = async (token: string): Promise<VerifiedSessionClaims> => {
    if (typeof token !== "string" || token.length === 0) {
      throw error("verify", "token_malformed");
    }
    if (token.length > MAX_SESSION_TOKEN_LENGTH) {
      throw error("verify", "token_malformed");
    }
    const parts = token.split(".");
    if (
      parts.length !== 3 ||
      parts.some((part) => part.length === 0 || part.length > MAX_SESSION_TOKEN_LENGTH)
    ) {
      throw error("verify", "token_malformed");
    }
    let header: Record<string, unknown>;
    let payload: Record<string, unknown>;
    let signature: Uint8Array;
    try {
      header = decodeJson(parts[0] as string);
      payload = decodeJson(parts[1] as string);
      signature = base64UrlDecode(parts[2] as string);
    } catch {
      throw error("verify", "token_malformed");
    }
    validateHeader(header, publicJwk.kid);
    try {
      const valid = await crypto.subtle.verify(
        { name: "RSASSA-PKCS1-v1_5" },
        publicKey,
        (() => {
          const owned = new Uint8Array(new ArrayBuffer(signature.byteLength));
          owned.set(signature);
          return owned;
        })(),
        new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
      );
      if (!valid) throw error("verify", "token_signature_invalid");
    } catch (cause) {
      if (cause instanceof SessionBridgeError) throw cause;
      throw error("verify", "token_signature_invalid");
    }

    const iss = requiredString(payload, "iss");
    const aud = requiredString(payload, "aud");
    const sub = requiredString(payload, "sub");
    const rawScope = payload.scope;
    const scope =
      rawScope === undefined
        ? defaultScope
        : typeof rawScope === "string" && rawScope.trim().length === 0
          ? defaultScope
          : requiredString(payload, "scope");
    const iat = requiredTime(payload, "iat");
    const exp = requiredTime(payload, "exp");
    const nbf = optionalTime(payload, "nbf");
    const now = nowSeconds();
    if (!Number.isSafeInteger(now) || now <= 0) throw error("verify", "claims_invalid");
    if (iss !== issuer || aud !== audience) {
      throw error("verify", "claims_invalid");
    }
    if (iat > now || (nbf !== undefined && nbf > now)) {
      throw error("verify", "token_not_yet_valid");
    }
    if (exp <= now) throw error("verify", "token_expired");
    if (exp <= iat) throw error("verify", "claims_invalid");
    return nbf === undefined
      ? { iss, aud, sub, scope, iat, exp }
      : { iss, aud, sub, scope, iat, exp, nbf };
  };

  return {
    issuer,
    audience,
    defaultScope,
    defaultTtlSeconds,
    sign,
    verify,
    jwks: () => ({ keys: [publicJwk] }),
  };
}
