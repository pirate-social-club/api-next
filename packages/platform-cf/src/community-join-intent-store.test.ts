import { describe, expect, test } from "bun:test";
import type { ControlPlaneStatement } from "@pirate/application";
import { communityJoinActionPayloadHash, communityJoinIntentBindingHash } from "@pirate/domain";
import { Effect } from "effect";
import { resolveOrIssueCommunityJoinIntent } from "./community-join-intent-store.ts";

function transactionWith(results: readonly (readonly Record<string, unknown>[])[]) {
  const statements: ControlPlaneStatement[] = [];
  let index = 0;
  return {
    statements,
    transaction: {
      execute: <Row>(statement: ControlPlaneStatement) => {
        statements.push(statement);
        const rows = results[index++] ?? [];
        return Effect.succeed({ rows: rows as readonly Row[], rowCount: rows.length });
      },
    },
  };
}

const intentRow = {
  action_intent_id: "community-join_existing",
  user_id: "user-a",
  community_id: "community-a",
  action_kind: "community_join",
  action_scope: "community-a",
  action_payload_hash: communityJoinActionPayloadHash("community-a"),
  intent_binding_hash: communityJoinIntentBindingHash({
    actorId: "user-a",
    communityId: "community-a",
  }),
  status: "open",
  active: true,
};

describe("community join intent issuance", () => {
  test("replays an unstarted opaque intent", async () => {
    const fixture = transactionWith([[intentRow], []]);
    await expect(
      Effect.runPromise(
        resolveOrIssueCommunityJoinIntent(fixture.transaction, {
          communityId: "community-a",
          userId: "user-a",
        }),
      ),
    ).resolves.toEqual({ kind: "start", intentId: "community-join_existing" });
    expect(fixture.statements).toHaveLength(2);
  });

  test("waits on an active pending session", async () => {
    const fixture = transactionWith([
      [intentRow],
      [
        {
          proof_session_id: "proof-a",
          actor_id: "user-a",
          intent_id: "community-join_existing",
          status: "pending",
          active: true,
        },
      ],
    ]);
    await expect(
      Effect.runPromise(
        resolveOrIssueCommunityJoinIntent(fixture.transaction, {
          communityId: "community-a",
          userId: "user-a",
        }),
      ),
    ).resolves.toEqual({ kind: "wait", intentId: "community-join_existing" });
  });

  test("issues a fresh opaque intent after a failed ceremony", async () => {
    const fixture = transactionWith([
      [intentRow],
      [
        {
          proof_session_id: "proof-a",
          actor_id: "user-a",
          intent_id: "community-join_existing",
          status: "failed",
          active: false,
        },
      ],
      [
        {
          ...intentRow,
          action_intent_id: "community-join_fresh",
        },
      ],
    ]);
    await expect(
      Effect.runPromise(
        resolveOrIssueCommunityJoinIntent(
          fixture.transaction,
          {
            communityId: "community-a",
            userId: "user-a",
          },
          { nextIntentId: () => "community-join_fresh" },
        ),
      ),
    ).resolves.toEqual({ kind: "start", intentId: "community-join_fresh" });
    expect(fixture.statements[2]?.label).toBe("community.join-intents.insert");
  });

  test("does not wait on a pending session after its action intent closes", async () => {
    const fixture = transactionWith([
      [{ ...intentRow, status: "canceled", active: true }],
      [
        {
          proof_session_id: "proof-a",
          actor_id: "user-a",
          intent_id: "community-join_existing",
          status: "pending",
          active: true,
        },
      ],
      [{ ...intentRow, action_intent_id: "community-join_fresh" }],
    ]);
    await expect(
      Effect.runPromise(
        resolveOrIssueCommunityJoinIntent(
          fixture.transaction,
          { communityId: "community-a", userId: "user-a" },
          { nextIntentId: () => "community-join_fresh" },
        ),
      ),
    ).resolves.toEqual({ kind: "start", intentId: "community-join_fresh" });
    expect(fixture.statements[2]?.label).toBe("community.join-intents.insert");
  });
});
