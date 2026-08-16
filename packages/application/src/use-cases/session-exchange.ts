import {
  AuthError,
  BadRequest,
  InternalError,
  RateLimited,
  SessionExchange,
} from "@pirate/contracts";
import { Data, Effect, Schema } from "effect";

const DEFAULT_SESSION_SCOPE = "pirate_app_session";

/** Expected proof rejection; adapters must not put token material in this error. */
export class SessionProofRejected extends Data.TaggedError("SessionProofRejected") {}

/** Expected control-plane identity rejection with a deliberately closed reason set. */
export class SessionIdentityRejected extends Data.TaggedError("SessionIdentityRejected")<{
  readonly reason: "missing" | "deleted" | "cyclic" | "invalid";
}> {}

export type SessionExchangeProof =
  | {
      readonly type: "privy_access_token";
      readonly privy_access_token: string;
      readonly privy_identity_token?: string | null;
      readonly wallet_address?: string | null;
    }
  | {
      readonly type: "jwt_based_auth";
      readonly jwt: string;
    };

export type VerifiedSessionIdentity = {
  readonly sourceUserId: string;
  /** The verifier has already applied the shared session classification policy. */
  readonly classification: "user" | "device";
};

export type SessionAccount = {
  readonly canonicalUserId: string;
} & Omit<SessionExchangeResponse, "access_token">;

export interface SessionProofVerifier {
  readonly verifyPrivy: (input: {
    readonly accessToken: string;
    readonly identityToken: string | null;
    readonly walletAddress: string | null;
  }) => Effect.Effect<VerifiedSessionIdentity, unknown>;
  readonly verifyJwt: (input: {
    readonly jwt: string;
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
    readonly scope: typeof DEFAULT_SESSION_SCOPE;
  }) => Effect.Effect<string, unknown>;
}

export interface SessionExchangeServices {
  readonly proofVerifier: SessionProofVerifier;
  readonly identityStore: SessionIdentityStore;
  readonly tokenMinter: SessionTokenMinter;
}

export type SessionExchangeResponse = Schema.Schema.Type<typeof SessionExchange.response>;

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

export const exchangeSession = Effect.fn("exchangeSession")(function* (
  input: unknown,
  services: SessionExchangeServices,
): Effect.fn.Return<SessionExchangeResponse, SessionExchangeFailure> {
  let request: SessionExchangeRequest;
  try {
    request = decodeRequest(input);
  } catch (error) {
    return yield* Effect.fail(safeFailure(error));
  }

  const verified =
    request.proof.type === "privy_access_token"
      ? yield* services.proofVerifier
          .verifyPrivy({
            accessToken: request.proof.privy_access_token,
            identityToken: request.proof.privy_identity_token ?? null,
            walletAddress: request.proof.wallet_address ?? null,
          })
          .pipe(Effect.mapError(safeFailure))
      : yield* services.proofVerifier
          .verifyJwt({ jwt: request.proof.jwt })
          .pipe(Effect.mapError(safeFailure));

  if (verified.classification !== "user") {
    return yield* Effect.fail(new AuthError({ message: "Authentication failed" }));
  }

  const account = yield* services.identityStore
    .resolve({ sourceUserId: verified.sourceUserId })
    .pipe(Effect.mapError(safeFailure));
  if (account === null || !validCanonicalUserId(account.canonicalUserId)) {
    return yield* Effect.fail(new AuthError({ message: "Authentication failed" }));
  }

  const accessToken = yield* services.tokenMinter
    .mint({ subject: account.canonicalUserId, scope: DEFAULT_SESSION_SCOPE })
    .pipe(Effect.mapError(safeFailure));
  if (!validMintedToken(accessToken)) {
    return yield* Effect.fail(new InternalError({ message: "Session exchange failed" }));
  }

  return {
    access_token: accessToken,
    user: account.user,
    profile: account.profile,
    onboarding: account.onboarding,
    wallet_attachments: account.wallet_attachments,
  };
});

export const makeSessionExchangeHandler =
  (services: SessionExchangeServices) =>
  async (input: { readonly body: unknown }): Promise<SessionExchangeResponse> =>
    Effect.runPromise(exchangeSession(input.body, services));
