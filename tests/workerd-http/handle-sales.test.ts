/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { HandleSalesStore } from "@pirate/application/use-cases/handles/sales";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeHandleSalesHandlers } from "../../apps/http-worker/src/handle-sales-handlers.ts";
import { createHttpWorker } from "../../apps/http-worker/src/transport.ts";

const rawToken = `hgrt_${"w".repeat(43)}`;

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
      ids: { next: Effect.sync(() => `workerd-handle-${++sequence}`) },
      tokenVault: {
        mint: Effect.succeed(rawToken),
        lookupCandidates: () => Effect.succeed([{ keyVersion: "h1", digest: "1".repeat(64) }]),
        seal: () => Effect.succeed({ keyVersion: "e1", ciphertext: new Uint8Array([1, 2, 3]) }),
        reveal: () => Effect.succeed(rawToken),
      },
    }),
    authenticate: () => ({ kind: "user", subject: "account-workerd-handle" }),
    authorize: () => undefined,
  });
};

describe("community handle sales in workerd", () => {
  it("mints a private no-store direct-grant recipient token", async () => {
    const app = workerWith(
      storeWith({
        createRecipientToken: (input) =>
          Effect.succeed({
            sealed: input.sealed,
            associatedData: "workerd-handle-token",
            expiresAt: "2026-08-26T12:10:00.000Z",
            replayed: false,
          }),
      }),
    );

    const response = await app.request(
      "https://worker.test/communities/community_123e4567-e89b-42d3-a456-426614174055/handle-direct-grant-recipient-tokens",
      {
        method: "POST",
        headers: { authorization: "Bearer workerd", "content-type": "application/json" },
        body: JSON.stringify({ idempotency_key: "workerd-recipient-token" }),
      },
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      recipient_token: rawToken,
      expires_at: "2026-08-26T12:10:00.000Z",
    });
  });

  it("rejects the retired seller-supplied recipient account command before storage", async () => {
    const app = workerWith(storeWith({}));
    const response = await app.request(
      "https://worker.test/communities/community_123e4567-e89b-42d3-a456-426614174055/handle-qualification-policies",
      {
        method: "POST",
        headers: { authorization: "Bearer workerd", "content-type": "application/json" },
        body: JSON.stringify({
          idempotency_key: "retired-direct-grant-command",
          subject_account_id: "account-private-recipient",
          expected_account_directory_binding_version: "1",
        }),
      },
    );

    expect(response.status).toBe(400);
  });
});
