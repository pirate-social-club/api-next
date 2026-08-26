import { describe, expect, test } from "bun:test";
import {
  HandleDirectGrantRecipientUnavailable,
  HandleSalesPageRejected,
  type HandleSalesStore,
} from "@pirate/application/use-cases/handles/sales";
import { Effect } from "effect";
import { makeHandleSalesHandlers } from "./handle-sales-handlers.ts";
import { createHttpWorker } from "./transport.ts";

const rawToken = `hgrt_${"a".repeat(43)}`;

const unexpected = (): never => {
  throw new Error("unexpected handle-sales store call");
};

const storeWith = (overrides: Partial<HandleSalesStore>): HandleSalesStore =>
  ({
    createSaleNamespace: unexpected,
    reviseSaleNamespace: unexpected,
    listSaleNamespaces: unexpected,
    createRecipientToken: unexpected,
    createQualificationPolicy: unexpected,
    createOffering: unexpected,
    reviseOffering: unexpected,
    listOfferings: unexpected,
    getManagementContext: unexpected,
    listManagementSaleNamespaces: unexpected,
    listManagementOfferings: unexpected,
    confirmPersonaReuse: unexpected,
    createQuote: unexpected,
    createReservation: unexpected,
    submitFreeClaim: unexpected,
    getClaim: unexpected,
    listPersonaGrants: unexpected,
    getPublicGrant: unexpected,
    getPublicPersona: unexpected,
    ...overrides,
  }) as HandleSalesStore;

const workerWith = (store: HandleSalesStore) => {
  let sequence = 0;
  return createHttpWorker({
    config: { corsOrigin: "https://app.pirate.test" },
    handlers: makeHandleSalesHandlers({
      store,
      ids: { next: Effect.sync(() => `http-${++sequence}`) },
      tokenVault: {
        mint: Effect.succeed(rawToken),
        lookupCandidates: () => Effect.succeed([{ keyVersion: "h1", digest: "1".repeat(64) }]),
        seal: () => Effect.succeed({ keyVersion: "e1", ciphertext: new Uint8Array([1, 2, 3]) }),
        reveal: () => Effect.succeed(rawToken),
      },
    }),
    authenticate: () => ({ kind: "user", subject: "account-http" }),
    authorize: () => undefined,
  });
};

