import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import {
  confirmPersonaEvmWallet,
  createPersona,
  listMyPersonas,
  type PersonaRecord,
  PersonaStoreConflict,
  type PersonaStoreService,
  PersonaUnavailable,
  PersonaWalletProofRejected,
  type PersonaWalletStoreService,
  preparePersonaEvmWallet,
  requireActiveOwnedPersona,
  retirePersona,
} from "./personas.ts";

const activePersona: PersonaRecord = {
  persona_id: "persona_charizard",
  object: "persona",
  status: "active",
  profile: {
    persona_id: "persona_charizard",
    object: "persona_profile",
    revision: 1,
    display_name: "Charizard",
    avatar_ref: null,
    cover_ref: null,
    bio: null,
    preferred_locale: "en",
    primary_public_handle: "name.charizard",
  },
  wallet_set: { evm: null },
  created_at: "2026-08-23T18:00:00.000Z",
  retired_at: null,
};

const storeWith = (overrides: Partial<PersonaStoreService> = {}): PersonaStoreService => ({
  listByAccount: () => Effect.succeed([activePersona]),
  findOwned: ({ accountId, personaId }) =>
    Effect.succeed(
      accountId === "account_owner" && personaId === activePersona.persona_id
        ? activePersona
        : null,
    ),
  create: ({ personaId }) =>
    Effect.succeed({
      persona_id: personaId,
      chain_account_kind: "evm",
      hd_wallet_index: 2,
      status: "pending",
      assignment: null,
    }),
  ...overrides,
});

const assignment = {
  chain_account_kind: "evm",
  hd_wallet_index: 2,
  address: `0x${"a".repeat(40)}`,
  assigned_at: "2026-08-23T22:00:00.000Z",
} as const;

const pendingPreparation = {
  persona_id: activePersona.persona_id,
  chain_account_kind: "evm",
  hd_wallet_index: 2,
  status: "pending",
  assignment: null,
} as const;

const walletStoreWith = (
  overrides: Partial<PersonaWalletStoreService> = {},
): PersonaWalletStoreService => ({
  findOwned: storeWith().findOwned,
  reserveEvm: () => Effect.succeed(pendingPreparation),
  getEvmPreparation: () => Effect.succeed(pendingPreparation),
  confirmEvm: () => Effect.succeed(assignment),
  retire: ({ personaId }) =>
    Effect.succeed({
      persona_id: personaId,
      status: "retired",
      retired_at: "2026-08-23T23:00:00.000Z",
    }),
  ...overrides,
});

const walletServicesWith = (store: PersonaWalletStoreService) => ({
  store,
  verifier: {
    verifyPrivyEmbeddedEvmWallet: ({ hdWalletIndex }: { hdWalletIndex: number }) =>
      Effect.succeed({
        sourceUserId: "source_privy_owner",
        privyWalletId: "wallet_privy_2",
        hdWalletIndex,
        address: assignment.address,
      }),
  },
  accounts: {
    canonicalAccountId: () => Effect.succeed("account_owner"),
  },
});

