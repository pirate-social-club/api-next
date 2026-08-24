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
  persona_id: "persona-community-owner",
  name: "Jazleeuw",
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
const persona = {
  persona_id: draft.persona_id,
  object: "persona" as const,
  status: "active" as const,
  profile: {
    persona_id: draft.persona_id,
    object: "persona_profile" as const,
    revision: 1,
    display_name: "Community Captain",
    avatar_ref: null,
    cover_ref: null,
    bio: null,
    preferred_locale: null,
    primary_public_handle: null,
  },
  wallet_set: { evm: null },
  created_at: "2026-08-20T12:00:00.000Z",
  retired_at: null,
};
const personaRolePresentation = {
  role: "owner" as const,
  persona: {
    persona_id: persona.persona_id,
    object: "persona" as const,
    display_name: persona.profile.display_name,
    avatar_ref: persona.profile.avatar_ref,
    primary_public_handle: persona.profile.primary_public_handle,
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
};

const document = {
  creation_contract_version: "optional_route_v2" as const,
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
  persona_role_presentation: personaRolePresentation,
  committed_resource: null,
};

function services(
  overrides: Partial<CommunityCreationStore["Service"]> = {},
): CommunityCreationServices {
  return {
    personaStore: {
      findOwned: ({ accountId, personaId }) =>
        Effect.succeed(
          accountId === actor.userId && personaId === persona.persona_id ? persona : null,
        ),
    },
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
              authority_version: "optional_route_v2" as const,
              community_id: "community_123e4567-e89b-42d3-a456-426614174000",
              href: "/c/community_123e4567-e89b-42d3-a456-426614174000",
              canonical_route: null,
              persona_role_presentation: personaRolePresentation,
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
    let receivedName = "";
    const scoped = services({
      create: ({ body, requestHash }) => {
        receivedHash = requestHash;
        receivedName = body.draft.name;
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
    expect(receivedName).toBe("Jazleeuw");

    await expect(
      Effect.runPromise(
        createCommunityCreationIntent(
          { actor, body: { draft, idempotency_key: "create-1", surprise: true } },
          scoped,
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequest);
  });

  test("rejects namespace fields from optional-route creation before hashing", async () => {
    const observed: string[] = [];
    const scoped = services({
      create: ({ requestHash }) => {
        observed.push(requestHash);
        return Effect.succeed({ document, outcome: "fresh" });
      },
    });

    await expect(
      Effect.runPromise(
        createCommunityCreationIntent(
          {
            actor,
            body: {
              idempotency_key: "equivalent-route",
              draft: {
                ...draft,
                route_request: { family: "hns", root_label: "jazleeuw" },
              },
            },
          },
          scoped,
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequest);
    expect(observed).toEqual([]);
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

  test("rejects missing, foreign, and inactive personas before creation storage", async () => {
    let createCalls = 0;
    const base = services({
      create: () => {
        createCalls += 1;
        return Effect.succeed({ document, outcome: "fresh" });
      },
    });
    for (const personaStore of [
      { findOwned: () => Effect.succeed(null) },
      {
        findOwned: () => Effect.succeed({ ...persona, status: "suspended" as const }),
      },
    ]) {
      await expect(
        Effect.runPromise(
          createCommunityCreationIntent(
            { actor, body: { draft, idempotency_key: "rejected-persona" } },
            { ...base, personaStore },
          ),
        ),
      ).rejects.toBeInstanceOf(NotFound);
    }
    expect(createCalls).toBe(0);
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
