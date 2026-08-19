import {
  AuthError,
  BadRequest,
  Conflict,
  InternalError,
  RateLimited,
  RegisterIdentity,
} from "@pirate/contracts";
import { Data, Effect, Schema } from "effect";
import {
  IdentityCredentialTombstoned,
  IdentityRegistrationExhausted,
  IdentityRegistrationFailed,
  type IdentityRegistrationServices,
  registerIdentity,
} from "./identity-registration.ts";
import type {
  SessionAccount,
  SessionExchangeHandlerResult,
  SessionProofVerifier,
  SessionTokenMinter,
} from "./session-exchange.ts";

export class RegistrationLimiterRejected extends Data.TaggedError("RegistrationLimiterRejected")<{
  readonly retryAfterSeconds?: number;
}> {}

export class RegistrationLimiterUnavailable extends Data.TaggedError(
  "RegistrationLimiterUnavailable",
) {}

export interface IdentityRegistrationRateLimiter {
  readonly checkIp: (input: {
    readonly ip: string;
  }) => Effect.Effect<void, RegistrationLimiterRejected | RegistrationLimiterUnavailable>;
  readonly checkApplication: () => Effect.Effect<
    void,
    RegistrationLimiterRejected | RegistrationLimiterUnavailable
  >;
}

export interface IdentityRegistrationHandlerServices {
  readonly providerAppId: string;
  readonly proofVerifier: SessionProofVerifier;
  readonly registration: IdentityRegistrationServices;
  readonly identityStore: {
    readonly resolve: (input: {
      readonly sourceUserId: string;
    }) => Effect.Effect<SessionAccount | null, unknown>;
  };
  readonly tokenMinter: SessionTokenMinter;
  readonly rateLimiter: IdentityRegistrationRateLimiter;
}

type RegistrationFailure = AuthError | BadRequest | Conflict | InternalError | RateLimited;

type RegistrationRequest = {
  readonly privy_access_token: string;
};

const requestBodySchema = (() => {
  const request = RegisterIdentity.request;
  if (request === undefined || request.body === undefined) {
    throw new Error("RegisterIdentity must declare a request body");
  }
  return request.body;
})();

const decodeRequest = (input: unknown): RegistrationRequest => {
  try {
    if (
      typeof input !== "object" ||
      input === null ||
      Object.keys(input).some((key) => key !== "privy_access_token")
    ) {
      throw new Error("unexpected registration fields");
    }
    return Schema.decodeUnknownSync(
      requestBodySchema as unknown as Schema.ConstraintDecoder<unknown>,
    )(input) as RegistrationRequest;
  } catch {
    throw new BadRequest({ message: "Invalid registration proof payload" });
  }
};

const safeFailure = (error: unknown): RegistrationFailure => {
  if (
    error instanceof BadRequest ||
    error instanceof AuthError ||
    error instanceof Conflict ||
    error instanceof RateLimited
  ) {
    return error;
  }
  if (error instanceof IdentityCredentialTombstoned) {
    return new Conflict({
      message: "This credential cannot register a new account",
      details: { reason: "credential_tombstoned" },
    });
  }
  if (error instanceof IdentityRegistrationFailed) {
    return error.reason === "identity-conflict"
      ? new InternalError({ message: "Registration failed" })
      : new InternalError({ message: "Registration failed" });
  }
  if (error instanceof IdentityRegistrationExhausted) {
    return new InternalError({ message: "Registration failed" });
  }
  return new InternalError({ message: "Registration failed" });
};

const validMintedToken = (value: string): boolean => value.length > 0 && value === value.trim();

const validSessionTtl = (value: number | undefined): value is number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0 && value <= 86_400;

const validScope = (value: string): boolean => value.length > 0 && value === value.trim();

const accountResponse = (account: SessionAccount): SessionExchangeHandlerResult["response"] => ({
  user: account.user,
  profile: account.profile,
  onboarding: account.onboarding,
  wallet_attachments: account.wallet_attachments,
});

export const registerIdentityRequest = Effect.fn("registerIdentityRequest")(function* (
  input: { readonly body: unknown; readonly edgeClientIp?: string },
  services: IdentityRegistrationHandlerServices,
): Effect.fn.Return<SessionExchangeHandlerResult, RegistrationFailure> {
  if (input.edgeClientIp === undefined || input.edgeClientIp.trim() === "") {
    return yield* new BadRequest({ message: "Registration requires trusted edge metadata" });
  }

  let request: RegistrationRequest;
  try {
    request = decodeRequest(input.body);
  } catch (error) {
    return yield* Effect.fail(safeFailure(error));
  }

  yield* services.rateLimiter.checkIp({ ip: input.edgeClientIp }).pipe(
    Effect.mapError((error) =>
      error instanceof RegistrationLimiterRejected
        ? new RateLimited({
            message: "Registration rate limit exceeded",
            ...(error.retryAfterSeconds === undefined
              ? {}
              : { details: { retry_after_seconds: error.retryAfterSeconds } }),
          })
        : new InternalError({ message: "Registration is temporarily unavailable" }),
    ),
  );
  yield* services.rateLimiter.checkApplication().pipe(
    Effect.mapError((error) =>
      error instanceof RegistrationLimiterRejected
        ? new RateLimited({
            message: "Registration rate limit exceeded",
            ...(error.retryAfterSeconds === undefined
              ? {}
              : { details: { retry_after_seconds: error.retryAfterSeconds } }),
          })
        : new InternalError({ message: "Registration is temporarily unavailable" }),
    ),
  );

  const verified = yield* services.proofVerifier
    .verifyPrivy({
      accessToken: request.privy_access_token,
      identityToken: null,
      walletAddress: null,
    })
    .pipe(Effect.mapError(() => new AuthError({ message: "Authentication failed" })));
  if (verified.classification !== "user") {
    return yield* new AuthError({ message: "Authentication failed" });
  }

  const registration = yield* registerIdentity(
    { providerAppId: services.providerAppId, providerSubject: verified.sourceUserId },
    services.registration,
  ).pipe(Effect.mapError(safeFailure));
  const account = yield* services.identityStore
    .resolve({ sourceUserId: verified.sourceUserId })
    .pipe(Effect.mapError(() => new InternalError({ message: "Registration failed" })));
  if (account === null || account.canonicalUserId !== registration.canonicalUserId) {
    return yield* new InternalError({ message: "Registration failed" });
  }

  const ttlSeconds = services.tokenMinter.ttlSeconds ?? 3_600;
  if (!validSessionTtl(ttlSeconds) || !validScope(services.tokenMinter.scope)) {
    return yield* new InternalError({ message: "Registration failed" });
  }
  const sessionToken = yield* services.tokenMinter
    .mint({
      subject: account.canonicalUserId,
      scope: services.tokenMinter.scope,
      ...(verified.walletAddress === undefined || verified.walletAddress === null
        ? {}
        : { walletAddress: verified.walletAddress }),
    })
    .pipe(Effect.mapError(() => new InternalError({ message: "Registration failed" })));
  if (!validMintedToken(sessionToken)) {
    return yield* new InternalError({ message: "Registration failed" });
  }

  return {
    response: accountResponse(account),
    sessionToken,
    sessionTtlSeconds: ttlSeconds,
  };
});

export const makeIdentityRegistrationHandler =
  (services: IdentityRegistrationHandlerServices) =>
  async (input: { readonly body: unknown; readonly edgeClientIp?: string }) =>
    Effect.runPromise(registerIdentityRequest(input, services));