describe("account-owned persona use cases", () => {
  test("creates a private pending persona with its reserved wallet index", async () => {
    let capturedAccountId = "";
    let capturedKey = "";
    let capturedIntent: unknown;
    const persona = await Effect.runPromise(
      createPersona(
        {
          accountId: "account_owner",
          body: {
            idempotency_key: "persona-create-1",
            community_id: "community_pokemon",
            display_name: "Squirtle",
            preferred_locale: "en",
          },
        },
        {
          store: storeWith({
            create: ({ accountId, idempotencyKey, intent, personaId }) => {
              capturedAccountId = accountId;
              capturedKey = idempotencyKey;
              capturedIntent = intent;
              return Effect.succeed({
                persona_id: personaId,
                chain_account_kind: "evm",
                hd_wallet_index: 2,
                status: "pending",
                assignment: null,
              });
            },
          }),
          nextPersonaId: () => Effect.succeed("persona_squirtle"),
          nowIso: () => Effect.succeed("2026-08-23T20:00:00.000Z"),
        },
      ),
    );

    expect(capturedAccountId).toBe("account_owner");
    expect(capturedKey).toBe("persona-create-1");
    expect(capturedIntent).toEqual({
      displayName: "Squirtle",
      bio: null,
      preferredLocale: "en",
      communityId: "community_pokemon",
    });
    expect(persona).toMatchObject({
      persona_id: "persona_squirtle",
      status: "pending",
      hd_wallet_index: 2,
      assignment: null,
    });
  });

  test("maps idempotency mismatches to a closed conflict", async () => {
    const exit = await Effect.runPromiseExit(
      createPersona(
        {
          accountId: "account_owner",
          body: { idempotency_key: "reused-key", community_id: "community_pokemon" },
        },
        {
          store: storeWith({
            create: () => Effect.fail(new PersonaStoreConflict({ reason: "idempotency-mismatch" })),
          }),
          nextPersonaId: () => Effect.succeed("persona_new"),
          nowIso: () => Effect.succeed("2026-08-23T20:00:00.000Z"),
        },
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(String(exit.cause)).toContain("Conflict");
      expect(String(exit.cause)).not.toContain("idempotency-mismatch");
    }
  });

  test("lists only through the authenticated account key", async () => {
    expect(
      await Effect.runPromise(
        listMyPersonas({ accountId: "account_owner" }, { store: storeWith() }),
      ),
    ).toEqual({ personas: [activePersona] });
    const exit = await Effect.runPromiseExit(
      listMyPersonas({ accountId: " account_owner" }, { store: storeWith() }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("collapses foreign, missing, suspended, and retired authority before effects", async () => {
    expect(
      await Effect.runPromise(
        requireActiveOwnedPersona(
          { accountId: "account_owner", personaId: activePersona.persona_id },
          storeWith(),
        ),
      ),
    ).toEqual(activePersona);

    for (const candidate of [
      null,
      { ...activePersona, status: "suspended" as const },
      { ...activePersona, status: "retired" as const, retired_at: "2026-08-23T21:00:00.000Z" },
    ]) {
      let effectCount = 0;
      const exit = await Effect.runPromiseExit(
        requireActiveOwnedPersona(
          { accountId: "account_owner", personaId: activePersona.persona_id },
          storeWith({
            findOwned: () => Effect.succeed(candidate),
          }),
        ).pipe(Effect.tap(() => Effect.sync(() => (effectCount += 1)))),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(effectCount).toBe(0);
      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain(PersonaUnavailable.name);
    }

    const foreign = await Effect.runPromiseExit(
      requireActiveOwnedPersona(
        { accountId: "account_other", personaId: activePersona.persona_id },
        storeWith(),
      ),
    );
    expect(Exit.isFailure(foreign)).toBe(true);
    if (Exit.isFailure(foreign)) expect(String(foreign.cause)).toContain(PersonaUnavailable.name);
  });

  test("reserves an EVM index only after active ownership is established", async () => {
    let reservationCount = 0;
    const store = walletStoreWith({
      reserveEvm: () => {
        reservationCount += 1;
        return Effect.succeed(pendingPreparation);
      },
    });
    expect(
      await Effect.runPromise(
        preparePersonaEvmWallet(
          {
            accountId: "account_owner",
            personaId: activePersona.persona_id,
            body: { idempotency_key: "wallet-prepare-1" },
          },
          walletServicesWith(store),
        ),
      ),
    ).toEqual(pendingPreparation);
    expect(reservationCount).toBe(1);

    const foreign = walletStoreWith({
      findOwned: () => Effect.succeed(null),
      getEvmPreparation: () => Effect.succeed(null),
      reserveEvm: () => {
        reservationCount += 1;
        return Effect.succeed(pendingPreparation);
      },
    });
    const exit = await Effect.runPromiseExit(
      preparePersonaEvmWallet(
        {
          accountId: "account_other",
          personaId: activePersona.persona_id,
          body: { idempotency_key: "wallet-prepare-foreign" },
        },
        walletServicesWith(foreign),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(reservationCount).toBe(1);
  });

  test("confirms only the provider wallet at the reserved index for the same account", async () => {
    let verifiedIndex = -1;
    let confirmCount = 0;
    const store = walletStoreWith({
      confirmEvm: ({ attestation }) => {
        confirmCount += 1;
        expect(attestation.hdWalletIndex).toBe(2);
        return Effect.succeed(assignment);
      },
    });
    const services = {
      ...walletServicesWith(store),
      verifier: {
        verifyPrivyEmbeddedEvmWallet: ({ hdWalletIndex }: { hdWalletIndex: number }) => {
          verifiedIndex = hdWalletIndex;
          return Effect.succeed({
            sourceUserId: "source_privy_owner",
            privyWalletId: null,
            hdWalletIndex,
            address: assignment.address,
          });
        },
      },
    };
    expect(
      await Effect.runPromise(
        confirmPersonaEvmWallet(
          {
            accountId: "account_owner",
            personaId: activePersona.persona_id,
            body: {
              proof: {
                type: "privy_access_token",
                privy_access_token: "access-token",
              },
            },
          },
          services,
        ),
      ),
    ).toEqual(assignment);
    expect(verifiedIndex).toBe(2);
    expect(confirmCount).toBe(1);
  });

  test("rejects cross-account wallet proof before committing the assignment", async () => {
    let confirmCount = 0;
    const store = walletStoreWith({
      confirmEvm: () => {
        confirmCount += 1;
        return Effect.succeed(assignment);
      },
    });
    const exit = await Effect.runPromiseExit(
      confirmPersonaEvmWallet(
        {
          accountId: "account_owner",
          personaId: activePersona.persona_id,
          body: {
            proof: { type: "privy_access_token", privy_access_token: "access-token" },
          },
        },
        {
          ...walletServicesWith(store),
          accounts: { canonicalAccountId: () => Effect.succeed("account_other") },
        },
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(confirmCount).toBe(0);
  });

  test("retains pending setup when the provider proof boundary is unavailable", async () => {
    let confirmCount = 0;
    const exit = await Effect.runPromiseExit(
      confirmPersonaEvmWallet(
        {
          accountId: "account_owner",
          personaId: activePersona.persona_id,
          body: { proof: { type: "privy_access_token", privy_access_token: "access-token" } },
        },
        {
          ...walletServicesWith(
            walletStoreWith({
              confirmEvm: () => {
                confirmCount += 1;
                return Effect.succeed(assignment);
              },
            }),
          ),
          verifier: {
            verifyPrivyEmbeddedEvmWallet: () =>
              Effect.fail(new PersonaWalletProofRejected({ reason: "unavailable" })),
          },
        },
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(confirmCount).toBe(0);
  });

  test("replays an active assignment without selecting from the login wallet set", async () => {
    let verifierCount = 0;
    const activePreparation = {
      ...pendingPreparation,
      status: "active" as const,
      assignment,
    };
    const store = walletStoreWith({
      getEvmPreparation: () => Effect.succeed(activePreparation),
    });
    const result = await Effect.runPromise(
      confirmPersonaEvmWallet(
        {
          accountId: "account_owner",
          personaId: activePersona.persona_id,
          body: {
            proof: { type: "privy_access_token", privy_access_token: "access-token" },
          },
        },
        {
          ...walletServicesWith(store),
          verifier: {
            verifyPrivyEmbeddedEvmWallet: () => {
              verifierCount += 1;
              return Effect.die("should not verify an already-active assignment");
            },
          },
        },
      ),
    );
    expect(result).toEqual(assignment);
    expect(verifierCount).toBe(0);
  });

  test("retires through the authenticated account without exposing store conflicts", async () => {
    let capturedKey = "";
    const result = await Effect.runPromise(
      retirePersona(
        {
          accountId: "account_owner",
          personaId: activePersona.persona_id,
          body: { idempotency_key: "persona-retire-1" },
        },
        {
          store: walletStoreWith({
            retire: ({ idempotencyKey, personaId }) => {
              capturedKey = idempotencyKey;
              return Effect.succeed({
                persona_id: personaId,
                status: "retired",
                retired_at: "2026-08-23T23:00:00.000Z",
              });
            },
          }),
        },
      ),
    );
    expect(capturedKey).toBe("persona-retire-1");
    expect(result.status).toBe("retired");
  });
});
