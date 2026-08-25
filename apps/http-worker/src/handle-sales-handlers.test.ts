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
    confirmPersonaReuse: unexpected,
    createQuote: unexpected,
    createReservation: unexpected,
    submitFreeClaim: unexpected,
    getClaim: unexpected,
    listPersonaGrants: unexpected,
    getPublicGrant: unexpected,
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
    expect(await response.json()).toMatchObject({ recipient_token: rawToken, replayed: false });
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
