export const CLOUDFLARE_ACCESS_JWT_POLICY_V1 = "pirate-cloudflare-access-jwt-v1" as const;
export const ACCESS_JWKS_CACHE_MAX_SECONDS = 3_600 as const;
export const ACCESS_JWT_CLOCK_SKEW_SECONDS = 60 as const;
export const ACCESS_JWT_MAX_BYTES = 16_384 as const;
export const ACCESS_JWKS_MAX_BYTES = 65_536 as const;
export const ACCESS_JWKS_DEADLINE_MS = 2_000 as const;

export type CloudflareAccessJwtFailureReasonV1 = "misconfigured" | "access_denied";

export class CloudflareAccessJwtFailure extends Error {
  readonly name = "CloudflareAccessJwtFailure";

  constructor(readonly reason: CloudflareAccessJwtFailureReasonV1) {
    super(`Cloudflare Access JWT failed: ${reason}`);
  }
}

export interface CloudflareAccessJwtClockV1 {
  readonly nowUnixSeconds: () => number;
}

export type CloudflareAccessJwtFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface CloudflareAccessJwtValidatorV1 {
  readonly verify: (jwt: string, signal?: AbortSignal) => Promise<void>;
}

interface AccessJwtHeader {
  readonly alg: "RS256";
  readonly kid: string;
}

interface AccessJwtClaims {
  readonly iss: string;
  readonly aud: string | readonly string[];
  readonly iat: number;
  readonly exp: number;
  readonly nbf?: number;
}

interface AccessRsaJwk {
  readonly kty: "RSA";
  readonly kid: string;
  readonly n: string;
  readonly e: string;
}

interface CachedJwks {
  readonly keys: readonly AccessRsaJwk[];
  readonly expiresAt: number;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;
const kidPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

function utf8Length(value: string): number {
  return encoder.encode(value).byteLength;
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  return owned.buffer;
}

function decodeBase64Url(value: string): Uint8Array {
  if (!base64UrlPattern.test(value)) throw new CloudflareAccessJwtFailure("access_denied");
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const canonical = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
    if (canonical !== value) throw new Error("noncanonical base64url");
    return bytes;
  } catch {
    throw new CloudflareAccessJwtFailure("access_denied");
  }
}

function wholeSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validHeader(value: unknown): value is AccessJwtHeader {
  return (
    typeof value === "object" &&
    value !== null &&
    "alg" in value &&
    value.alg === "RS256" &&
    "kid" in value &&
    typeof value.kid === "string" &&
    kidPattern.test(value.kid)
  );
}

function validClaims(value: unknown): value is AccessJwtClaims {
  if (typeof value !== "object" || value === null || !("aud" in value)) return false;
  const audience = value.aud;
  return (
    "iss" in value &&
    typeof value.iss === "string" &&
    (typeof audience === "string" ||
      (Array.isArray(audience) &&
        audience.length > 0 &&
        audience.every((entry) => typeof entry === "string"))) &&
    "iat" in value &&
    wholeSeconds(value.iat) &&
    "exp" in value &&
    wholeSeconds(value.exp) &&
    value.exp > value.iat &&
    (!("nbf" in value) || value.nbf === undefined || wholeSeconds(value.nbf))
  );
}

function decodeHeaderPart(value: string): AccessJwtHeader {
  try {
    const decoded: unknown = JSON.parse(decoder.decode(decodeBase64Url(value)));
    if (!validHeader(decoded)) throw new Error("invalid header");
    return decoded;
  } catch {
    throw new CloudflareAccessJwtFailure("access_denied");
  }
}

function decodeClaimsPart(value: string): AccessJwtClaims {
  try {
    const decoded: unknown = JSON.parse(decoder.decode(decodeBase64Url(value)));
    if (!validClaims(decoded)) throw new Error("invalid claims");
    return decoded;
  } catch {
    throw new CloudflareAccessJwtFailure("access_denied");
  }
}

