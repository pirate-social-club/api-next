import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Result } from "effect";
import {
  IdentityCredentialTombstoned,
  type IdentityRegistrationCandidate,
  IdentityRegistrationExhausted,
  IdentityRegistrationFailed,
  type IdentityRegistrationServices,
  IdentityRegistrationStoreFailure,
  MAX_IDENTITY_REGISTRATION_ATTEMPTS,
  makeUnverifiedIdentityAccount,
  registerIdentity,
} from "./identity-registration.ts";

const candidate = (suffix: string): IdentityRegistrationCandidate => ({
  credentialId: `credential-${suffix}`,
  userId: `user-${suffix}`,
  handleId: `handle-${suffix}`,
  handleLabel: `generated-${suffix}.pirate`,
  createdAt: "2026-08-19T00:00:00.000Z",
});

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const failure = Cause.findError(exit.cause);
  if (!Result.isSuccess(failure)) throw new Error("expected typed failure");
  return failure.success;
};

describe("identity registration use case", () => {
  test("creates an account with no verification capabilities", async () => {
    const seenAccounts: unknown[] = [];
    const services: IdentityRegistrationServices = {
      candidates: { next: () => Effect.succeed(candidate("one")) },
      store: {
        registerCredential: (input) => {
          seenAccounts.push(input.account);
          return Effect.succeed({
            kind: "created",
            canonicalUserId: input.userId,
            account: input.account,
          });
        },
      },
    };
    const result = await Effect.runPromise(
      registerIdentity(
        { providerAppId: "privy-staging", providerSubject: "did:privy:one" },
        services,
      ),
    );
    expect(result).toEqual({
      status: "created",
      canonicalUserId: "user-one",
      account: makeUnverifiedIdentityAccount(candidate("one")),
    });
    expect(seenAccounts).toEqual([makeUnverifiedIdentityAccount(candidate("one"))]);
    expect(seenAccounts[0]).toMatchObject({
      user: {
        capability_provider: null,
        verification_capabilities_json: null,
        verified_at: null,
      },
    });
  });

  test("retries only candidate collisions and stops at the fixed bound", async () => {
    let candidateCalls = 0;
    let storeCalls = 0;
    const result = await Effect.runPromiseExit(
      registerIdentity(
        { providerAppId: "privy-staging", providerSubject: "did:privy:collision" },
        {
          candidates: {
            next: () => {
              candidateCalls += 1;
              return Effect.succeed(candidate(String(candidateCalls)));
            },
          },
          store: {
            registerCredential: () => {
              storeCalls += 1;
              return Effect.succeed({ kind: "candidate_collision", field: "handle" });
            },
          },
        },
      ),
    );
    expect(failureOf(result)).toEqual(
      new IdentityRegistrationExhausted({ attempts: MAX_IDENTITY_REGISTRATION_ATTEMPTS }),
    );
    expect(candidateCalls).toBe(MAX_IDENTITY_REGISTRATION_ATTEMPTS);
    expect(storeCalls).toBe(MAX_IDENTITY_REGISTRATION_ATTEMPTS);
  });

  test("fails immediately for tombstones and invalid generated handles", async () => {
    let tombstoneCalls = 0;
    const tombstone = await Effect.runPromiseExit(
      registerIdentity(
        { providerAppId: "privy-staging", providerSubject: "did:privy:tombstoned" },
        {
          candidates: { next: () => Effect.succeed(candidate("tombstone")) },
          store: {
            registerCredential: () => {
              tombstoneCalls += 1;
              return Effect.succeed({ kind: "tombstoned" });
            },
          },
        },
      ),
    );
    expect(failureOf(tombstone)).toBeInstanceOf(IdentityCredentialTombstoned);
    expect(tombstoneCalls).toBe(1);

    let invalidStoreCalls = 0;
    const invalid = await Effect.runPromiseExit(
      registerIdentity(
        { providerAppId: "privy-staging", providerSubject: "did:privy:invalid" },
        {
          candidates: {
            next: () => Effect.succeed({ ...candidate("invalid"), handleLabel: "admin.pirate" }),
          },
          store: {
            registerCredential: () => {
              invalidStoreCalls += 1;
              return Effect.succeed({
                kind: "created",
                canonicalUserId: "impossible",
                account: makeUnverifiedIdentityAccount(candidate("invalid")),
              });
            },
          },
        },
      ),
    );
    expect(failureOf(invalid)).toEqual(
      new IdentityRegistrationFailed({ reason: "invalid-candidate" }),
    );
    expect(invalidStoreCalls).toBe(0);
  });

  test("preserves identity inconsistency separately from storage failure", async () => {
    let storeCalls = 0;
    const result = await Effect.runPromiseExit(
      registerIdentity(
        { providerAppId: "privy-staging", providerSubject: "did:privy:inconsistent" },
        {
          candidates: { next: () => Effect.succeed(candidate("inconsistent")) },
          store: {
            registerCredential: () => {
              storeCalls += 1;
              return Effect.fail(
                new IdentityRegistrationStoreFailure({ reason: "identity-conflict" }),
              );
            },
          },
        },
      ),
    );
    expect(failureOf(result)).toEqual(
      new IdentityRegistrationFailed({ reason: "identity-conflict" }),
    );
    expect(storeCalls).toBe(1);
  });
});
