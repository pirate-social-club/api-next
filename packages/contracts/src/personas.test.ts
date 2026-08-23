import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  CreatePersona,
  ListMyPersonas,
  PersonaChainAccountKindV1,
  PersonaEvmWalletAssignmentV1,
  PrivatePersonaV1,
  PublicPersonaV1,
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
} as const;

describe("account-owned persona contracts", () => {
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
    expect(request.required).toEqual(["idempotency_key"]);
    expect(Object.keys(request.properties ?? {}).sort()).toEqual([
      "bio",
      "display_name",
      "idempotency_key",
      "preferred_locale",
    ]);
  });
});
