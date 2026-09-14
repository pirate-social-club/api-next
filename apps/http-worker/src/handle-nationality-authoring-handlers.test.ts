import { expect, test } from "bun:test";
import {
  type HandleNationalityAuthoringStore,
  type HandleNationalityQualificationStore,
  HandleSalesRejected,
} from "@pirate/application/use-cases/handles/sales";
import { Effect } from "effect";
import { makeHandleNationalityAuthoringHandlers } from "./handle-nationality-authoring-handlers.ts";
import { createHttpWorker } from "./transport.ts";

const reference = "a".repeat(64);
const context = {
  kind: "nationality_authoring_context_v1" as const,
  community_id: "group",
  authoring_reference: reference,
  policy_revision: 1,
  lifetime: { kind: "max_age_seconds" as const, seconds: 31_536_000 },
  accepted_provider_ids: ["self.pass", "zkpassport"] as const,
};
const policy = {
  kind: "nationality_policy_authored_v1" as const,
  request_hash: "b".repeat(64),
  qualification_policy: {
    kind: "curated_nationality_v1" as const,
    policy_id: "policy",
    policy_revision: 1,
    policy_hash: "c".repeat(64),
    requirement_hash: "d".repeat(64),
    provider_binding_hashes: ["e".repeat(64), "f".repeat(64)] as const,
    lifetime: context.lifetime,
  },
  created_at: "2026-09-14T00:00:00.000Z",
  replayed: false,
};
const worker = (
  store: HandleNationalityAuthoringStore,
  qualification?: HandleNationalityQualificationStore,
) =>
  createHttpWorker({
    config: { corsOrigin: "https://app.pirate.test" },
    handlers: makeHandleNationalityAuthoringHandlers({
      store,
      ...(qualification === undefined ? {} : { qualification }),
      ids: { next: Effect.succeed("server-id") },
    }),
    authenticate: () => ({ kind: "user", subject: "authenticated-seller" }),
    authorize: () => undefined,
  });
const headers = { authorization: "Bearer test", "content-type": "application/json" };

test("uses the authenticated seller and returns private server context and generated policy identity", async () => {
  let observed: unknown;
  const app = worker({
    getContext: (input) => {
      observed = input;
      return Effect.succeed(context);
    },
    createPolicy: (input) => {
      observed = input;
      return Effect.succeed(policy);
    },
  });
  const read = await app.request("/communities/group/handle-nationality-authoring", { headers });
  expect(read.status).toBe(200);
  expect(read.headers.get("cache-control")).toBe("private, no-store");
  expect(await read.json()).toEqual(context);
  expect(observed).toEqual({ accountId: "authenticated-seller", communityId: "group" });
  const created = await app.request(
    "/communities/group/handle-nationality-qualification-policies",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        idempotency_key: "command",
        authoring_reference: reference,
        allowed_countries: ["US"],
      }),
    },
  );
  expect(created.status).toBe(201);
  expect(await created.json()).toEqual(policy);
  expect(observed).toMatchObject({
    accountId: "authenticated-seller",
    communityId: "group",
    allowedCountries: ["US"],
    authoringReference: reference,
    policyId: "nationality_policy_server-id",
    actionId: "nationality_policy_action_server-id",
  });
});

test("rejects client-selected provider bindings, lifetime or actor fields before persistence", async () => {
  let calls = 0;
  const app = worker({
    getContext: () => Effect.succeed(context),
    createPolicy: () => {
      calls++;
      return Effect.succeed(policy);
    },
  });
  for (const extra of [
    { provider_id: "zkpassport" },
    { evidence_lifetime: { kind: "no_age_limit" } },
    { actor_account_id: "other" },
    { provider_binding_hash: reference },
  ]) {
    const response = await app.request(
      "/communities/group/handle-nationality-qualification-policies",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          idempotency_key: "command",
          authoring_reference: reference,
          allowed_countries: ["US"],
          ...extra,
        }),
      },
    );
    expect(response.status).toBe(400);
  }
  expect(calls).toBe(0);
});

test("maps unavailable authoring to a safe failure without exposing provider configuration", async () => {
  const app = worker({
    getContext: () =>
      Effect.fail(new HandleSalesRejected({ reason: "offering_unavailable", retryable: false })),
    createPolicy: () => Effect.succeed(policy),
  });
  const response = await app.request("/communities/group/handle-nationality-authoring", {
    headers,
  });
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(await response.json()).toMatchObject({
    error: { details: { reason: "offering_unavailable" } },
  });
});

test("buyer qualification uses the session actor and never caches progress", async () => {
  let observed: unknown;
  const progress = {
    kind: "handle_nationality_progress_v1" as const,
    qualification_intent_id: "intent",
    offering_id: "offering",
    requirement_hash: reference,
    accepted_provider_ids: ["self.pass", "zkpassport"] as const,
    status: "qualified" as const,
    next_action: { kind: "request_new_quote" as const },
  };
  const app = worker(
    { getContext: () => Effect.succeed(context), createPolicy: () => Effect.succeed(policy) },
    {
      getProgress: (input) => {
        observed = input;
        return Effect.succeed(progress);
      },
    },
  );
  const response = await app.request("/handle-qualification-intents/intent", { headers });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual(progress);
  expect(observed).toEqual({ accountId: "authenticated-seller", intentId: "intent" });
});
