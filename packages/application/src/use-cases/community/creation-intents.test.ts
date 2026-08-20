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
  slug: "jazleeuw",
  description: "A community",
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

const document = {
  intent_id: "intent-1",
  revision: 1,
  status: "verification_required" as const,
  draft,
  canonical_policy_revision: 1,
  canonical_policy_hash: "a".repeat(64),
  verification_requirement_hash: "b".repeat(64),
  next_action: {
    kind: "start_verification" as const,
    provider_id: "very.oauth",
    intent_id: "intent-1",
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
              href: "/communities/community-jazleeuw",
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
    const scoped = services({
      create: ({ requestHash }) => {
        receivedHash = requestHash;
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

    await expect(
      Effect.runPromise(
        createCommunityCreationIntent(
          { actor, body: { draft, idempotency_key: "create-1", surprise: true } },
          scoped,
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequest);
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
