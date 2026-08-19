import { describe, expect, test } from "bun:test";
import { AuthError, BadRequest, Conflict, InternalError } from "@pirate/contracts";
import { Cause, Effect, Exit, Result } from "effect";
import {
  type IdentityRegistrationCandidate,
  IdentityRegistrationStoreFailure,
} from "./identity-registration.ts";
import {
  type IdentityRegistrationHandlerServices,
  RegistrationLimiterRejected,
  RegistrationLimiterUnavailable,
  registerIdentityRequest,
} from "./identity-registration-handler.ts";
import type { SessionAccount } from "./session-exchange.ts";

const candidate: IdentityRegistrationCandidate = {
  credentialId: "credential-1",
  userId: "user-1",
  handleId: "handle-1",
  handleLabel: "generated-1.pirate",
  createdAt: "2026-08-19T00:00:00.000Z",
};

const account = {
  canonicalUserId: "user-1",
  user: {},
  profile: {},
  onboarding: {},
  wallet_attachments: [],
} as unknown as SessionAccount;

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const failure = Cause.findError(exit.cause);
  if (!Result.isSuccess(failure)) throw new Error("expected typed failure");
  return failure.success;
};

function services(
  overrides: Partial<IdentityRegistrationHandlerServices> = {},
): IdentityRegistrationHandlerServices {
  return {
    providerAppId: "privy-staging",
    proofVerifier: {
      verifyPrivy: () =>
        Effect.succeed({ sourceUserId: "did:privy:one", classification: "user" as const }),
    },
    registration: {
      candidates: { next: () => Effect.succeed(candidate) },
      store: {
        registerCredential: () => Effect.succeed({ kind: "created", canonicalUserId: "user-1" }),
      },
    },
    identityStore: { resolve: () => Effect.succeed(account) },
    tokenMinter: {
      scope: "api-next-browser-session",
      ttlSeconds: 3_600,
      mint: () => Effect.succeed("session-token"),
    },
    rateLimiter: {
      checkIp: () => Effect.succeed(undefined),
      checkApplication: () => Effect.succeed(undefined),
    },
    ...overrides,
  };
}

describe("identity registration HTTP use case", () => {
  test("creates an account and mints the browser session", async () => {
    const result = await Effect.runPromise(
      registerIdentityRequest(
        { body: { privy_access_token: "access-token" }, edgeClientIp: "203.0.113.8" },
        services(),
      ),
    );
    expect(result.sessionToken).toBe("session-token");
  });

  test("returns the same account for an already-registered credential", async () => {
    const result = await Effect.runPromise(
      registerIdentityRequest(
        { body: { privy_access_token: "access-token" }, edgeClientIp: "203.0.113.8" },
        services({
          registration: {
            candidates: { next: () => Effect.succeed(candidate) },
            store: {
              registerCredential: () =>
                Effect.succeed({ kind: "already_registered", canonicalUserId: "user-1" }),
            },
          },
        }),
      ),
    );
    expect(result.sessionToken).toBe("session-token");
  });

  test("maps a tombstoned credential to a permanent conflict", async () => {
    const exit = await Effect.runPromiseExit(
      registerIdentityRequest(
        { body: { privy_access_token: "access-token" }, edgeClientIp: "203.0.113.8" },
        services({
          registration: {
            candidates: { next: () => Effect.succeed(candidate) },
            store: { registerCredential: () => Effect.succeed({ kind: "tombstoned" }) },
          },
        }),
      ),
    );
    expect(failureOf(exit)).toBeInstanceOf(Conflict);
  });

  test("hides identity inconsistency as an internal failure", async () => {
    const exit = await Effect.runPromiseExit(
      registerIdentityRequest(
        { body: { privy_access_token: "access-token" }, edgeClientIp: "203.0.113.8" },
        services({
          registration: {
            candidates: { next: () => Effect.succeed(candidate) },
            store: {
              registerCredential: () =>
                Effect.fail(new IdentityRegistrationStoreFailure({ reason: "identity-conflict" })),
            },
          },
        }),
      ),
    );
    expect(failureOf(exit)).toBeInstanceOf(InternalError);
  });

  test("rejects invalid proofs before identity mutation", async () => {
    let registrationCalls = 0;
    const exit = await Effect.runPromiseExit(
      registerIdentityRequest(
        { body: { privy_access_token: "bad" }, edgeClientIp: "203.0.113.8" },
        services({
          proofVerifier: { verifyPrivy: () => Effect.fail(new Error("invalid proof")) },
          registration: {
            candidates: { next: () => Effect.succeed(candidate) },
            store: {
              registerCredential: () => {
                registrationCalls += 1;
                return Effect.succeed({ kind: "created", canonicalUserId: "user-1" });
              },
            },
          },
        }),
      ),
    );
    expect(failureOf(exit)).toBeInstanceOf(AuthError);
    expect(registrationCalls).toBe(0);
  });

  test("requires trusted edge metadata before limiters or proof verification", async () => {
    let limiterCalls = 0;
    let proofCalls = 0;
    const exit = await Effect.runPromiseExit(
      registerIdentityRequest(
        { body: { privy_access_token: "access-token" } },
        services({
          proofVerifier: {
            verifyPrivy: () =>
              Effect.sync(() => (proofCalls += 1)).pipe(
                Effect.flatMap(() => Effect.fail(new Error())),
              ),
          },
          rateLimiter: {
            checkIp: () => Effect.sync(() => void limiterCalls++),
            checkApplication: () => Effect.succeed(undefined),
          },
        }),
      ),
    );
    expect(failureOf(exit)).toBeInstanceOf(BadRequest);
    expect(limiterCalls).toBe(0);
    expect(proofCalls).toBe(0);
  });

  test("fails closed on either limiter and rejects identity metadata fields", async () => {
    const limited = await Effect.runPromiseExit(
      registerIdentityRequest(
        { body: { privy_access_token: "access-token" }, edgeClientIp: "203.0.113.8" },
        services({
          rateLimiter: {
            checkIp: () => Effect.fail(new RegistrationLimiterRejected({ retryAfterSeconds: 4 })),
            checkApplication: () => Effect.succeed(undefined),
          },
        }),
      ),
    );
    expect(failureOf(limited)).toMatchObject({ code: "rate_limited" });

    const unavailable = await Effect.runPromiseExit(
      registerIdentityRequest(
        { body: { privy_access_token: "access-token" }, edgeClientIp: "203.0.113.8" },
        services({
          rateLimiter: {
            checkIp: () => Effect.fail(new RegistrationLimiterUnavailable()),
            checkApplication: () => Effect.succeed(undefined),
          },
        }),
      ),
    );
    expect(failureOf(unavailable)).toBeInstanceOf(InternalError);

    const identityMetadata = await Effect.runPromiseExit(
      registerIdentityRequest(
        {
          body: { privy_access_token: "access-token", privy_identity_token: "identity-token" },
          edgeClientIp: "203.0.113.8",
        },
        services(),
      ),
    );
    expect(failureOf(identityMetadata)).toBeInstanceOf(BadRequest);
  });
});
