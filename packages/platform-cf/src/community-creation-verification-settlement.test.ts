import { describe, expect, test } from "bun:test";
import type {
  ControlPlaneResult,
  ControlPlaneStatement,
  ControlPlaneTransaction,
} from "@pirate/application";
import {
  CURATED_HUMAN_MEMBERSHIP_POLICY,
  HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
  VERY_OAUTH_CONFIGURATION_REFERENCE,
  VERY_OAUTH_CONFIGURATION_VERSION,
  VERY_OAUTH_ISSUER,
  VERY_OAUTH_METHOD,
  VERY_OAUTH_PROTOCOL_VERSION,
  VERY_OAUTH_PROVIDER_ID,
  VERY_OAUTH_RP_SCOPE,
} from "@pirate/domain";
import { Effect } from "effect";
import { advanceCommunityCreationVerificationInTransaction } from "./community-creation-repository.ts";

const actorId = "creator-1";
const intentId = "intent-1";
const proofSessionId = "proof-1";
const resultHash = "f".repeat(64);
const expiresAt = "2099-08-20T00:00:00.000Z";
const completedAt = "2026-08-20T00:01:00.000Z";

const draft = {
  name: "Jazleeuw",
  slug: "jazleeuw",
  description: null,
  policy: {
    version: 1 as const,
    accessPaths: [
      {
        id: "verified-people",
        operator: "and" as const,
        requirements: [{ requirement: "human-verification" as const }],
      },
    ],
  },
};

function sessionRow() {
  return {
    proof_session_id: proofSessionId,
    actor_id: actorId,
    intent_id: intentId,
    provider_id: VERY_OAUTH_PROVIDER_ID,
    provider_configuration_kind: "dynamic",
    provider_configuration_ref: VERY_OAUTH_CONFIGURATION_REFERENCE,
    provider_configuration_version: VERY_OAUTH_CONFIGURATION_VERSION,
    method: VERY_OAUTH_METHOD,
    issuer: VERY_OAUTH_ISSUER,
    scope_kind: "issuer_rp_scope",
    issuer_rp_scope: VERY_OAUTH_RP_SCOPE,
    issuer_rp_action_scope: null,
    request_mode: "dynamic",
    requested_requirements: [
      { claim_id: "credential.subject_unique" },
      { claim_id: "human.personhood" },
    ],
    requested_claim_ids: ["credential.subject_unique", "human.personhood"],
    subject_binding_intent: "establish",
    protocol_version: VERY_OAUTH_PROTOCOL_VERSION,
    environment: "test",
    status: "completed",
    expires_at: expiresAt,
    completed_at: completedAt,
    terminal_at: completedAt,
    completion_idempotency_key: "completion-1",
    completion_result_hash: resultHash,
  };
}

function intentRow(status: "verification_required" | "commit_ready" = "verification_required") {
  return {
    intent_id: intentId,
    actor_id: actorId,
    create_idempotency_key: "create-1",
    create_request_hash: "a".repeat(64),
    revision: status === "commit_ready" ? 2 : 1,
    status,
    draft,
    canonical_policy_revision: 1,
    canonical_policy_hash: CURATED_HUMAN_MEMBERSHIP_POLICY.policy_hash,
    verification_requirement_hash: HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
    verification_provider_id: VERY_OAUTH_PROVIDER_ID,
    provider_configuration_kind: "dynamic",
    provider_configuration_ref: VERY_OAUTH_CONFIGURATION_REFERENCE,
    provider_configuration_version: VERY_OAUTH_CONFIGURATION_VERSION,
    expires_at: expiresAt,
    committed_community_id: null,
    committed_resource_href: null,
    active: true,
  };
}

function transactionWith(
  responses: Readonly<Record<string, ControlPlaneResult<Readonly<Record<string, unknown>>>>>,
  statements: ControlPlaneStatement[],
): ControlPlaneTransaction {
  return {
    execute: <Row>(statement: ControlPlaneStatement) => {
      statements.push(statement);
      const response = responses[statement.label];
      if (response === undefined) throw new Error(`unexpected statement: ${statement.label}`);
      return Effect.succeed(response as ControlPlaneResult<Row>);
    },
  };
}

describe("community creation verification settlement", () => {
  test("advances once and appends the immutable verification revision", async () => {
    const statements: ControlPlaneStatement[] = [];
    const transaction = transactionWith(
      {
        "community.creation.verification.lock-session": { rows: [sessionRow()], rowCount: 1 },
        "community.creation.verification.lock-intent": { rows: [intentRow()], rowCount: 1 },
        "community.creation.verification.validate-evidence": {
          rows: [{ evidence_valid: true }],
          rowCount: 1,
        },
        "community.creation.verification.persist-intent": { rows: [], rowCount: 1 },
        "community.creation.verification.insert-revision": { rows: [], rowCount: 1 },
      },
      statements,
    );

    await expect(
      Effect.runPromise(
        advanceCommunityCreationVerificationInTransaction(transaction, {
          actor_id: actorId,
          proof_session_id: proofSessionId,
          result_hash: resultHash,
        }),
      ),
    ).resolves.toEqual({ kind: "advanced", intent_id: intentId, revision: 2 });
    expect(statements.map((statement) => statement.label)).toEqual([
      "community.creation.verification.lock-session",
      "community.creation.verification.lock-intent",
      "community.creation.verification.validate-evidence",
      "community.creation.verification.persist-intent",
      "community.creation.verification.insert-revision",
    ]);
    expect(statements.at(-1)?.values.slice(0, 4)).toEqual([intentId, 2, actorId, "verification"]);
    expect(statements.at(-1)?.values[5]).toBe(resultHash);
  });

  test("preserves valid evidence without advancing when evidence is not authoritative", async () => {
    const statements: ControlPlaneStatement[] = [];
    const transaction = transactionWith(
      {
        "community.creation.verification.lock-session": { rows: [sessionRow()], rowCount: 1 },
        "community.creation.verification.lock-intent": { rows: [intentRow()], rowCount: 1 },
        "community.creation.verification.validate-evidence": {
          rows: [{ evidence_valid: false }],
          rowCount: 1,
        },
      },
      statements,
    );

    await expect(
      Effect.runPromise(
        advanceCommunityCreationVerificationInTransaction(transaction, {
          actor_id: actorId,
          proof_session_id: proofSessionId,
          result_hash: resultHash,
        }),
      ),
    ).resolves.toEqual({ kind: "stale", reason: "evidence_invalid" });
    expect(statements.map((statement) => statement.label)).not.toContain(
      "community.creation.verification.persist-intent",
    );
  });

  test("makes exact completion replay settlement idempotent", async () => {
    const statements: ControlPlaneStatement[] = [];
    const transaction = transactionWith(
      {
        "community.creation.verification.lock-session": { rows: [sessionRow()], rowCount: 1 },
        "community.creation.verification.lock-intent": {
          rows: [intentRow("commit_ready")],
          rowCount: 1,
        },
      },
      statements,
    );

    await expect(
      Effect.runPromise(
        advanceCommunityCreationVerificationInTransaction(transaction, {
          actor_id: actorId,
          proof_session_id: proofSessionId,
          result_hash: resultHash,
        }),
      ),
    ).resolves.toEqual({ kind: "already_ready", intent_id: intentId, revision: 2 });
    expect(statements).toHaveLength(2);
  });
});
