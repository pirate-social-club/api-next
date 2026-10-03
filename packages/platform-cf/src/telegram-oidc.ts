import { createHash, timingSafeEqual } from "node:crypto";
import {
  type TelegramOidcClient,
  type TelegramOidcCode,
  TelegramOidcRejected,
} from "@pirate/application/telegram-oidc";
import { Effect, Option, Schema } from "effect";
import { createLocalJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import { type TelegramOidcFetch, telegramOidcJson } from "./telegram-oidc-http.ts";

const ISSUER = "https://oauth.telegram.org";
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const MAX_TOKEN_LENGTH = 16 * 1024;
const CACHE_TTL_MS = 5 * 60 * 1000;
const REFRESH_COOLDOWN_MS = 30 * 1000;
const MAX_AGE_SECONDS = 600;
const Token = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u));
const Text = Schema.NonEmptyString.check(Schema.isMaxLength(2048));
const Integer = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const KeyId = Schema.NonEmptyString.check(Schema.isMaxLength(128));
const Base64 = Schema.NonEmptyString.check(
  Schema.isMaxLength(1024),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/u),
);
const Key = Schema.Struct({
  kty: Schema.Literal("RSA"),
  kid: KeyId,
  n: Base64,
  e: Base64,
  alg: Schema.optional(Schema.Literal("RS256")),
  use: Schema.optional(Schema.Literal("sig")),
  key_ops: Schema.optional(Schema.Array(Schema.Literal("verify"))),
});
const Keys = Schema.Struct({ keys: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(32)) });
const Claims = Schema.Struct({
  iss: Schema.Literal(ISSUER),
  aud: Schema.NonEmptyString,
  sub: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  id: Integer.check(Schema.isGreaterThan(0)),
  nonce: Token,
  iat: Integer,
  exp: Integer,
});
const Code = Schema.Struct({ code: Text, nonce: Token, verifier: Token });
const TokenResponse = Schema.Struct({
  id_token: Schema.NonEmptyString.check(Schema.isMaxLength(MAX_TOKEN_LENGTH)),
});
const Configuration = Schema.Struct({
  clientId: Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,15}$/u)),
  clientSecret: Schema.NonEmptyString.check(Schema.isMaxLength(1024)),
  redirectUri: Schema.NonEmptyString,
});

export interface TelegramOidcOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly fetcher?: TelegramOidcFetch;
  readonly nowMs?: () => number;
  readonly timeoutMs?: number;
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function randomToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function sameNonce(actual: string, expected: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(actual).digest(),
    createHash("sha256").update(expected).digest(),
  );
}

function proofRejected(error: unknown): TelegramOidcRejected {
  return error instanceof TelegramOidcRejected
    ? error
    : new TelegramOidcRejected({ reason: "invalid_proof" });
}

