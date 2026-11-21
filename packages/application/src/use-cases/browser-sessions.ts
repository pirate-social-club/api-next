import { Data, Effect, Schema } from "effect";
import { IdentityResolutionError, type IdentityStore } from "../ports.ts";

export const BROWSER_ACCESS_SECONDS = 3_600;
export const BROWSER_IDLE_SECONDS = 30 * 86_400;
export const BROWSER_ABSOLUTE_SECONDS = 90 * 86_400;
export const BROWSER_SETUP_SCOPE = "persona-wallet-setup-v1";

/** Contains neither the renewal secret nor any signed access token. */
export interface BrowserSessionRecord {
  readonly sessionId: string;
  readonly accountId: string;
  readonly credentialUserId: string;
  readonly scope: string;
  readonly origin: string;
  readonly renewable: boolean;
  readonly idleExpiresAt: number;
  readonly absoluteExpiresAt: number;
  readonly now: number;
}

export interface BrowserSessionProof {
  readonly sessionId: string;
  readonly secretHash: string;
  readonly csrfHash: string;
  readonly origin: string;
}

export interface BrowserSessionReplacement {
  readonly sessionId: string;
  readonly secretHash: string | null;
  readonly accountId: string | null;
  readonly csrfHash: string;
  readonly origin: string;
}

export class BrowserSessionFailure extends Data.TaggedError("BrowserSessionFailure")<{
  readonly reason: "invalid" | "unavailable";
}> {}

export interface BrowserSessionStore {
  readonly create: (input: {
    readonly sessionId: string;
    readonly accountId: string;
    readonly providerAppId: string;
    readonly providerSubject: string;
    readonly scope: string;
    readonly origin: string;
    readonly renewable: boolean;
    readonly secretHash: string | null;
    readonly csrfHash: string;
    readonly accessSeconds: number;
    readonly proofExpiresAt: number;
    readonly replacement: BrowserSessionReplacement | null;
  }) => Effect.Effect<BrowserSessionRecord, BrowserSessionFailure>;
  readonly access: (input: {
    readonly sessionId: string;
    readonly accountId: string;
    readonly scope: string;
  }) => Effect.Effect<BrowserSessionRecord | null, BrowserSessionFailure>;
  readonly loadRenewal: (
    input: BrowserSessionProof,
  ) => Effect.Effect<BrowserSessionRecord | null, BrowserSessionFailure>;
  readonly renew: (
    input: BrowserSessionProof,
  ) => Effect.Effect<BrowserSessionRecord | null, BrowserSessionFailure>;
  readonly revoke: (input: {
    readonly sessionId: string;
    readonly secretHash: string | null;
    readonly accountId: string | null;
    readonly csrfHash: string;
    readonly origin: string;
  }) => Effect.Effect<boolean, BrowserSessionFailure>;
}

/** Platform crypto keeps credentials out of ordinary response contracts. */
export interface BrowserSessionCrypto {
  readonly inspect: (token: string) => Effect.Effect<
    {
      readonly sub: string;
      readonly scope: string;
      readonly exp: number;
      readonly wallet_address?: string;
      readonly sid?: string;
      readonly token_use?: "browser_access";
    },
    BrowserSessionFailure
  >;
  readonly mint: (input: {
    readonly subject: string;
    readonly scope: string;
    readonly sessionId: string;
    readonly expiresAt: number;
    readonly walletAddress?: string;
  }) => Effect.Effect<string, BrowserSessionFailure>;
  readonly random: () => Effect.Effect<string, BrowserSessionFailure>;
  readonly hash: (value: string) => Effect.Effect<string, BrowserSessionFailure>;
  readonly now: () => number;
}

export interface BrowserSessionCookies {
  readonly accessToken: string;
  readonly accessSeconds: number;
  readonly renewal: string | null;
  readonly csrf: string;
  readonly durableSeconds: number;
  readonly accountId: string;
  readonly expiresAt: string;
}

export type BrowserSessionService = ReturnType<typeof makeBrowserSessionService>;