function validJwk(value: unknown): value is AccessRsaJwk {
  if (typeof value !== "object" || value === null) return false;
  return (
    "kty" in value &&
    value.kty === "RSA" &&
    "kid" in value &&
    typeof value.kid === "string" &&
    kidPattern.test(value.kid) &&
    "n" in value &&
    typeof value.n === "string" &&
    base64UrlPattern.test(value.n) &&
    "e" in value &&
    typeof value.e === "string" &&
    base64UrlPattern.test(value.e) &&
    (!("alg" in value) || value.alg === undefined || value.alg === "RS256") &&
    (!("use" in value) || value.use === undefined || value.use === "sig") &&
    !("d" in value) &&
    !("p" in value) &&
    !("q" in value) &&
    !("dp" in value) &&
    !("dq" in value) &&
    !("qi" in value) &&
    !("oth" in value)
  );
}

function parseJwks(bytes: Uint8Array): readonly AccessRsaJwk[] {
  try {
    const decoded: unknown = JSON.parse(decoder.decode(bytes));
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      !("keys" in decoded) ||
      !Array.isArray(decoded.keys) ||
      decoded.keys.length === 0 ||
      decoded.keys.length > 32 ||
      !decoded.keys.every(validJwk) ||
      new Set(decoded.keys.map((key) => key.kid)).size !== decoded.keys.length
    ) {
      throw new Error("invalid key set");
    }
    return decoded.keys.map((key) => Object.freeze({ ...key }));
  } catch {
    throw new CloudflareAccessJwtFailure("access_denied");
  }
}

function exactIssuer(value: string): string {
  try {
    const issuer = new URL(value);
    if (
      issuer.protocol !== "https:" ||
      issuer.username !== "" ||
      issuer.password !== "" ||
      issuer.pathname !== "/" ||
      issuer.search !== "" ||
      issuer.hash !== "" ||
      !issuer.hostname.endsWith(".cloudflareaccess.com") ||
      value !== issuer.origin
    ) {
      throw new Error("invalid issuer");
    }
    return issuer.origin;
  } catch {
    throw new CloudflareAccessJwtFailure("misconfigured");
  }
}

interface DeadlineSignal {
  readonly signal: AbortSignal;
  readonly interrupt: Promise<never>;
  readonly finish: () => void;
}

function awaitWithCallerAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted)
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function deadlineSignal(parent: AbortSignal | undefined): DeadlineSignal {
  const controller = new AbortController();
  let rejectInterrupt: ((reason?: unknown) => void) | undefined;
  const interrupt = new Promise<never>((_resolve, reject) => {
    rejectInterrupt = reject;
  });
  void interrupt.catch(() => undefined);
  const onAbort = (): void => {
    const reason = parent?.reason ?? new DOMException("Aborted", "AbortError");
    controller.abort(reason);
    rejectInterrupt?.(reason);
  };
  if (parent?.aborted) onAbort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    const reason = new DOMException("Access JWKS timed out", "TimeoutError");
    controller.abort(reason);
    rejectInterrupt?.(reason);
  }, ACCESS_JWKS_DEADLINE_MS);
  return {
    signal: controller.signal,
    interrupt,
    finish: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

async function readBoundedResponse(
  response: Response,
  interrupt: Promise<never>,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > ACCESS_JWKS_MAX_BYTES)
  ) {
    throw new CloudflareAccessJwtFailure("access_denied");
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await Promise.race([reader.read(), interrupt]);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > ACCESS_JWKS_MAX_BYTES) {
        await reader.cancel();
        throw new CloudflareAccessJwtFailure("access_denied");
      }
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
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

function audienceContains(audience: string | readonly string[], expected: string): boolean {
  return typeof audience === "string" ? audience === expected : audience.includes(expected);
}

