import { describe, expect, test } from "bun:test";
import {
  HandleDirectGrantRecipientUnavailable,
  HandleSalesPageRejected,
  type HandleSalesStore,
} from "@pirate/application/use-cases/handles/sales";
import {
  SpacesSaleNamespaceNotReady,
  type SpacesSaleNamespaceStore,
} from "@pirate/application/use-cases/handles/spaces-sale-namespaces";
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

const workerWith = (store: HandleSalesStore, spacesSaleNamespaces?: SpacesSaleNamespaceStore) => {
  let sequence = 0;
  return createHttpWorker({
    config: { corsOrigin: "https://app.pirate.test" },
    handlers: makeHandleSalesHandlers({
      store,
      ...(spacesSaleNamespaces === undefined ? {} : { spacesSaleNamespaces }),
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
  test("routes staging Spaces activation and revision through the Spaces store", async () => {
    const communityId = "community_123e4567-e89b-42d3-a456-426614174055";
    const activation = {
      sale_namespace_activation_id: "spaces_activation_http-1",
      sale_namespace_activation_generation: 1,
      sale_namespace_activation_hash: "a".repeat(64),
      community_id: communityId,
      family: "spaces" as const,
      network: "mainnet" as const,
      canonical_root: "yahoo",
      display_root: "yahoo",
      namespace_authority: {
        kind: "verified_namespace_v1" as const,
        namespace_authority_reference: "snauth_http",
        namespace_authority_generation: 4,
      },
      operator: {
        kind: "spaces_operator_assignment_v1" as const,
        operator_assignment_id: "sassign_http",
        operator_assignment_generation: 1,
      },
      operator_funding_terms: {
        kind: "spaces_operator_funding_confirm_v1" as const,
        confirmed: true as const,
      },
      status: "active" as const,
      created_at: "2026-09-27T00:00:00.000Z",
      activated_at: "2026-09-27T00:00:00.000Z",
      suspended_at: null,
      revoked_at: null,
    };
    const seen: Array<Record<string, unknown>> = [];
    const spaces = {
      createSaleNamespace: (input: Record<string, unknown>) => {
        seen.push(input);
        return Effect.succeed({ activation, replayed: seen.length > 1 });
      },
      reviseSaleNamespace: (input: Record<string, unknown>) => {
        seen.push(input);
        return Effect.succeed({
          activation: { ...activation, status: "suspended" as const },
          replayed: false,
        });
      },
    } as unknown as SpacesSaleNamespaceStore;
    const worker = workerWith(storeWith({}), spaces);
    const command = {
      idempotency_key: "spaces-yahoo-http-1",
      family: "spaces",
      namespace_authority_reference: "snauth_http",
      expected_namespace_authority_generation: 4,
      operator_assignment_id: "sassign_http",
      expected_operator_assignment_generation: 1,
      operator_funding_terms_confirmed: true,
    };
    const path = `/communities/${communityId}/handle-sale-namespaces`;
    const send = (url: string, body: unknown) =>
      worker.request(url, {
        method: "POST",
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const created = await send(path, command);
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ activation, replayed: false });
    const replayed = await send(path, command);
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toEqual({ activation, replayed: true });
    const revised = await send(`${path}/${activation.sale_namespace_activation_id}/revisions`, {
      ...command,
      idempotency_key: "spaces-yahoo-http-2",
      expected_sale_namespace_activation_hash: activation.sale_namespace_activation_hash,
      requested_status: "suspended",
    });
    expect(revised.status).toBe(201);
    expect(await revised.json()).toMatchObject({ activation: { status: "suspended" } });
    expect(seen).toMatchObject([
      {
        accountId: "account-http",
        communityId,
        activationId: "spaces_activation_http-1",
        actionId: "spaces_action_http-2",
        operatorAssignmentId: "sassign_http",
        operatorFundingTermsConfirmed: true,
      },
      { idempotencyKey: "spaces-yahoo-http-1", activationId: "spaces_activation_http-3" },
      {
        activationId: activation.sale_namespace_activation_id,
        actionId: "spaces_action_http-5",
        requestedStatus: "suspended",
      },
    ]);
  });

  test("refuses Spaces activation when disabled or not ready", async () => {
    const body = {
      idempotency_key: "spaces-yahoo-disabled",
      family: "spaces",
      namespace_authority_reference: "snauth_http",
      expected_namespace_authority_generation: 4,
      operator_assignment_id: "sassign_http",
      expected_operator_assignment_generation: 1,
      operator_funding_terms_confirmed: true,
    };
    const request = {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify(body),
    };
    const path =
      "/communities/community_123e4567-e89b-42d3-a456-426614174055/handle-sale-namespaces";
    const disabled = await workerWith(storeWith({})).request(path, request);
    expect(disabled.status).toBe(409);
    expect(await disabled.json()).toMatchObject({
      error: { details: { reason: "service_unavailable" } },
    });
    const spaces = {
      createSaleNamespace: () =>
        Effect.fail(new SpacesSaleNamespaceNotReady({ reason: "operator_capability_unverified" })),
    } as unknown as SpacesSaleNamespaceStore;
    const notReady = await workerWith(storeWith({}), spaces).request(path, request);
    expect(notReady.status).toBe(409);
    expect(await notReady.json()).toMatchObject({
      error: { details: { reason: "service_unavailable" } },
    });
  });

  test("refuses a Spaces offering while the Spaces runtime is unavailable", async () => {
    const response = await workerWith(storeWith({})).request(
      "/communities/community_123e4567-e89b-42d3-a456-426614174055/handle-offerings",
      {
        method: "POST",
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        body: JSON.stringify({
          idempotency_key: "spaces-offering-disabled",
          terms: {
            sale_namespace_activation_id: "spaces-activation",
            expected_sale_namespace_activation_generation: 1,
            label_scope: {
              kind: "label_rule_v2",
              label_grammar_id: "spaces_subspace_label_v1",
              reserved_labels_id: "reserved_labels_spaces_01",
              expected_reserved_labels_revision: 1,
              availability: {
                kind: "length_band_v1",
                min_label_length: 8,
                max_label_length: 32,
              },
            },
            allocation_kind: "first_come_v1",
            fulfillment_kind: "spaces_native_v1",
            qualification_policy_id: "qualification_policy_spaces_members_01",
            expected_qualification_policy_revision: 1,
            pricing_id: "platform_free_handles_v1",
            expected_pricing_revision: 1,
            issuance_driver_id: "spaces_native-local",
            expected_issuance_driver_version: "1",
            quote_ttl_seconds: 120,
            reservation_ttl_seconds: 300,
          },
        }),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { details: { reason: "service_unavailable" } },
    });
  });

  test("keeps a pending Spaces name private to its claimant", async () => {
    const claim = {
      claim_id: "claim-spaces-http",
      owner_persona_id: "persona-spaces-http",
      offering_id: "offering-spaces-http",
      offering_hash: "a".repeat(64),
      quote_id: "quote-spaces-http",
      reservation_id: "reservation-spaces-http",
      reservation_hash: "b".repeat(64),
      sale_namespace_activation_id: "activation-spaces-http",
      sale_namespace_activation_generation: 1,
      fulfillment: { kind: "spaces_native_v1" as const },
      recipient: {
        kind: "persona_taproot_v1" as const,
        network: "regtest" as const,
        script_pubkey_hex: `5120${"c".repeat(64)}`,
      },
      handle: {
        family: "spaces" as const,
        namespace_root: "charizard",
        handle_label: "member",
      },
      display_identifier: "member@charizard",
      payment: {
        kind: "not_required_v1" as const,
        pricing_revision: 1,
        pricing_hash: "d".repeat(64),
        atomic_amount: "0" as const,
        status: "not_applicable" as const,
      },
      state: "issuance_pending" as const,
      delayed: false,
      safe_reason: "issuance_pending" as const,
      grant: null,
      created_at: "2026-09-24T00:00:00.000Z",
      updated_at: "2026-09-24T00:00:00.000Z",
    };
    const worker = workerWith(
      storeWith({
        getClaim: () => Effect.succeed(claim),
        getPublicGrant: () => Effect.succeed(null),
      }),
    );
    const privateResponse = await worker.request("/handle-claims/claim-spaces-http", {
      headers: { authorization: "Bearer test" },
    });
    expect(privateResponse.status).toBe(200);
    expect(privateResponse.headers.get("cache-control")).toBe("no-store");
    expect(await privateResponse.json()).toEqual(claim);

    const publicResponse = await worker.request("/handles/spaces/charizard/member");
    expect(publicResponse.status).toBe(404);
    expect(await publicResponse.json()).toMatchObject({ error: { code: "not_found" } });
  });

  test("serves a finalized Spaces grant without an HNS host projection", async () => {
    const persona = {
      persona_id: "persona-spaces-public",
      object: "persona" as const,
      display_name: "Member",
      avatar_ref: null,
      primary_public_handle: null,
    };
    const grant = {
      grant_id: "grant-spaces-public",
      grant_generation: 1,
      community_id: "community-spaces-public",
      owner_persona: persona,
      sale_namespace_activation_id: "activation-spaces-public",
      sale_namespace_activation_generation: 1,
      fulfillment: { kind: "spaces_native_v1" as const },
      handle: {
        family: "spaces" as const,
        namespace_root: "charizard",
        handle_label: "member",
      },
      display_identifier: "member@charizard",
      host: { kind: "not_applicable" as const },
      issued_at: "2026-09-24T00:00:00.000Z",
    };
    const response = await workerWith(
      storeWith({ getPublicGrant: () => Effect.succeed(grant) }),
    ).request("/handles/spaces/charizard/member");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600, must-revalidate");
    expect(await response.json()).toEqual(grant);
  });

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
      offering_authoring_presets: [
        {
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
      ],
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
