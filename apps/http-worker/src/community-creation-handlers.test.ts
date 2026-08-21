import { describe, expect, test } from "bun:test";
import type { CommunityCreationServices } from "@pirate/application/use-cases/community/creation-intents";
import { AuthError } from "@pirate/contracts";
import { Effect } from "effect";
import { makeCommunityCreationHandlers } from "./community-creation-handlers.ts";
import { createHttpWorker, type DecodedRequest, type Principal } from "./transport.ts";

const draft = {
  name: "Jazleeuw",
  description: "A community",
  route_request: { family: "hns" as const, root_label: "jazleeuw" },
  policy: {
    version: 1 as const,
    accessPaths: [
      {
        id: "verified-people",
        operator: "and" as const,
        requirements: [{ requirement: "human-verification" as const }],
      },
    ] as const,
  },
};

const requirements = {
  human_identity: {
    requirement: "human_identity" as const,
    status: "pending" as const,
    requirement_hash: "b".repeat(64),
    provider_id: "very.oauth",
    generation: 1,
    ceremony_intent_id: "human-ceremony-1",
    satisfied_at: null,
  },
  namespace_ownership: {
    requirement: "namespace_ownership" as const,
    status: "unmet" as const,
    requirement_hash: "c".repeat(64),
    provider_id: "hns.owner.v1",
    generation: 0,
    ceremony_intent_id: null,
    satisfied_at: null,
  },
};

const document = {
  intent_id: "intent-1",
  revision: 1,
  status: "verification_required" as const,
  draft,
  canonical_policy_revision: 1,
  canonical_policy_hash: "a".repeat(64),
  requirements,
  next_action: {
    kind: "start_verification" as const,
    requirement: "human_identity" as const,
    provider_id: "very.oauth",
    creation_intent_id: "intent-1",
    ceremony_intent_id: "human-ceremony-1",
    generation: 1,
  },
  expires_at: "2026-08-20T15:00:00.000Z",
  committed_resource: null,
};

const request = (overrides: Partial<DecodedRequest> = {}): DecodedRequest => ({
  body: undefined,
  params: { intentId: "intent-1" },
  query: {},
  principal: { kind: "user", subject: "user-1" },
  ...overrides,
});

function services(
  observed: {
    commit?: unknown;
    create?: unknown;
    get?: unknown;
    update?: unknown;
  },
  options: Readonly<{
    createOutcome?: "fresh" | "replayed";
    commitOutcome?: "fresh_created" | "fresh_not_created" | "replayed";
  }> = {},
): CommunityCreationServices {
  const commitOutcome = options.commitOutcome ?? "fresh_created";
  const committedDocument = {
    ...document,
    revision: 3,
    status: "committed" as const,
    next_action: { kind: "none" as const, reason: "committed" as const },
    committed_resource: {
      community_id: "community-1",
      href: "/c/app.jazleeuw",
      canonical_route: {
        family: "hns" as const,
        root_label: "jazleeuw",
        root_label_display: "jazleeuw",
        path_segment: "app.jazleeuw",
        href: "/c/app.jazleeuw",
        app_host: null,
      },
    },
  };
  const quotaDocument = {
    ...document,
    revision: 3,
    status: "quota_exceeded" as const,
    next_action: { kind: "blocked" as const, reason: "quota_exceeded" as const },
    committed_resource: null,
  };
  return {
    communityCreationStore: {
      create: (input) => {
        observed.create = input;
        return Effect.succeed({ document, outcome: options.createOutcome ?? "fresh" });
      },
      get: (input) => {
        observed.get = input;
        return Effect.succeed(document);
      },
      update: (input) => {
        observed.update = input;
        return Effect.succeed({ ...document, revision: 2 });
      },
      commit: (input) => {
        observed.commit = input;
        return Effect.succeed({
          document: commitOutcome === "fresh_not_created" ? quotaDocument : committedDocument,
          outcome: commitOutcome,
        });
      },
    },
  };
}