export function makeCloudflareAccessJwtValidatorV1(options: {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string;
  readonly clock: CloudflareAccessJwtClockV1;
  readonly fetchImpl?: CloudflareAccessJwtFetch;
}): CloudflareAccessJwtValidatorV1 {
  const issuer = exactIssuer(options.issuer);
  const expectedJwksUrl = `${issuer}/cdn-cgi/access/certs`;
  if (
    options.jwksUrl !== expectedJwksUrl ||
    !kidPattern.test(options.audience) ||
    !Number.isSafeInteger(options.clock.nowUnixSeconds())
  ) {
    throw new CloudflareAccessJwtFailure("misconfigured");
  }
  let cached: CachedJwks | undefined;
  let inFlight: Promise<readonly AccessRsaJwk[]> | undefined;

  const loadKeys = async (force: boolean): Promise<readonly AccessRsaJwk[]> => {
    const now = options.clock.nowUnixSeconds();
    if (!force && cached !== undefined && now < cached.expiresAt) return cached.keys;
    if (!force && inFlight !== undefined) return inFlight;
    const load = (async () => {
      const deadline = deadlineSignal(undefined);
      try {
        const response = await Promise.race([
          (options.fetchImpl ?? fetch)(options.jwksUrl, {
            method: "GET",
            headers: { accept: "application/json" },
            redirect: "manual",
            signal: deadline.signal,
          }),
          deadline.interrupt,
        ]);
        if (
          response.status !== 200 ||
          response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
            "application/json"
        ) {
          throw new CloudflareAccessJwtFailure("access_denied");
        }
        const keys = parseJwks(await readBoundedResponse(response, deadline.interrupt));
        const fetchedAt = options.clock.nowUnixSeconds();
        cached = { keys, expiresAt: fetchedAt + ACCESS_JWKS_CACHE_MAX_SECONDS };
        return keys;
      } catch (error) {
        if (error instanceof CloudflareAccessJwtFailure) throw error;
        throw new CloudflareAccessJwtFailure("access_denied");
      } finally {
        deadline.finish();
      }
    })();
    if (!force) inFlight = load;
    try {
      return await load;
    } finally {
      if (!force && inFlight === load) inFlight = undefined;
    }
  };

  return Object.freeze({
    verify: async (jwt: string, signal?: AbortSignal): Promise<void> => {
      if (utf8Length(jwt) > ACCESS_JWT_MAX_BYTES) {
        throw new CloudflareAccessJwtFailure("access_denied");
      }
      const parts = jwt.split(".");
      if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
        throw new CloudflareAccessJwtFailure("access_denied");
      }
      const header = decodeHeaderPart(parts[0] ?? "");
      const claims = decodeClaimsPart(parts[1] ?? "");
      const now = options.clock.nowUnixSeconds();
      if (
        !Number.isSafeInteger(now) ||
        claims.iss !== issuer ||
        !audienceContains(claims.aud, options.audience) ||
        claims.iat > now + ACCESS_JWT_CLOCK_SKEW_SECONDS ||
        claims.exp <= now - ACCESS_JWT_CLOCK_SKEW_SECONDS ||
        (claims.nbf !== undefined && claims.nbf > now + ACCESS_JWT_CLOCK_SKEW_SECONDS)
      ) {
        throw new CloudflareAccessJwtFailure("access_denied");
      }
      let keys = await awaitWithCallerAbort(loadKeys(false), signal);
      let jwk = keys.find((key) => key.kid === header.kid);
      if (jwk === undefined) {
        keys = await awaitWithCallerAbort(loadKeys(true), signal);
        jwk = keys.find((key) => key.kid === header.kid);
      }
      if (jwk === undefined) throw new CloudflareAccessJwtFailure("access_denied");
      try {
        const key = await crypto.subtle.importKey(
          "jwk",
          jwk,
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        );
        const valid = await crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          key,
          ownedArrayBuffer(decodeBase64Url(parts[2] ?? "")),
          encoder.encode(`${parts[0]}.${parts[1]}`),
        );
        if (!valid) throw new CloudflareAccessJwtFailure("access_denied");
      } catch (error) {
        if (error instanceof CloudflareAccessJwtFailure) throw error;
        throw new CloudflareAccessJwtFailure("access_denied");
      }
    },
  });
}
