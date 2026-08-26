import {
  AuthError,
  BadRequest,
  InternalError,
  RateLimited,
  SessionExchange,
} from "@pirate/contracts";
import { Data, Effect, Schema } from "effect";
import { IdentityResolutionError, type IdentityStore } from "../ports.ts";
import { loadIdentityAccount } from "./identity-account.ts";

/** Browser sessions are intentionally bounded even if deployment config drifts. */
export const MAX_BROWSER_SESSION_TTL_SECONDS = 86_400;

/** Expected proof rejection; adapters must not put token material in this error. */
export class SessionProofRejected extends Data.TaggedError("SessionProofRejected") {}

/** Expected control-plane identity rejection with a deliberately closed reason set. */
export class SessionIdentityRejected extends Data.TaggedError("SessionIdentityRejected")<{
  readonly reason: "missing" | "deleted" | "cyclic" | "invalid";
}> {}

export type SessionExchangeProof = {
  readonly type: "privy_access_token";
  readonly privy_access_token: string;
  readonly privy_identity_token?: string | null;
  readonly wallet_address?: string | null;
};

export type VerifiedSessionIdentity = {
  readonly sourceUserId: string;
  /** The verifier has already applied the shared session classification policy. */
  readonly classification: "user" | "device";
  /** Optional wallet authenticated by the upstream proof; never a profile default. */
  readonly walletAddress?: string | null;
};

export type SessionAccount = {
  readonly canonicalUserId: string;
} & SessionExchangeResponse;

export interface SessionProofVerifier {
  readonly verifyPrivy: (input: {
    readonly accessToken: string;
    readonly identityToken: string | null;
    readonly walletAddress: string | null;
  }) => Effect.Effect<VerifiedSessionIdentity, unknown>;
}

export interface SessionIdentityStore {
  /** Resolves the identity and follows aliases to one canonical user. */
  readonly resolve: (input: {
    readonly sourceUserId: string;
  }) => Effect.Effect<SessionAccount | null, unknown>;
}

export interface SessionTokenMinter {
  /** The subject is always the canonical control-plane user id. */
  readonly mint: (input: {
    readonly subject: string;
    readonly scope: string;
    /** Optional wallet authenticated by the upstream proof. */
    readonly walletAddress?: string;
  }) => Effect.Effect<string, unknown>;
  /** Explicit api-next-owned browser-session scope configured per environment. */
  readonly scope: string;
  /** Maximum lifetime of a freshly minted browser session, in seconds. */
  readonly ttlSeconds?: number;
}

export interface SessionExchangeServices {
  readonly proofVerifier: SessionProofVerifier;
  readonly identityStore: SessionIdentityStore;
  readonly tokenMinter: SessionTokenMinter;
  readonly productReadiness?: {
    readonly isReady: (accountId: string) => Effect.Effect<boolean, unknown>;
  };
}

export function makeSessionIdentityStore(
  identityStore: IdentityStore["Service"],
): SessionIdentityStore {
  return {
    resolve: ({ sourceUserId }) =>
      Effect.gen(function* () {
        const canonical = yield* identityStore.resolveCanonical({ sourceUserId });
        const account = yield* loadIdentityAccount(canonical.canonicalUserId, { identityStore });
        if (account === null) {
          return yield* new SessionIdentityRejected({ reason: "missing" });
        }
        return { canonicalUserId: canonical.canonicalUserId, ...account };
      }).pipe(
        Effect.mapError((error) =>
          error instanceof IdentityResolutionError
            ? new SessionIdentityRejected({ reason: error.reason })
            : error,
        ),
      ),
  };
}

export type SessionExchangeResponse = Schema.Schema.Type<typeof SessionExchange.response>;

/** Internal handoff: the token is consumed only by the HTTP cookie writer. */
export type SessionExchangeHandlerResult<Response = SessionExchangeResponse> = {
  readonly response: Response;
  readonly sessionToken: string;
  readonly sessionTtlSeconds: number;
};

type SessionExchangeFailure = AuthError | BadRequest | RateLimited | InternalError;

type SessionExchangeRequest = {
  readonly proof: SessionExchangeProof;
};

const bodySchema = (() => {
  const request = SessionExchange.request;
  if (request === undefined || !("body" in request) || request.body === undefined) {
    throw new Error("SessionExchange must declare a request body");
  }
  return request.body;
})();

