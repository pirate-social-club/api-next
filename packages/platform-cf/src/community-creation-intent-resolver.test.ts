import { describe, expect, test } from "bun:test";
import type { ControlPlaneResult, ControlPlaneStatement } from "@pirate/application";
import { VerificationStartStorageFailed } from "@pirate/application/use-cases/verification-start";
import {
  communityCreationCeremonyReservationHash,
  communityCreationProviderBindingHash,
  HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
} from "@pirate/domain";
import { Effect } from "effect";
import { makeCommunityCreationIntentResolver } from "./community-creation-intent-resolver.ts";

const providerBindingHash = communityCreationProviderBindingHash({
  requirement: "human_identity",
  family: null,
  provider_id: "very.oauth",
  provider_configuration: { kind: "dynamic", reference: "very-oauth", version: "1" },
  protocol_version: "oauth2-oidc-v1",
});
const creationInput = {
  actor_id: "user-1",
  provider_id: "very.oauth",
  creation_intent_id: "intent-1",
  ceremony_intent_id: "ceremony-1",
  requirement: "human_identity" as const,
  generation: 1,
  expected_revision: 1,
  idempotency_key: "start-1",
};
const boundRow = {
  intent_id: "intent-1",
  actor_id: "user-1",
  revision: "1",
  status: "verification_required",
  creation_contract_version: "route_v1",
  requirement_kind: "human_identity",
  requirement_status: "pending",
  requirement_hash: HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
  provider_id: "very.oauth",
  provider_binding_hash: providerBindingHash,
  provider_configuration_kind: "dynamic",
  provider_configuration_ref: "very-oauth",
  provider_configuration_version: "1",
  generation: "1",
  current_ceremony_intent_id: "ceremony-1",
  route_family: null,
  route_root_label: null,
  route_root_label_display: null,
  route_path_segment: null,
  ceremony_intent_id: "ceremony-1",
  ceremony_requirement_kind: "human_identity",
  ceremony_generation: "1",
  ceremony_requirement_hash: HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
  ceremony_provider_id: "very.oauth",
  ceremony_provider_binding_hash: providerBindingHash,
  ceremony_provider_configuration_kind: "dynamic",
  ceremony_provider_configuration_ref: "very-oauth",
  ceremony_provider_configuration_version: "1",
  ceremony_route_family: null,
  ceremony_route_root_label: null,
  ceremony_route_root_label_display: null,
  ceremony_route_path_segment: null,
  reservation_request_hash: communityCreationCeremonyReservationHash({
    actor_id: "user-1",
    creation_intent_id: "intent-1",
    ceremony_intent_id: "ceremony-1",
    requirement: "human_identity",
    generation: 1,
    requirement_hash: HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
    provider_id: "very.oauth",
    provider_binding_hash: providerBindingHash,
    route: null,
  }),
  intent_active: true,
  ceremony_active: true,
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
    await expect(Effect.runPromise(resolver.resolve(creationInput))).resolves.toEqual({
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
      values: ["intent-1", "user-1", "ceremony-1"],
      readonly: true,
    });
  });

  test("fails closed without exposing whether another actor owns the intent", async () => {
    for (const rows of [
      [],
      [{ ...boundRow, actor_id: "another-user" }],
      [{ ...boundRow, status: "commit_ready" }],
      [{ ...boundRow, intent_active: false }],
      [{ ...boundRow, provider_id: "self.pass" }],
      [{ ...boundRow, requirement_hash: "0".repeat(64) }],
      [{ ...boundRow, provider_configuration_version: "2" }],
    ]) {
      const { resolver } = resolverWith(rows);
      await expect(Effect.runPromise(resolver.resolve(creationInput))).resolves.toBeNull();
    }
  });

  test("rejects ambiguous storage and invalid environment configuration", async () => {
    const ambiguous = resolverWith([boundRow, boundRow]).resolver;
    await expect(Effect.runPromise(ambiguous.resolve(creationInput))).rejects.toBeInstanceOf(
      VerificationStartStorageFailed,
    );

    const invalid = makeCommunityCreationIntentResolver(
      <Row>(): Effect.Effect<ControlPlaneResult<Row>, VerificationStartStorageFailed> =>
        Effect.succeed({ rows: [], rowCount: 0 }),
      " test ",
    );
    await expect(Effect.runPromise(invalid.resolve(creationInput))).rejects.toBeInstanceOf(
      VerificationStartStorageFailed,
    );
  });
});