export function makeTelegramOidcClient(options: TelegramOidcOptions): TelegramOidcClient {
  let config: typeof Configuration.Type;
  const timeoutMs = options.timeoutMs ?? 5000;
  try {
    config = Schema.decodeUnknownSync(Configuration)(options);
    const redirect = new URL(config.redirectUri);
    if (
      redirect.protocol !== "https:" ||
      redirect.username ||
      redirect.password ||
      redirect.search ||
      redirect.hash ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 5000
    )
      throw new Error();
  } catch {
    throw new Error("Telegram login configuration invalid");
  }
  const fetcher = options.fetcher ?? fetch;
  const now = options.nowMs ?? Date.now;
  let cache:
    | {
        readonly resolve: ReturnType<typeof createLocalJWKSet>;
        readonly ids: readonly string[];
        readonly expiresAt: number;
      }
    | undefined;
  let nextRefreshAt = 0;

  const load = async (signal: AbortSignal) => {
    nextRefreshAt = now() + REFRESH_COOLDOWN_MS;
    // No shared in-flight I/O promise: cached public keys may cross requests,
    // while every fetch belongs to the request that initiated it.
    const body = await telegramOidcJson(fetcher, JWKS_URL, {}, signal, timeoutMs, 64 * 1024);
    const decoded = Schema.decodeUnknownOption(Keys)(body);
    if (Option.isNone(decoded)) throw new TelegramOidcRejected({ reason: "provider_unavailable" });
    const parsed = decoded.value;
    const keys = parsed.keys.flatMap((entry) => {
      const result = Schema.decodeUnknownOption(Key)(entry);
      if (Option.isNone(result)) return [];
      const { alg, use, key_ops, ...key } = result.value;
      return [
        {
          ...key,
          ...(alg ? { alg } : {}),
          ...(use ? { use } : {}),
          ...(key_ops ? { key_ops: [...key_ops] } : {}),
        },
      ];
    });
    if (keys.length === 0 || new Set(keys.map((key) => key.kid)).size !== keys.length)
      throw new TelegramOidcRejected({ reason: "provider_unavailable" });
    cache = {
      resolve: createLocalJWKSet({ keys }),
      ids: keys.map((key) => key.kid),
      expiresAt: now() + CACHE_TTL_MS,
    };
  };
  const prepare = async (signal: AbortSignal) => {
    if (cache && cache.expiresAt > now()) return;
    if (now() < nextRefreshAt) {
      if (cache) return;
      throw new TelegramOidcRejected({ reason: "provider_unavailable" });
    }
    await load(signal);
  };
  const resolve =
    (signal: AbortSignal): JWTVerifyGetKey =>
    async (header, token) => {
      const id = Schema.decodeUnknownSync(KeyId)(header.kid);
      if (cache && cache.expiresAt > now() && cache.ids.includes(id))
        return cache.resolve(header, token);
      if (now() < nextRefreshAt) {
        if (cache?.ids.includes(id)) return cache.resolve(header, token);
        throw new TelegramOidcRejected({ reason: "provider_unavailable" });
      }
      await load(signal);
      if (!cache?.ids.includes(id)) throw new TelegramOidcRejected({ reason: "invalid_proof" });
      return cache.resolve(header, token);
    };

  return {
    prepare: () => Effect.tryPromise({ try: prepare, catch: proofRejected }),
    authorize: () =>
      Effect.tryPromise({
        try: async () => {
          const state = randomToken();
          const nonce = randomToken();
          const verifier = randomToken();
          const challenge = base64Url(
            new Uint8Array(
              await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
            ),
          );
          const url = new URL(`${ISSUER}/auth`);
          for (const [key, value] of Object.entries({
            client_id: config.clientId,
            redirect_uri: config.redirectUri,
            response_type: "code",
            scope: "openid profile",
            state,
            nonce,
            code_challenge: challenge,
            code_challenge_method: "S256",
          }))
            url.searchParams.set(key, value);
          return { authorizationUrl: url.toString(), state, nonce, verifier };
        },
        catch: () => new TelegramOidcRejected({ reason: "provider_unavailable" }),
      }),
    exchange: (input: TelegramOidcCode) =>
      Effect.tryPromise({
        try: async (signal) => {
          let code: typeof Code.Type;
          try {
            code = Schema.decodeUnknownSync(Code)(input);
          } catch {
            throw new TelegramOidcRejected({ reason: "invalid_input" });
          }
          await prepare(signal);
          const body = await telegramOidcJson(
            fetcher,
            `${ISSUER}/token`,
            {
              method: "POST",
              headers: {
                "content-type": "application/x-www-form-urlencoded",
                authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
              },
              body: new URLSearchParams({
                grant_type: "authorization_code",
                client_id: config.clientId,
                redirect_uri: config.redirectUri,
                code: code.code,
                code_verifier: code.verifier,
              }).toString(),
            },
            signal,
            timeoutMs,
            32 * 1024,
          );
          const response = Schema.decodeUnknownSync(TokenResponse)(body);
          const result = await jwtVerify(response.id_token, resolve(signal), {
            algorithms: ["RS256"],
            issuer: ISSUER,
            audience: config.clientId,
            currentDate: new Date(now()),
            maxTokenAge: MAX_AGE_SECONDS,
            clockTolerance: 30,
            requiredClaims: ["iss", "aud", "sub", "iat", "exp", "nonce", "id"],
          });
          const claims = Schema.decodeUnknownSync(Claims)(result.payload);
          if (
            claims.aud !== config.clientId ||
            claims.exp <= claims.iat ||
            claims.exp <= Math.floor(now() / 1000) ||
            !sameNonce(claims.nonce, code.nonce)
          )
            throw new TelegramOidcRejected({ reason: "invalid_proof" });
          return { telegramUserId: String(claims.id) };
        },
        catch: proofRejected,
      }),
  };
}
