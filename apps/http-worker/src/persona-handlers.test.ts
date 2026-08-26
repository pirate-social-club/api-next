import { describe, expect, test } from "bun:test";
import type { PersonaRecord, PersonaWalletServices } from "@pirate/application/use-cases/personas";
import { Effect } from "effect";
import { makePersonaHandlers, type PersonaHandlerServices } from "./persona-handlers.ts";
import type { DecodedRequest } from "./transport.ts";

const persona: PersonaRecord = {
  persona_id: "persona_handler",
  object: "persona",
  status: "active",
  profile: {
    persona_id: "persona_handler",
    object: "persona_profile",
    revision: 1,
    display_name: "Handler Persona",
    avatar_ref: null,
    cover_ref: null,
    bio: null,
    preferred_locale: null,
    primary_public_handle: null,
  },
  wallet_set: { evm: null },
  created_at: "2026-08-24T12:00:00.000Z",
  retired_at: null,
};

const request = (overrides: Partial<DecodedRequest> = {}): DecodedRequest => ({
  body: undefined,
  params: {},
  query: {},
  principal: { kind: "user", subject: "account_handler" },
  ...overrides,
});

function services(observed: unknown[]): PersonaHandlerServices {
  const store = {
    listByAccount: (accountId: string) => {
      observed.push({ list: accountId });
      return Effect.succeed([persona]);
    },
    findOwned: (input: { readonly accountId: string; readonly personaId: string }) => {
      observed.push({ find: input });
      return Effect.succeed(persona);
    },
    create: (input: Parameters<PersonaHandlerServices["personas"]["store"]["create"]>[0]) => {
      observed.push({ create: input });
      return Effect.succeed({
        persona_id: input.personaId,
        chain_account_kind: "evm",
        hd_wallet_index: 2,
        status: "pending",
        assignment: null,
      } as const);
    },
  };
  const walletStore: PersonaWalletServices["store"] = {
    findOwned: store.findOwned,
    reserveEvm: (input) => {
      observed.push({ reserve: input });
      return Effect.succeed({
        persona_id: input.personaId,
        chain_account_kind: "evm",
        hd_wallet_index: 2,
        status: "pending",
        assignment: null,
      });
    },
    getEvmPreparation: (input) => {
      observed.push({ preparation: input });
      return Effect.succeed({
        persona_id: input.personaId,
        chain_account_kind: "evm",
        hd_wallet_index: 2,
        status: "pending",
        assignment: null,
      });
    },
    confirmEvm: (input) => {
      observed.push({ confirm: input });
      return Effect.succeed({
        chain_account_kind: "evm",
        hd_wallet_index: 2,
        address: input.attestation.address,
        assigned_at: "2026-08-24T12:01:00.000Z",
      });
    },
    retire: (input) => {
      observed.push({ retire: input });
      return Effect.succeed({
        persona_id: input.personaId,
        status: "retired",
        retired_at: "2026-08-24T12:02:00.000Z",
      });
    },
  };
  return {
    personas: {
      store,
      nextPersonaId: () => Effect.succeed(persona.persona_id),
      nowIso: () => Effect.succeed(persona.created_at),
    },
    wallets: {
      store: walletStore,
      verifier: {
        verifyPrivyEmbeddedEvmWallet: ({ hdWalletIndex }) =>
          Effect.succeed({
            sourceUserId: "privy_handler",
            privyWalletId: "wallet_handler",
            hdWalletIndex,
            address: "0x1111111111111111111111111111111111111111",
          }),
      },
      accounts: { canonicalAccountId: () => Effect.succeed("account_handler") },
    },
  };
}

describe("persona HTTP handlers", () => {
  test("derives list and create authority only from the authenticated account", async () => {
    const observed: unknown[] = [];
    const handlers = makePersonaHandlers(services(observed));
    await expect(handlers.ListMyPersonas(request())).resolves.toEqual({ personas: [persona] });
    const created = await handlers.CreatePersona(
      request({
        body: {
          idempotency_key: "persona-handler-create",
          display_name: "Handler Persona",
        },
      }),
    );
    expect(created).toMatchObject({
      body: { persona_id: persona.persona_id, status: "pending", hd_wallet_index: 2 },
      status: 201,
    });
    expect(observed).toContainEqual({ list: "account_handler" });
    expect(observed).toContainEqual({
      create: expect.objectContaining({
        accountId: "account_handler",
        idempotencyKey: "persona-handler-create",
      }),
    });
  });

  test("binds wallet preparation and confirmation to the path persona and session account", async () => {
    const observed: unknown[] = [];
    const handlers = makePersonaHandlers(services(observed));
    const params = { personaId: persona.persona_id };
    await handlers.PreparePersonaEvmWallet(
      request({ params, body: { idempotency_key: "persona-handler-wallet" } }),
    );
    await handlers.ConfirmPersonaEvmWallet(
      request({
        params,
        body: { proof: { privy_access_token: "privy-access-handler" } },
      }),
    );
    expect(observed).toContainEqual({
      reserve: {
        accountId: "account_handler",
        personaId: persona.persona_id,
        idempotencyKey: "persona-handler-wallet",
      },
    });
    expect(observed).toContainEqual({
      confirm: expect.objectContaining({
        accountId: "account_handler",
        personaId: persona.persona_id,
      }),
    });
  });

  test("rejects non-human principals before invoking a persona service", async () => {
    const observed: unknown[] = [];
    const handlers = makePersonaHandlers(services(observed));
    for (const principal of [
      null,
      { kind: "device" as const, subject: "device_handler" },
      { kind: "agent" as const, subject: "agent_handler" },
    ]) {
      await expect(handlers.ListMyPersonas(request({ principal }))).rejects.toMatchObject({
        code: "auth_error",
      });
    }
    expect(observed).toEqual([]);
  });
});