describe("handle sales HTTP handlers", () => {
  test("serves the seller-management context only to the authorized account", async () => {
    let observedAccount: string | undefined;
    const context = {
      community_id: "community_123e4567-e89b-42d3-a456-426614174055",
      sale_namespace_candidates: [
        {
          kind: "ready_v1" as const,
          family: "hns" as const,
          canonical_root: "charizard",
          display_root: "charizard",
          namespace_authority_reference: "evidence:charizard",
          expected_namespace_authority_generation: 3,
          dns_zone_activation_id: "dns-zone:charizard",
          expected_dns_zone_activation_generation: 2,
        },
      ],
      offering_authoring_preset: {
        kind: "hns_hosted_persona_free_v1" as const,
        reserved_labels_id: "reserved_labels_01",
        expected_reserved_labels_revision: 1,
        broad_qualification_policy_id: "none_v1",
        expected_broad_qualification_policy_revision: 1,
        expected_account_directory_binding_version: "1",
        pricing_id: "platform_free_handles_v1",
        expected_pricing_revision: 1,
        issuance_driver_id: "hosted_persona-local",
        expected_issuance_driver_version: "1",
        quote_ttl_seconds: 120,
        reservation_ttl_seconds: 300,
      },
      observed_at: "2026-08-26T00:00:00.000Z",
    };
    const worker = workerWith(
      storeWith({
        getManagementContext: (input) => {
          observedAccount = input.accountId;
          return Effect.succeed(context);
        },
      }),
    );
    const response = await worker.request(
      `/communities/${context.community_id}/handle-sales-management`,
      { headers: { authorization: "Bearer test" } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(context);
    expect(observedAccount).toBe("account-http");
  });

  test("collapses unknown and unauthorized seller-management reads to private 404", async () => {
    const response = await workerWith(
      storeWith({ getManagementContext: () => Effect.succeed(null) }),
    ).request(
      "/communities/community_123e4567-e89b-42d3-a456-426614174055/handle-sales-management",
      { headers: { authorization: "Bearer test" } },
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  });

  test("serves a persona-native public profile with V3 grants and no-store", async () => {
    const persona = {
      persona_id: "persona-public-http",
      object: "persona" as const,
      display_name: "Public Persona",
      avatar_ref: null,
      primary_public_handle: null,
    };
    const profile = {
      persona,
      profile: { revision: 2, cover_ref: null, bio: "Public bio" },
      handle_grants: [
        {
          grant_id: "grant-public-http",
          grant_generation: 1,
          community_id: "community-public-http",
          owner_persona: persona,
          sale_namespace_activation_id: "activation-public-http",
          sale_namespace_activation_generation: 3,
          fulfillment: { kind: "hosted_persona_v1" as const },
          handle: {
            family: "hns" as const,
            namespace_root: "charizard",
            handle_label: "longname",
          },
          display_identifier: "longname.charizard",
          host: {
            kind: "available" as const,
            normalized_host: "longname.charizard",
            sale_namespace_activation_generation: 3,
            grant_generation: 1,
          },
          issued_at: "2026-08-26T00:00:00.000Z",
        },
      ],
    };
    const response = await workerWith(
      storeWith({ getPublicPersona: () => Effect.succeed(profile) }),
    ).request(`/public-personas/${persona.persona_id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(profile);
  });

  test("keeps unknown public personas enumeration-safe", async () => {
    const response = await workerWith(
      storeWith({ getPublicPersona: () => Effect.succeed(null) }),
    ).request("/public-personas/persona-unknown");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  });

  test("returns the recipient token only to an authenticated no-store response", async () => {
    let persistedAccount: string | undefined;
    const worker = workerWith(
      storeWith({
        createRecipientToken: (input) => {
          persistedAccount = input.accountId;
          return Effect.succeed({
            sealed: input.sealed,
            associatedData: JSON.stringify([
              "pirate-handle-recipient-token-envelope-v1",
              input.accountId,
              input.communityId,
              input.idempotencyKey,
              input.tokenId,
            ]),
            expiresAt: "2026-08-26T00:10:00.000Z",
            replayed: false,
          });
        },
      }),
    );
    const response = await worker.request(
      "/communities/community_123e4567-e89b-42d3-a456-426614174055/handle-direct-grant-recipient-tokens",
      {
        method: "POST",
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        body: JSON.stringify({ idempotency_key: "token-http-key" }),
      },
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      recipient_token: rawToken,
      expires_at: "2026-08-26T00:10:00.000Z",
    });
    expect(persistedAccount).toBe("account-http");
  });

  test("preserves the single non-disclosing unusable-token response", async () => {
    const worker = workerWith(
      storeWith({
        createQualificationPolicy: () => Effect.fail(new HandleDirectGrantRecipientUnavailable({})),
      }),
    );
    const response = await worker.request(
      "/communities/community_123e4567-e89b-42d3-a456-426614174055/handle-qualification-policies",
      {
        method: "POST",
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        body: JSON.stringify({
          idempotency_key: "policy-http-key",
          requirement: { kind: "account_allowlist_v1", recipient_token: rawToken },
          expected_account_directory_binding_version: "1",
        }),
      },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "direct_grant_recipient_unavailable", retryable: false },
    });
  });

  test("rejects the historical seller-supplied account command before the store", async () => {
    let calls = 0;
    const worker = workerWith(
      storeWith({
        createQualificationPolicy: () => {
          calls += 1;
          return Effect.die("the v1 policy command must not reach storage");
        },
      }),
    );
    const response = await worker.request(
      "/communities/community_123e4567-e89b-42d3-a456-426614174055/handle-qualification-policies",
      {
        method: "POST",
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        body: JSON.stringify({
          idempotency_key: "legacy-policy-key",
          requirement: { kind: "account_allowlist_v1", subject_account_id: "private-account" },
          expected_account_directory_binding_version: "1",
        }),
      },
    );
    expect(response.status).toBe(400);
    expect(calls).toBe(0);
  });

  test("maps a scope-invalid opaque cursor to the declared bad request", async () => {
    const worker = workerWith(
      storeWith({
        listOfferings: () => Effect.fail(new HandleSalesPageRejected({ reason: "invalid_cursor" })),
      }),
    );
    const response = await worker.request(
      "/communities/community_123e4567-e89b-42d3-a456-426614174055/handle-offerings?cursor=hcp1.invalid",
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "bad_request", retryable: false },
    });
  });
});