describe("community creation HTTP handlers", () => {
  test("maps create, get, and update to actor-scoped application use cases", async () => {
    const observed: { commit?: unknown; create?: unknown; get?: unknown; update?: unknown } = {};
    const handlers = makeCommunityCreationHandlers(services(observed));
    const principal = {
      kind: "admin" as const,
      subject: "admin-1",
      scopes: ["community:write"],
    };
    const createBody = { idempotency_key: "create-1", draft };
    const createResult = (await handlers.CreateCommunityCreationIntent(
      request({ principal, body: createBody }),
    )) as { readonly body: unknown; readonly status?: number };
    expect(createResult).toMatchObject({ body: document, status: 201 });
    expect(observed.create).toMatchObject({
      actor: { userId: "admin-1", kind: "admin", scopes: ["community:write"] },
      body: createBody,
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });

    await expect(handlers.GetCommunityCreationIntent(request({ principal }))).resolves.toEqual(
      document,
    );
    expect(observed.get).toEqual({
      actor: { userId: "admin-1", kind: "admin", scopes: ["community:write"] },
      intentId: "intent-1",
    });

    const updateBody = { idempotency_key: "update-1", expected_revision: 1, draft };
    await expect(
      handlers.UpdateCommunityCreationIntent(request({ principal, body: updateBody })),
    ).resolves.toEqual({ ...document, revision: 2 });
    expect(observed.update).toMatchObject({
      actor: { userId: "admin-1", kind: "admin", scopes: ["community:write"] },
      intentId: "intent-1",
      body: updateBody,
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });

    const commitBody = { idempotency_key: "commit-1", expected_revision: 2 };
    await expect(
      handlers.CommitCommunityCreationIntent(request({ principal, body: commitBody })),
    ).resolves.toMatchObject({
      status: 201,
      body: { status: "committed", committed_resource: { community_id: "community-1" } },
    });
    expect(observed.commit).toMatchObject({
      actor: { userId: "admin-1", kind: "admin", scopes: ["community:write"] },
      intentId: "intent-1",
      body: commitBody,
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });

  test("fails closed for signed-out, device, and delegated-agent principals", async () => {
    const handlers = makeCommunityCreationHandlers(services({}));
    const principals: readonly (Principal | null)[] = [
      null,
      { kind: "device", subject: "device-1" },
      { kind: "agent", subject: "agent-1" },
    ];
    for (const principal of principals) {
      await expect(
        handlers.CreateCommunityCreationIntent(
          request({ principal, body: { idempotency_key: "create-1", draft } }),
        ),
      ).rejects.toBeInstanceOf(AuthError);
      await expect(
        handlers.GetCommunityCreationIntent(request({ principal })),
      ).rejects.toBeInstanceOf(AuthError);
      await expect(
        handlers.UpdateCommunityCreationIntent(
          request({
            principal,
            body: { idempotency_key: "update-1", expected_revision: 1, draft },
          }),
        ),
      ).rejects.toBeInstanceOf(AuthError);
      await expect(
        handlers.CommitCommunityCreationIntent(
          request({
            principal,
            body: { idempotency_key: "commit-1", expected_revision: 2 },
          }),
        ),
      ).rejects.toBeInstanceOf(AuthError);
    }
  });

  test("uses 201 only for fresh resource creation and 200 for replay or no-create", async () => {
    const createReplay = makeCommunityCreationHandlers(services({}, { createOutcome: "replayed" }));
    await expect(
      createReplay.CreateCommunityCreationIntent(
        request({ body: { idempotency_key: "create-1", draft } }),
      ),
    ).resolves.toMatchObject({ status: 200, body: document });

    const commitReplay = makeCommunityCreationHandlers(services({}, { commitOutcome: "replayed" }));
    await expect(
      commitReplay.CommitCommunityCreationIntent(
        request({ body: { idempotency_key: "commit-1", expected_revision: 2 } }),
      ),
    ).resolves.toMatchObject({ status: 200, body: { status: "committed" } });

    const quota = makeCommunityCreationHandlers(
      services({}, { commitOutcome: "fresh_not_created" }),
    );
    await expect(
      quota.CommitCommunityCreationIntent(
        request({ body: { idempotency_key: "commit-quota", expected_revision: 2 } }),
      ),
    ).resolves.toMatchObject({
      status: 200,
      body: { status: "quota_exceeded", committed_resource: null },
    });
  });

  test("installs create/get/update/commit on generated routes", async () => {
    const worker = createHttpWorker({
      config: { corsOrigin: "https://solid.test" },
      handlers: makeCommunityCreationHandlers(services({})),
      authenticate: () => ({ kind: "user", subject: "user-1" }),
      authorize: () => undefined,
    });
    const headers = {
      authorization: "Bearer test",
      "content-type": "application/json",
    };
    const create = await worker.request("http://worker.test/community-creation-intents", {
      method: "POST",
      headers,
      body: JSON.stringify({ idempotency_key: "create-1", draft }),
    });
    expect(create.status).toBe(201);
    expect(await create.json()).toMatchObject({ intent_id: "intent-1", revision: 1 });

    const get = await worker.request("http://worker.test/community-creation-intents/intent-1", {
      headers: { authorization: "Bearer test" },
    });
    expect(get.status).toBe(200);

    const update = await worker.request("http://worker.test/community-creation-intents/intent-1", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ idempotency_key: "update-1", expected_revision: 1, draft }),
    });
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({ intent_id: "intent-1", revision: 2 });

    const malformed = await worker.request(
      "http://worker.test/community-creation-intents/intent-1",
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ idempotency_key: "update-2", expected_revision: 0, draft }),
      },
    );
    expect(malformed.status).toBe(400);

    const commit = await worker.request(
      "http://worker.test/community-creation-intents/intent-1/commit",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ idempotency_key: "commit-1", expected_revision: 2 }),
      },
    );
    expect(commit.status).toBe(201);
    expect(await commit.json()).toMatchObject({
      status: "committed",
      committed_resource: { community_id: "community-1" },
    });

    const preflight = await worker.request(
      "http://worker.test/community-creation-intents/intent-1",
      {
        method: "OPTIONS",
        headers: {
          origin: "https://solid.test",
          "access-control-request-method": "PATCH",
        },
      },
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toContain("PATCH");
  });
});
