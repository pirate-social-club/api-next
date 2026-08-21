import { describe, expect, test } from "bun:test";
import { BadRequest, Conflict, InternalError, NotFound } from "@pirate/contracts";
import { Effect } from "effect";
import {
  CommunityCreationRepositoryError,
  type CommunityCreationStore,
  ControlPlaneStatementFailed,
} from "../../ports.ts";
import {
  type CommunityCreationServices,
  commitCommunityCreationIntent,
  createCommunityCreationIntent,
  getCommunityCreationIntent,
  updateCommunityCreationIntent,
} from "./creation-intents.ts";

const actor = { userId: "user-alice", kind: "user" as const };
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

function services(
  overrides: Partial<CommunityCreationStore["Service"]> = {},
): CommunityCreationServices {
  return {
    communityCreationStore: {
      create: () => Effect.succeed({ document, outcome: "fresh" }),
      get: () => Effect.succeed(document),
      update: () => Effect.succeed({ ...document, revision: 2 }),
      commit: () =>
        Effect.succeed({
          document: {
            ...document,
            revision: 2,
            status: "committed" as const,
            next_action: { kind: "none" as const, reason: "committed" as const },
            committed_resource: {
              community_id: "community-jazleeuw",
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
          },
          outcome: "fresh_created" as const,
        }),
      ...overrides,
    },
  };
}

describe("community creation intent application use cases", () => {
  test("decodes strictly and fingerprints the canonical create request", async () => {
    let receivedHash = "";
    let receivedRoot = "";
    const scoped = services({
      create: ({ body, requestHash }) => {
        receivedHash = requestHash;
        receivedRoot = body.draft.route_request.root_label;
        return Effect.succeed({ document, outcome: "fresh" });
      },
    });

    await expect(
      Effect.runPromise(
        createCommunityCreationIntent(
          { actor, body: { draft, idempotency_key: "create-1" } },
          scoped,
        ),
      ),
    ).resolves.toEqual({ document, outcome: "fresh" });
    expect(receivedHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(receivedRoot).toBe("jazleeuw");

    await expect(
      Effect.runPromise(
        createCommunityCreationIntent(
          { actor, body: { draft, idempotency_key: "create-1", surprise: true } },
          scoped,
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequest);
  });

  test("canonicalizes Unicode and ACE route writes before idempotency hashing", async () => {
    const observed: Array<{ readonly root: string; readonly hash: string }> = [];
    const scoped = services({
      create: ({ body, requestHash }) => {
        observed.push({ root: body.draft.route_request.root_label, hash: requestHash });
        return Effect.succeed({ document, outcome: "fresh" });
      },
    });

    for (const root_label of ["münchen", "xn--mnchen-3ya"]) {
      await Effect.runPromise(
        createCommunityCreationIntent(
          {
            actor,
            body: {
              idempotency_key: "equivalent-route",
              draft: {
                ...draft,
                route_request: { family: "hns", root_label },
              },
            },
          },
          scoped,
        ),
      );
    }

    expect(observed).toHaveLength(2);
    expect(observed[0]?.root).toBe("xn--mnchen-3ya");
    expect(observed[1]?.root).toBe("xn--mnchen-3ya");
    expect(observed[0]?.hash).toBe(observed[1]?.hash);
  });

  test("keeps read and mutation access actor-scoped", async () => {
    let observedActor = "";
    const scoped = services({
      get: ({ actor: current }) => {
        observedActor = current.userId;
        return Effect.succeed(document);
      },
    });
    await expect(
      Effect.runPromise(getCommunityCreationIntent({ actor, intentId: "intent-1" }, scoped)),
    ).resolves.toEqual(document);
    expect(observedActor).toBe(actor.userId);

    await expect(
      Effect.runPromise(
        getCommunityCreationIntent(
          { actor: { userId: "agent-1", kind: "agent" }, intentId: "intent-1" },
          scoped,
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequest);
  });

  test("passes expected revisions and maps stale writers to conflict", async () => {
    let updateRevision = 0;
    let commitRevision = 0;
    const scoped = services({
      update: ({ body }) => {
        updateRevision = body.expected_revision;
        return Effect.fail(
          new CommunityCreationRepositoryError({
            operation: "update",
            reason: "revision-conflict",
          }),
        );
      },
      commit: ({ body }) => {
        commitRevision = body.expected_revision;
        return Effect.fail(
          new CommunityCreationRepositoryError({
            operation: "commit",
            reason: "revision-conflict",
          }),
        );
      },
    });

    await expect(
      Effect.runPromise(
        updateCommunityCreationIntent(
          {
            actor,
            intentId: "intent-1",
            body: { expected_revision: 4, idempotency_key: "update-1", draft },
          },
          scoped,
        ),
      ),
    ).rejects.toBeInstanceOf(Conflict);
    await expect(
      Effect.runPromise(
        commitCommunityCreationIntent(
          {
            actor,
            intentId: "intent-1",
            body: { expected_revision: 5, idempotency_key: "commit-1" },
          },
          scoped,
        ),
      ),
    ).rejects.toBeInstanceOf(Conflict);
    expect(updateRevision).toBe(4);
    expect(commitRevision).toBe(5);
  });

  test("maps absence and storage failures without leaking details", async () => {
    await expect(
      Effect.runPromise(
        getCommunityCreationIntent(
          { actor, intentId: "intent-1" },
          services({ get: () => Effect.succeed(null) }),
        ),
      ),
    ).rejects.toBeInstanceOf(NotFound);

    const failure = new ControlPlaneStatementFailed({
      label: "community-creation.intent.read",
      sqlState: "XX000",
      constraint: null,
      outcomeCertainty: "completed",
    });
    await expect(
      Effect.runPromise(
        getCommunityCreationIntent(
          { actor, intentId: "intent-1" },
          services({ get: () => Effect.fail(failure) }),
        ),
      ),
    ).rejects.toBeInstanceOf(InternalError);
  });
});
