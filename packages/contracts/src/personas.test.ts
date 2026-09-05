import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  ConfirmPersonaEvmWallet,
  CreatePersona,
  ListMyPersonas,
  PersonaChainAccountKindV1,
  PersonaCommunityChoiceV1,
  PersonaEvmWalletAssignmentV1,
  PersonaEvmWalletPreparationV1,
  PreparePersonaEvmWallet,
  PrivatePersonaV1,
  PublicPersonaV1,
  RetirePersona,
  schemaToOpenApi,
} from "./index.ts";

const strictDecode = (schema: Schema.Schema<unknown>) =>
  Schema.decodeUnknownSync(schema as unknown as Schema.ConstraintDecoder<unknown>, {
    onExcessProperty: "error",
  });

const privatePersona = {
  persona_id: "persona_charizard",
  object: "persona",
  status: "active",
  profile: {
    persona_id: "persona_charizard",
    object: "persona_profile",
    revision: 1,
    display_name: "Captain X",
    avatar_ref: null,
    cover_ref: null,
    bio: null,
    preferred_locale: "en",
    primary_public_handle: "name.charizard",
  },
  wallet_set: {
    evm: {
      chain_account_kind: "evm",
      hd_wallet_index: 2,
      address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      assigned_at: "2026-08-23T00:00:00.000Z",
    },
  },
  created_at: "2026-08-23T00:00:00.000Z",
  retired_at: null,
  community_binding: null,
} as const;

describe("account-owned persona contracts", () => {
  test("projects a nullable closed binding only on private personas", () => {
    for (const binding_source of [
      "first_membership",
      "community_creation",
      "persona_creation",
      "migration_single_evidence",
      "explicit_migration_resolution",
    ]) {
      const bound = {
        ...privatePersona,
        community_binding: { community_id: "community_a", binding_source },
      };
      expect(strictDecode(PrivatePersonaV1)(bound)).toEqual(bound);
    }
    for (const community_binding of [
      undefined,
      { community_id: "", binding_source: "first_membership" },
      { community_id: "community_a", binding_source: "unknown" },
    ]) {
      expect(() =>
        strictDecode(PrivatePersonaV1)({
          ...privatePersona,
          community_binding,
        }),
      ).toThrow();
    }
  });
  test("keeps the public persona projection free of account and wallet authority", () => {
    const publicPersona = {
      persona_id: privatePersona.persona_id,
      object: "persona",
      display_name: privatePersona.profile.display_name,
      avatar_ref: null,
      primary_public_handle: privatePersona.profile.primary_public_handle,
    } as const;
    expect(strictDecode(PublicPersonaV1)(publicPersona)).toEqual(publicPersona);
    for (const forbidden of [
      { account_id: "account_private" },
      { user_id: "account_private" },
      { wallet_address: privatePersona.wallet_set.evm.address },
      { hd_wallet_index: 2 },
      { community_binding: { community_id: "community_a", binding_source: "first_membership" } },
    ]) {
      expect(() => strictDecode(PublicPersonaV1)({ ...publicPersona, ...forbidden })).toThrow();
    }
  });

  test("supports only one v1 EVM chain-account kind and canonical address", () => {
    expect(Schema.decodeUnknownSync(PersonaChainAccountKindV1)("evm")).toBe("evm");
    for (const kind of ["solana", "bitcoin-taproot", "bitcoin-segwit", "cosmos", "tempo"]) {
      expect(() => Schema.decodeUnknownSync(PersonaChainAccountKindV1)(kind)).toThrow();
    }
    expect(strictDecode(PersonaEvmWalletAssignmentV1)(privatePersona.wallet_set.evm)).toEqual(
      privatePersona.wallet_set.evm,
    );
    expect(() =>
      strictDecode(PersonaEvmWalletAssignmentV1)({
        ...privatePersona.wallet_set.evm,
        address: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }),
    ).toThrow();
  });

  test("lists and creates personas only through owner-authenticated endpoints", () => {
    expect(ListMyPersonas.path).toBe("/personas");
    expect(ListMyPersonas.auth).toEqual({ policy: { kind: "userOrAdmin" } });
    expect(CreatePersona.path).toBe("/personas");
    expect(CreatePersona.auth).toEqual({ policy: { kind: "userOrAdmin" } });
    expect(strictDecode(PrivatePersonaV1)(privatePersona)).toEqual(privatePersona);

    const request = schemaToOpenApi(CreatePersona.request?.body);
    expect(request.required).toEqual(["idempotency_key", "community_id"]);
    expect(Object.keys(request.properties ?? {}).sort()).toEqual([
      "bio",
      "community_id",
      "display_name",
      "idempotency_key",
      "preferred_locale",
    ]);
  });

  test("reserves an indexed EVM wallet before provider confirmation", () => {
    const pending = {
      persona_id: privatePersona.persona_id,
      chain_account_kind: "evm",
      hd_wallet_index: 2,
      status: "pending",
      assignment: null,
    } as const;
    expect(strictDecode(PersonaEvmWalletPreparationV1)(pending)).toEqual(pending);
    expect(
      strictDecode(PersonaEvmWalletPreparationV1)({
        ...pending,
        status: "active",
        assignment: privatePersona.wallet_set.evm,
      }),
    ).toMatchObject({ status: "active", hd_wallet_index: 2 });
    expect(PreparePersonaEvmWallet.path).toBe("/personas/:personaId/wallets/evm/prepare");
    expect(PreparePersonaEvmWallet.auth).toEqual({ policy: { kind: "userOrAdmin" } });
  });

  test("confirms without accepting a client-supplied wallet address or index", () => {
    expect(ConfirmPersonaEvmWallet.path).toBe("/personas/:personaId/wallets/evm/confirm");
    expect(ConfirmPersonaEvmWallet.auth).toEqual({ policy: { kind: "userOrAdmin" } });
    const request = schemaToOpenApi(ConfirmPersonaEvmWallet.request?.body);
    expect(request.required).toEqual(["proof"]);
    expect(Object.keys(request.properties ?? {})).toEqual(["proof"]);
    expect(JSON.stringify(request)).not.toContain("wallet_address");
    expect(JSON.stringify(request)).not.toContain("hd_wallet_index");
  });

  test("accepts only a closed persona choice without a client-invented identity", () => {
    expect(
      strictDecode(PersonaCommunityChoiceV1)({ kind: "existing", persona_id: "persona_a" }),
    ).toEqual({ kind: "existing", persona_id: "persona_a" });
    expect(strictDecode(PersonaCommunityChoiceV1)({ kind: "create_new" })).toEqual({
      kind: "create_new",
    });
    expect(() =>
      strictDecode(PersonaCommunityChoiceV1)({ kind: "create_new", persona_id: "x" }),
    ).toThrow();
    expect(() => strictDecode(PersonaCommunityChoiceV1)({ kind: "reuse" })).toThrow();
    expect(() =>
      strictDecode(PersonaCommunityChoiceV1)({ kind: "existing", persona_id: "" }),
    ).toThrow();
    expect(() => strictDecode(PersonaCommunityChoiceV1)({ kind: "existing" })).toThrow();
  });

  test("retires or cancels a persona through an owner-private idempotent action", () => {
    expect(RetirePersona.path).toBe("/personas/:personaId/retire");
    expect(RetirePersona.auth).toEqual({ policy: { kind: "userOrAdmin" } });
    const request = schemaToOpenApi(RetirePersona.request?.body);
    expect(request.required).toEqual(["idempotency_key"]);
    expect(Object.keys(request.properties ?? {}).sort()).toEqual([
      "idempotency_key",
      "replacement_persona_id",
    ]);
  });
});
