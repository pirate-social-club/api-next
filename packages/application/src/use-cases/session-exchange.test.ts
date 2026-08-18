import { describe, expect, it } from "bun:test";
import { AuthError, InternalError, RateLimited } from "@pirate/contracts";
import { Cause, Effect, Exit, Result } from "effect";
import {
  exchangeSession,
  MAX_BROWSER_SESSION_TTL_SECONDS,
  makeSessionExchangeHandler,
  type SessionAccount,
  type SessionExchangeServices,
  SessionIdentityRejected,
  SessionProofRejected,
} from "./session-exchange.ts";

const account: SessionAccount = {
  canonicalUserId: "canonical-user",
  user: {
    id: "canonical-user",
    object: "user",
    verification_state: "unverified",
    verification_capabilities: {
      unique_human: { state: "unverified" },
      age_over_18: { state: "unverified" },
      minimum_age: { state: "unverified" },
      nationality: { state: "unverified" },
      gender: { state: "unverified" },
      wallet_score: { state: "unverified" },
    },
    created: 1_700_000_000,
  },
  profile: {
    id: "canonical-user",
    object: "profile",
    global_handle: {
      id: "handle-1",
      object: "global_handle",
      label: "captain",
      tier: "generated",
      status: "active",
      issuance_source: "generated_signup",
      issued_at: 1_700_000_000,
    },
    created: 1_700_000_000,
  },
  onboarding: {
    generated_handle_assigned: true,
    cleanup_rename_available: false,
    unique_human_verification_status: "not_started",
    namespace_verification_status: "not_started",
    community_creation_ready: false,
    missing_requirements: [],
    reddit_verification_status: "not_started",
    reddit_import_status: "not_started",
  },
  wallet_attachments: [],
};

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (!Exit.isFailure(exit)) throw new Error("expected a failed effect");
  const failure = Cause.findError(exit.cause);
  if (!Result.isSuccess(failure)) throw new Error("expected a typed effect failure");
  return failure.success;
};

const servicesFor = (
  overrides: Partial<SessionExchangeServices> = {},
): SessionExchangeServices => ({
  proofVerifier: {
    verifyPrivy: () => Effect.succeed({ sourceUserId: "source-user", classification: "user" }),
  },
  identityStore: { resolve: () => Effect.succeed(account) },
  tokenMinter: { mint: () => Effect.succeed("session-token") },
  ...overrides,
});

describe("session exchange application use case", () => {
  it("exchanges a Privy proof through the injected verifier", async () => {
    let privyCalls = 0;
    const services = servicesFor({
      proofVerifier: {
        verifyPrivy: (input) => {
          privyCalls += 1;
          expect(input.accessToken).toBe("privy-proof");
          return Effect.succeed({ sourceUserId: "privy-user", classification: "user" as const });
        },
      },
    });
    const handler = makeSessionExchangeHandler(services);

    await handler({
      body: { proof: { type: "privy_access_token", privy_access_token: "privy-proof" } },
    });
    expect(privyCalls).toBe(1);
  });

  it("mints the session for the canonical alias subject", async () => {
    let mintedSubject: string | undefined;
    const result = await Effect.runPromise(
      exchangeSession(
        { proof: { type: "privy_access_token", privy_access_token: "privy-proof" } },
        servicesFor({
          tokenMinter: {
            mint: ({ subject }) => {
              mintedSubject = subject;
              return Effect.succeed("session-token");
            },
          },
        }),
      ),
    );

    expect(mintedSubject).toBe("canonical-user");
    expect(result.sessionToken).toBe("session-token");
  });

  it("maps missing, deleted, cyclic, and invalid identities to safe auth errors", async () => {
    for (const identityFailure of [
      null,
      new SessionIdentityRejected({ reason: "deleted" }),
      new SessionIdentityRejected({ reason: "cyclic" }),
    ]) {
      const result = await Effect.runPromiseExit(
        exchangeSession(
          { proof: { type: "privy_access_token", privy_access_token: "privy-proof" } },
          servicesFor({
            identityStore: {
              resolve: () =>
                identityFailure === null ? Effect.succeed(null) : Effect.fail(identityFailure),
            },
          }),
        ),
      );
      expect(failureOf(result)).toBeInstanceOf(AuthError);
    }

    for (const canonicalUserId of [" ", " canonical-user "]) {
      const invalid = await Effect.runPromiseExit(
        exchangeSession(
          { proof: { type: "privy_access_token", privy_access_token: "privy-proof" } },
          servicesFor({
            identityStore: { resolve: () => Effect.succeed({ ...account, canonicalUserId }) },
          }),
        ),
      );
      expect(failureOf(invalid)).toBeInstanceOf(AuthError);
    }
  });

  it("fails closed for a device-classified proof", async () => {
    const result = await Effect.runPromiseExit(
      exchangeSession(
        { proof: { type: "privy_access_token", privy_access_token: "privy-proof" } },
        servicesFor({
          proofVerifier: {
            verifyPrivy: () =>
              Effect.succeed({ sourceUserId: "source-user", classification: "device" as const }),
          },
        }),
      ),
    );
    expect(failureOf(result)).toBeInstanceOf(AuthError);
  });

  it("fails closed when the verifier rejects an invalid scope", async () => {
    const result = await Effect.runPromiseExit(
      exchangeSession(
        { proof: { type: "privy_access_token", privy_access_token: "privy-proof" } },
        servicesFor({
          proofVerifier: {
            verifyPrivy: () => Effect.fail(new SessionProofRejected()),
          },
        }),
      ),
    );
    expect(failureOf(result)).toBeInstanceOf(AuthError);
  });

  it("preserves a declared rate-limit error without exposing dependency details", async () => {
    const result = await Effect.runPromiseExit(
      exchangeSession(
        { proof: { type: "privy_access_token", privy_access_token: "privy-proof" } },
        servicesFor({
          proofVerifier: {
            verifyPrivy: () => Effect.fail(new RateLimited({ message: "slow down" })),
          },
        }),
      ),
    );
    expect(failureOf(result)).toBeInstanceOf(RateLimited);
  });

  it("maps unexpected adapter defects to a redacted internal error", async () => {
    const result = await Effect.runPromiseExit(
      exchangeSession(
        { proof: { type: "privy_access_token", privy_access_token: "privy-proof" } },
        servicesFor({
          tokenMinter: {
            mint: () => Effect.fail(new Error("private key and bearer token")),
          },
        }),
      ),
    );
    expect(failureOf(result)).toBeInstanceOf(InternalError);
    expect(JSON.stringify(result)).not.toContain("private key and bearer token");
  });

  it("rejects empty or padded tokens from the minting adapter", async () => {
    for (const token of ["", " session-token "]) {
      const result = await Effect.runPromiseExit(
        exchangeSession(
          { proof: { type: "privy_access_token", privy_access_token: "privy-proof" } },
          servicesFor({ tokenMinter: { mint: () => Effect.succeed(token) } }),
        ),
      );
      expect(failureOf(result)).toBeInstanceOf(InternalError);
    }
  });

  it("rejects an unbounded browser-session TTL before minting", async () => {
    let minted = false;
    const result = await Effect.runPromiseExit(
      exchangeSession(
        { proof: { type: "privy_access_token", privy_access_token: "privy-proof" } },
        servicesFor({
          tokenMinter: {
            ttlSeconds: MAX_BROWSER_SESSION_TTL_SECONDS + 1,
            mint: () => {
              minted = true;
              return Effect.succeed("session-token");
            },
          },
        }),
      ),
    );
    expect(failureOf(result)).toBeInstanceOf(InternalError);
    expect(minted).toBe(false);
  });
});
