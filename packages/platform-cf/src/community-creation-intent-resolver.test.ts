import { describe, expect, test } from "bun:test";
import type { ControlPlaneResult, ControlPlaneStatement } from "@pirate/application";
import { VerificationStartStorageFailed } from "@pirate/application/use-cases/verification-start";
import { HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH } from "@pirate/domain";
import { Effect } from "effect";
import { makeCommunityCreationIntentResolver } from "./community-creation-intent-resolver.ts";

const boundRow = {
  intent_id: "intent-1",
  actor_id: "user-1",
  status: "verification_required",
  verification_requirement_hash: HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
  verification_provider_id: "very.oauth",
  provider_configuration_kind: "dynamic",
  provider_configuration_ref: "very-oauth",
  provider_configuration_version: "1",
  active: true,
};

function resolverWith(rows: readonly Record<string, unknown>[]) {
  const statements: ControlPlaneStatement[] = [];
  const resolver = makeCommunityCreationIntentResolver(<Row>(statement: ControlPlaneStatement) => {
    statements.push(statement);
    return Effect.succeed({ rows: rows as readonly Row[], rowCount: rows.length });
  }, "test");
  return { resolver, statements };
}

describe("community creation verification intent resolver", () => {
  test("returns the exact canonical Very palm plan for the persisted actor/intent binding", async () => {
    const { resolver, statements } = resolverWith([boundRow]);
    await expect(
      Effect.runPromise(
        resolver.resolve({
          actor_id: "user-1",
          intent_id: "intent-1",
          provider_id: "very.oauth",
        }),
      ),
    ).resolves.toEqual({
      method: "palm_oauth",
      scope: {
        kind: "named",
        scope_semantics: "issuer_rp_scope",
        issuer: "https://connect.very.org",
        rp_scope: "pirate-social",
      },
      requested_requirements: [
        { claim_id: "credential.subject_unique" },
        { claim_id: "human.personhood" },
      ],
      requested_claim_ids: ["credential.subject_unique", "human.personhood"],
      subject_binding_intent: "establish",
      protocol_version: "oauth2-oidc-v1",
      environment: "test",
    });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({
      label: "community.creation.resolve-verification-intent",
      values: ["intent-1", "user-1"],
      readonly: true,
    });
  });

  test("fails closed without exposing whether another actor owns the intent", async () => {
    for (const rows of [
      [],
      [{ ...boundRow, actor_id: "another-user" }],
      [{ ...boundRow, status: "commit_ready" }],
      [{ ...boundRow, active: false }],
      [{ ...boundRow, verification_provider_id: "self.pass" }],
      [{ ...boundRow, verification_requirement_hash: "0".repeat(64) }],
      [{ ...boundRow, provider_configuration_version: "2" }],
    ]) {
      const { resolver } = resolverWith(rows);
      await expect(
        Effect.runPromise(
          resolver.resolve({
            actor_id: "user-1",
            intent_id: "intent-1",
            provider_id: "very.oauth",
          }),
        ),
      ).resolves.toBeNull();
    }
  });

  test("rejects ambiguous storage and invalid environment configuration", async () => {
    const ambiguous = resolverWith([boundRow, boundRow]).resolver;
    await expect(
      Effect.runPromise(
        ambiguous.resolve({
          actor_id: "user-1",
          intent_id: "intent-1",
          provider_id: "very.oauth",
        }),
      ),
    ).rejects.toBeInstanceOf(VerificationStartStorageFailed);

    const invalid = makeCommunityCreationIntentResolver(
      <Row>(): Effect.Effect<ControlPlaneResult<Row>, VerificationStartStorageFailed> =>
        Effect.succeed({ rows: [], rowCount: 0 }),
      " test ",
    );
    await expect(
      Effect.runPromise(
        invalid.resolve({
          actor_id: "user-1",
          intent_id: "intent-1",
          provider_id: "very.oauth",
        }),
      ),
    ).rejects.toBeInstanceOf(VerificationStartStorageFailed);
  });
});