const decodeRequest = (input: unknown): SessionExchangeRequest => {
  try {
    return Schema.decodeUnknownSync(bodySchema as unknown as Schema.ConstraintDecoder<unknown>)(
      input,
    ) as SessionExchangeRequest;
  } catch {
    throw new BadRequest({ message: "Invalid auth proof payload" });
  }
};

const safeFailure = (error: unknown): SessionExchangeFailure => {
  if (error instanceof RateLimited) return error;
  if (error instanceof BadRequest) return error;
  if (error instanceof AuthError) return error;
  if (error instanceof SessionProofRejected || error instanceof SessionIdentityRejected) {
    return new AuthError({ message: "Authentication failed" });
  }
  return new InternalError({ message: "Session exchange failed" });
};

const validCanonicalUserId = (value: string): boolean =>
  value.trim().length > 0 && value === value.trim();

const validMintedToken = (value: string): boolean =>
  value.trim().length > 0 && value === value.trim();

const validCanonicalWalletAddress = (value: string): boolean => /^0x[0-9a-f]{40}$/u.test(value);

export const exchangeSession = Effect.fn("exchangeSession")(function* (
  input: unknown,
  services: SessionExchangeServices,
): Effect.fn.Return<SessionExchangeHandlerResult, SessionExchangeFailure> {
  let request: SessionExchangeRequest;
  try {
    request = decodeRequest(input);
  } catch (error) {
    return yield* Effect.fail(safeFailure(error));
  }

  const verified = yield* services.proofVerifier
    .verifyPrivy({
      accessToken: request.proof.privy_access_token,
      identityToken: request.proof.privy_identity_token ?? null,
      walletAddress: request.proof.wallet_address ?? null,
    })
    .pipe(Effect.mapError(safeFailure));

  if (verified.classification !== "user") {
    return yield* Effect.fail(new AuthError({ message: "Authentication failed" }));
  }
  if (
    verified.walletAddress !== undefined &&
    verified.walletAddress !== null &&
    !validCanonicalWalletAddress(verified.walletAddress)
  ) {
    return yield* Effect.fail(new AuthError({ message: "Authentication failed" }));
  }

  const account = yield* services.identityStore
    .resolve({ sourceUserId: verified.sourceUserId })
    .pipe(Effect.mapError(safeFailure));
  if (account === null || !validCanonicalUserId(account.canonicalUserId)) {
    return yield* Effect.fail(new AuthError({ message: "Authentication failed" }));
  }
  const productReady =
    services.productReadiness === undefined
      ? true
      : yield* services.productReadiness
          .isReady(account.canonicalUserId)
          .pipe(Effect.mapError(safeFailure));
  if (!productReady) {
    return yield* Effect.fail(new AuthError({ message: "Wallet activation required" }));
  }

  const sessionTtlSeconds = services.tokenMinter.ttlSeconds ?? 3_600;
  if (
    !Number.isSafeInteger(sessionTtlSeconds) ||
    sessionTtlSeconds <= 0 ||
    sessionTtlSeconds > MAX_BROWSER_SESSION_TTL_SECONDS
  ) {
    return yield* Effect.fail(new InternalError({ message: "Session exchange failed" }));
  }
  if (
    services.tokenMinter.scope.trim() !== services.tokenMinter.scope ||
    services.tokenMinter.scope === ""
  ) {
    return yield* Effect.fail(new InternalError({ message: "Session exchange failed" }));
  }

  const accessToken = yield* services.tokenMinter
    .mint({
      subject: account.canonicalUserId,
      scope: services.tokenMinter.scope,
      ...(verified.walletAddress === undefined || verified.walletAddress === null
        ? {}
        : { walletAddress: verified.walletAddress }),
    })
    .pipe(Effect.mapError(safeFailure));
  if (!validMintedToken(accessToken)) {
    return yield* Effect.fail(new InternalError({ message: "Session exchange failed" }));
  }

  return {
    response: {
      user: account.user,
      profile: account.profile,
      onboarding: account.onboarding,
      wallet_attachments: account.wallet_attachments,
    },
    sessionToken: accessToken,
    sessionTtlSeconds,
  };
});

export const makeSessionExchangeHandler =
  (services: SessionExchangeServices) =>
  async (input: { readonly body: unknown }): Promise<SessionExchangeHandlerResult> =>
    Effect.runPromise(exchangeSession(input.body, services));