const invalid = () => new BrowserSessionFailure({ reason: "invalid" });
const renewalSchema = Schema.String.check(Schema.isPattern(/^bs_[a-f0-9]{32}\.[a-f0-9]{64}$/u));
const csrfSchema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const validOrigin = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
};

export function makeBrowserSessionService(input: {
  readonly store: BrowserSessionStore;
  readonly crypto: BrowserSessionCrypto;
  readonly identities: Pick<IdentityStore["Service"], "resolveCanonical">;
  readonly providerAppId: string;
  readonly userScope: string;
}) {
  const canonical = Effect.fn("BrowserSession.canonical")(function* (row: BrowserSessionRecord) {
    const account = yield* input.identities
      .resolveCanonical({ sourceUserId: row.credentialUserId })
      .pipe(
        Effect.mapError((error) =>
          error instanceof IdentityResolutionError
            ? invalid()
            : new BrowserSessionFailure({ reason: "unavailable" }),
        ),
      );
    if (account.canonicalUserId !== row.accountId) return yield* invalid();
    return account;
  });
  const proof = Effect.fn("BrowserSession.proof")(function* (
    renewal: string,
    csrf: string,
    origin: string,
  ) {
    const parsed = yield* Schema.decodeUnknownEffect(renewalSchema)(renewal).pipe(
      Effect.mapError(() => invalid()),
    );
    yield* Schema.decodeUnknownEffect(csrfSchema)(csrf).pipe(Effect.mapError(() => invalid()));
    if (!validOrigin(origin)) return yield* invalid();
    return {
      sessionId: parsed.slice(0, 35),
      secretHash: yield* input.crypto.hash(parsed.slice(36)),
      csrfHash: yield* input.crypto.hash(csrf),
      origin,
    } satisfies BrowserSessionProof;
  });
  const cookies = Effect.fn("BrowserSession.cookies")(function* (
    row: BrowserSessionRecord,
    renewal: string | null,
    csrf: string,
    originalExpiry?: number,
    walletAddress?: string,
  ) {
    const now = input.crypto.now();
    const expiresAt = Math.min(
      now + BROWSER_ACCESS_SECONDS,
      row.idleExpiresAt,
      row.absoluteExpiresAt,
      originalExpiry ?? Number.MAX_SAFE_INTEGER,
    );
    const accessSeconds = expiresAt - now;
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(accessSeconds) || accessSeconds <= 0)
      return yield* invalid();
    return {
      accessToken: yield* input.crypto.mint({
        subject: row.accountId,
        scope: row.scope,
        sessionId: row.sessionId,
        expiresAt,
        ...(walletAddress === undefined ? {} : { walletAddress }),
      }),
      accessSeconds,
      renewal,
      csrf,
      durableSeconds: Math.max(0, row.idleExpiresAt - row.now),
      accountId: row.accountId,
      expiresAt: new Date(expiresAt * 1_000).toISOString(),
    } satisfies BrowserSessionCookies;
  });
  return {
    /** Called only with the internal result of the existing verified proof flow. */
    issue: Effect.fn("BrowserSession.issue")(function* (request: {
      readonly accessToken: string;
      readonly providerSubject: string;
      readonly origin: string;
      readonly previousRenewal?: string;
      readonly previousAccessToken?: string;
      readonly previousCsrf?: string;
    }) {
      if (!validOrigin(request.origin)) return yield* invalid();
      const claims = yield* input.crypto.inspect(request.accessToken);
      if (
        claims.sid !== undefined ||
        claims.token_use !== undefined ||
        (claims.scope !== input.userScope && claims.scope !== BROWSER_SETUP_SCOPE)
      )
        return yield* invalid();
      const accessSeconds = Math.min(BROWSER_ACCESS_SECONDS, claims.exp - input.crypto.now());
      if (!Number.isSafeInteger(accessSeconds) || accessSeconds <= 0) return yield* invalid();
      const sessionId = `bs_${(yield* input.crypto.random()).slice(0, 32)}`;
      const secret = yield* input.crypto.random();
      const csrf = yield* input.crypto.random();
      const renewable = claims.scope === input.userScope;
      let replacement: BrowserSessionReplacement | null = null;
      if (request.previousRenewal !== undefined) {
        replacement = {
          ...(yield* proof(request.previousRenewal, request.previousCsrf ?? "", request.origin)),
          accountId: null,
        };
      } else if (request.previousAccessToken !== undefined && request.previousCsrf !== undefined) {
        // A valid setup session can be replaced after fresh proof. A sidless
        // pre-release cookie supplies no authority and is never authenticated.
        const previous = yield* input.crypto
          .inspect(request.previousAccessToken)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (previous?.sid !== undefined && previous.token_use === "browser_access") {
          yield* Schema.decodeUnknownEffect(csrfSchema)(request.previousCsrf).pipe(
            Effect.mapError(() => invalid()),
          );
          replacement = {
            sessionId: previous.sid,
            accountId: previous.sub,
            secretHash: null,
            csrfHash: yield* input.crypto.hash(request.previousCsrf),
            origin: request.origin,
          };
        }
      }
      const row = yield* input.store.create({
        sessionId,
        accountId: claims.sub,
        providerAppId: input.providerAppId,
        providerSubject: request.providerSubject,
        scope: claims.scope,
        origin: request.origin,
        renewable,
        secretHash: renewable ? yield* input.crypto.hash(secret) : null,
        csrfHash: yield* input.crypto.hash(csrf),
        accessSeconds,
        proofExpiresAt: claims.exp,
        replacement,
      });
      yield* canonical(row);
      return yield* cookies(
        row,
        renewable ? `${sessionId}.${secret}` : null,
        csrf,
        claims.exp,
        claims.wallet_address,
      );
    }),
    verify: Effect.fn("BrowserSession.verify")(function* (claims: {
      readonly sub: string;
      readonly scope: string;
      readonly sid?: string;
      readonly token_use?: "browser_access";
    }) {
      if (claims.sid === undefined || claims.token_use !== "browser_access")
        return yield* invalid();
      const row = yield* input.store.access({
        sessionId: claims.sid,
        accountId: claims.sub,
        scope: claims.scope,
      });
      if (row === null) return yield* invalid();
      return yield* canonical(row);
    }),
    renew: Effect.fn("BrowserSession.renew")(function* (request: {
      readonly renewal: string;
      readonly csrf: string;
      readonly origin: string;
    }) {
      const authority = yield* proof(request.renewal, request.csrf, request.origin);
      const original = yield* input.store.loadRenewal(authority);
      if (original === null || !original.renewable || original.scope !== input.userScope)
        return yield* invalid();
      yield* canonical(original);
      // The repository locks the same row as logout, then checks fresh DB time.
      const row = yield* input.store.renew(authority);
      if (row === null) return yield* invalid();
      // Renew account authority only. A past wallet proof is never renewed.
      return yield* cookies(row, request.renewal, request.csrf);
    }),
    revoke: Effect.fn("BrowserSession.revoke")(function* (request: {
      readonly renewal?: string;
      readonly accessToken?: string;
      readonly csrf: string;
      readonly origin: string;
    }) {
      if (request.renewal !== undefined) {
        const authority = yield* proof(request.renewal, request.csrf, request.origin);
        if (!(yield* input.store.revoke({ ...authority, accountId: null })))
          return yield* invalid();
        return;
      }
      if (request.accessToken === undefined) return;
      const claims = yield* input.crypto.inspect(request.accessToken);
      if (
        claims.sid === undefined ||
        claims.token_use !== "browser_access" ||
        !/^[a-f0-9]{64}$/u.test(request.csrf) ||
        !validOrigin(request.origin)
      )
        return yield* invalid();
      if (
        !(yield* input.store.revoke({
          sessionId: claims.sid,
          secretHash: null,
          accountId: claims.sub,
          csrfHash: yield* input.crypto.hash(request.csrf),
          origin: request.origin,
        }))
      )
        return yield* invalid();
    }),
  };
}
