import { describe, expect, test } from "bun:test";
import type { ControlPlaneResult, ControlPlaneStatement } from "@pirate/application";
import { VerificationStartStorageFailed } from "@pirate/application/use-cases/verification-start";
import {
  CURATED_HUMAN_MEMBERSHIP_POLICY,
  HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
} from "@pirate/domain";
import { Effect } from "effect";
import { makeCommunityJoinIntentResolver } from "./community-join-intent-resolver.ts";

const INTENT_ID = "community-join_550e8400-e29b-41d4-a716-446655440000";

function exactRow(overrides: Record<string, unknown> = {}) {
  return {
    action_intent_id: INTENT_ID,
    user_id: "user-a",
    community_id: "community-a",
    action_kind: "community_join",
    action_scope: "community-a",
    action_payload_hash: CURATED_HUMAN_MEMBERSHIP_POLICY.policy_hash,
    intent_binding_hash: HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
    status: "open",
    active: true,
    ...overrides,
  };
}

function resolverWith(rows: readonly Record<string, unknown>[]) {
  const statements: ControlPlaneStatement[] = [];
  const resolver = makeCommunityJoinIntentResolver(<Row>(statement: ControlPlaneStatement) => {
    statements.push(statement);
    return Effect.succeed({ rows: rows as readonly Row[], rowCount: rows.length });
  }, "test");
  return { resolver, statements };
}

describe("community join verification intent resolver", () => {
  test("resolves an exact opaque persisted intent through the current Very binding", async () => {
    const { resolver, statements } = resolverWith([exactRow()]);
    await expect(
      Effect.runPromise(
        resolver.resolve({ actor_id: "user-a", intent_id: INTENT_ID, provider_id: "very.oauth" }),
      ),
    ).resolves.toMatchObject({
      method: "palm_oauth",
      requested_claim_ids: ["credential.subject_unique", "human.personhood"],
      environment: "test",
    });
    expect(statements[0]).toMatchObject({
      label: "community.join.resolve-verification-intent",
      readonly: true,
    });
    expect(statements[0]?.values.slice(0, 2)).toEqual([INTENT_ID, "user-a"]);
  });

  test("rejects absent, altered, foreign, and expired persisted intents", async () => {
    await expect(
      Effect.runPromise(
        resolverWith([]).resolver.resolve({
          actor_id: "user-a",
          intent_id: INTENT_ID,
          provider_id: "very.oauth",
        }),
      ),
    ).resolves.toBeNull();
    const foreignProvider = resolverWith([]);
    await expect(
      Effect.runPromise(
        foreignProvider.resolver.resolve({
          actor_id: "user-a",
          intent_id: INTENT_ID,
          provider_id: "very",
        }),
      ),
    ).resolves.toBeNull();
    expect(foreignProvider.statements).toHaveLength(0);

    const alteredIntent = resolverWith([]);
    await expect(
      Effect.runPromise(
        alteredIntent.resolver.resolve({
          actor_id: "user-a",
          intent_id: "community_join",
          provider_id: "very.oauth",
        }),
      ),
    ).resolves.toBeNull();
    expect(alteredIntent.statements).toHaveLength(1);
    for (const overrides of [
      { user_id: "user-b" },
      { community_id: "community-b" },
      { action_scope: "community-b" },
      { action_payload_hash: "0".repeat(64) },
      { intent_binding_hash: "0".repeat(64) },
      { status: "expired" },
      { active: false },
    ]) {
      await expect(
        Effect.runPromise(
          resolverWith([exactRow(overrides)]).resolver.resolve({
            actor_id: "user-a",
            intent_id: INTENT_ID,
            provider_id: "very.oauth",
          }),
        ),
      ).rejects.toBeInstanceOf(VerificationStartStorageFailed);
    }
  });

  test("fails closed for ambiguous or malformed storage and configuration", async () => {
    for (const rows of [[exactRow(), exactRow()], [exactRow({ active: "true" })]]) {
      await expect(
        Effect.runPromise(
          resolverWith(rows).resolver.resolve({
            actor_id: "user-a",
            intent_id: INTENT_ID,
            provider_id: "very.oauth",
          }),
        ),
      ).rejects.toBeInstanceOf(VerificationStartStorageFailed);
    }
    await expect(
      Effect.runPromise(
        makeCommunityJoinIntentResolver(
          <Row>(): Effect.Effect<ControlPlaneResult<Row>, VerificationStartStorageFailed> =>
            Effect.succeed({ rows: [], rowCount: 0 }),
          " test ",
        ).resolve({ actor_id: "user-a", intent_id: INTENT_ID, provider_id: "very.oauth" }),
      ),
    ).rejects.toBeInstanceOf(VerificationStartStorageFailed);
  });
});
