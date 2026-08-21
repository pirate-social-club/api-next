import { describe, expect, test } from "bun:test";
import type {
  ControlPlaneResult,
  ControlPlaneStatement,
  ControlPlaneTransaction,
} from "@pirate/application";
import {
  CURATED_HUMAN_MEMBERSHIP_POLICY,
  communityCreationProviderBindingHash,
  communityNamespaceRequirementHash,
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

type Row = Readonly<Record<string, unknown>>;
type Response = ControlPlaneResult<Row> | readonly ControlPlaneResult<Row>[];

const actorId = "creator-1";
const intentId = "intent-1";
const ceremonyIntentId = "human-ceremony-1";
const proofSessionId = "proof-1";
const resultHash = "f".repeat(64);
const completedAt = "2026-08-20T00:01:00.000Z";
const expiresAt = "2099-08-20T00:00:00.000Z";
const humanBindingHash = communityCreationProviderBindingHash({
  requirement: "human_identity",
  family: null,
  provider_id: VERY_OAUTH_PROVIDER_ID,
  provider_configuration: {
    kind: "dynamic",
    reference: VERY_OAUTH_CONFIGURATION_REFERENCE,
    version: VERY_OAUTH_CONFIGURATION_VERSION,
  },
  protocol_version: VERY_OAUTH_PROTOCOL_VERSION,
});
const namespaceRequirement = communityNamespaceRequirementHash({
  family: "hns",
  root_label: "jazleeuw",
});
if (namespaceRequirement.kind === "rejected") throw new Error("invalid namespace fixture");
const namespaceRequirementHash = namespaceRequirement.value;

const draft = {
  name: "Jazleeuw",
  description: null,
  route_request: { family: "hns" as const, root_label: "jazleeuw" },
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
    intent_id: ceremonyIntentId,
    creation_ceremony_intent_id: ceremonyIntentId,
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

function authorityRow(status: "pending" | "satisfied") {
  return {
    intent_id: intentId,
    attempt_requirement_kind: "human_identity",
    attempt_generation: "1",
    attempt_requirement_hash: HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
    attempt_provider_id: VERY_OAUTH_PROVIDER_ID,
    attempt_provider_binding_hash: humanBindingHash,
    attempt_configuration_kind: "dynamic",
    attempt_configuration_ref: VERY_OAUTH_CONFIGURATION_REFERENCE,
    attempt_configuration_version: VERY_OAUTH_CONFIGURATION_VERSION,
    attempt_route_family: null,
    attempt_expires_at: expiresAt,
    requirement_status: status,
    requirement_generation: "1",
    requirement_hash: HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
    provider_id: VERY_OAUTH_PROVIDER_ID,
    provider_binding_hash: humanBindingHash,
    provider_configuration_kind: "dynamic",
    provider_configuration_ref: VERY_OAUTH_CONFIGURATION_REFERENCE,
    provider_configuration_version: VERY_OAUTH_CONFIGURATION_VERSION,
    current_ceremony_intent_id: ceremonyIntentId,
    route_family: null,
  };
}

function intentRow(input: {
  revision: number;
  status?: "verification_required" | "commit_ready";
  humanStatus: "pending" | "satisfied";
  namespaceStatus: "unmet" | "pending" | "satisfied";
}) {
  return {
    intent_id: intentId,
    actor_id: actorId,
    create_idempotency_key: "create-1",
    create_request_hash: "a".repeat(64),
    revision: input.revision,
    status: input.status ?? "verification_required",
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
    creation_contract_version: "route_v1",
    expired: false,
    human_requirement: {
      status: input.humanStatus,
      requirement_hash: HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
      provider_id: VERY_OAUTH_PROVIDER_ID,
      provider_binding_hash: humanBindingHash,
      generation: 1,
      current_ceremony_intent_id: ceremonyIntentId,
      satisfied_at: input.humanStatus === "satisfied" ? completedAt : null,
    },
    namespace_requirement: {
      status: input.namespaceStatus,
      requirement_hash: namespaceRequirementHash,
      provider_id: "hns.owner.v1",
      provider_binding_hash: "b".repeat(64),
      generation: input.namespaceStatus === "unmet" ? 0 : 1,
      current_ceremony_intent_id: input.namespaceStatus === "unmet" ? null : "namespace-ceremony-1",
      satisfied_at: input.namespaceStatus === "satisfied" ? completedAt : null,
    },
    human_started: true,
    namespace_started: false,
    committed_route_family: null,
    committed_route_root_label: null,
    committed_route_root_label_display: null,
    committed_route_path_segment: null,
    committed_route_href: null,
    committed_app_host_healthy: false,
  };
}

function requirementRows(namespaceStatus: "unmet" | "satisfied" = "unmet"): readonly Row[] {
  return [
    {
      requirement_kind: "human_identity",
      status: "satisfied",
      requirement_hash: HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
      provider_id: VERY_OAUTH_PROVIDER_ID,
      provider_binding_hash: humanBindingHash,
      provider_configuration_kind: "dynamic",
      provider_configuration_ref: VERY_OAUTH_CONFIGURATION_REFERENCE,
      provider_configuration_version: VERY_OAUTH_CONFIGURATION_VERSION,
      route_family: null,
      route_root_label: null,
      route_root_label_display: null,
      route_path_segment: null,
      generation: "1",
      current_ceremony_intent_id: ceremonyIntentId,
    },
    {
      requirement_kind: "namespace_ownership",
      status: namespaceStatus,
      requirement_hash: namespaceRequirementHash,
      provider_id: "hns.owner.v1",
      provider_binding_hash: "b".repeat(64),
      provider_configuration_kind: "managed",
      provider_configuration_ref: "hns-owner-test",
      provider_configuration_version: "1",
      route_family: "hns",
      route_root_label: "jazleeuw",
      route_root_label_display: "jazleeuw",
      route_path_segment: "app.jazleeuw",
      generation: namespaceStatus === "satisfied" ? "1" : "0",
      current_ceremony_intent_id: namespaceStatus === "satisfied" ? "namespace-ceremony-1" : null,
    },
  ];
}

function transactionWith(
  responses: Readonly<Record<string, Response>>,
  statements: ControlPlaneStatement[],
): ControlPlaneTransaction {
  const positions = new Map<string, number>();
  return {
    execute: <ResultRow>(statement: ControlPlaneStatement) => {
      statements.push(statement);
      const configured = responses[statement.label];
      if (configured === undefined) throw new Error(`unexpected statement: ${statement.label}`);
      const sequence = Array.isArray(configured) ? configured : [configured];
      const position = positions.get(statement.label) ?? 0;
      const response = sequence[Math.min(position, sequence.length - 1)];
      positions.set(statement.label, position + 1);
      if (response === undefined) throw new Error(`missing response: ${statement.label}`);
      return Effect.succeed(response as ControlPlaneResult<ResultRow>);
    },
  };
}

describe("community creation verification settlement", () => {
  test("satisfies human identity and exposes the reserved namespace ceremony", async () => {
    const statements: ControlPlaneStatement[] = [];
    const transaction = transactionWith(
      {
        "community.creation.verification.lock-session": { rows: [sessionRow()], rowCount: 1 },
        "community.creation.verification.lock-authority": {
          rows: [authorityRow("pending")],
          rowCount: 1,
        },
        "community.creation.get.lock-intent": [
          {
            rows: [intentRow({ revision: 1, humanStatus: "pending", namespaceStatus: "unmet" })],
            rowCount: 1,
          },
          {
            rows: [
              intentRow({ revision: 2, humanStatus: "satisfied", namespaceStatus: "pending" }),
            ],
            rowCount: 1,
          },
        ],
        "community.creation.verification.validate-evidence": {
          rows: [{ evidence_valid: true }],
          rowCount: 1,
        },
        "community.creation.commit.validate-evidence": {
          rows: [
            {
              evidence_valid: true,
              evidence_receipt_id: "receipt-1",
              evidence_digest: "c".repeat(64),
              subject_key_id: "subject-1",
              subject_digest: "d".repeat(64),
              receipt_expires_at: null,
              assertion_expires_at: null,
            },
          ],
          rowCount: 1,
        },
        "community.creation.verification.insert-result": { rows: [], rowCount: 1 },
        "community.creation.verification.satisfy-human-requirement": { rows: [], rowCount: 1 },
        "community.creation.get.lock-requirements": { rows: requirementRows(), rowCount: 2 },
        "community.creation.get.reserve-ceremony": { rows: [], rowCount: 1 },
        "community.creation.get.advance-requirement": { rows: [], rowCount: 1 },
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
    expect(statements.map((statement) => statement.label)).toContain(
      "community.creation.verification.insert-result",
    );
    expect(statements.at(-1)?.values.slice(0, 4)).toEqual([intentId, 2, actorId, "verification"]);
  });

  test("does not advance when the Very evidence is not authoritative", async () => {
    const statements: ControlPlaneStatement[] = [];
    const transaction = transactionWith(
      {
        "community.creation.verification.lock-session": { rows: [sessionRow()], rowCount: 1 },
        "community.creation.verification.lock-authority": {
          rows: [authorityRow("pending")],
          rowCount: 1,
        },
        "community.creation.get.lock-intent": {
          rows: [intentRow({ revision: 1, humanStatus: "pending", namespaceStatus: "unmet" })],
          rowCount: 1,
        },
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
      "community.creation.verification.insert-result",
    );
  });

  test("replays an exact human completion after the parent becomes commit-ready", async () => {
    const statements: ControlPlaneStatement[] = [];
    const transaction = transactionWith(
      {
        "community.creation.verification.lock-session": { rows: [sessionRow()], rowCount: 1 },
        "community.creation.verification.lock-authority": [
          { rows: [authorityRow("pending")], rowCount: 1 },
          { rows: [authorityRow("satisfied")], rowCount: 1 },
        ],
        "community.creation.get.lock-intent": [
          {
            rows: [
              intentRow({ revision: 1, humanStatus: "pending", namespaceStatus: "satisfied" }),
            ],
            rowCount: 1,
          },
          {
            rows: [
              intentRow({
                revision: 2,
                status: "commit_ready",
                humanStatus: "satisfied",
                namespaceStatus: "satisfied",
              }),
            ],
            rowCount: 1,
          },
        ],
        "community.creation.verification.validate-evidence": {
          rows: [{ evidence_valid: true }],
          rowCount: 1,
        },
        "community.creation.commit.validate-evidence": {
          rows: [
            {
              evidence_valid: true,
              evidence_receipt_id: "receipt-1",
              evidence_digest: "c".repeat(64),
              subject_key_id: "subject-1",
              subject_digest: "d".repeat(64),
              receipt_expires_at: null,
              assertion_expires_at: null,
            },
          ],
          rowCount: 1,
        },
        "community.creation.verification.insert-result": { rows: [], rowCount: 1 },
        "community.creation.verification.satisfy-human-requirement": { rows: [], rowCount: 1 },
        "community.creation.get.lock-requirements": {
          rows: requirementRows("satisfied"),
          rowCount: 2,
        },
        "community.creation.verification.persist-intent": { rows: [], rowCount: 1 },
        "community.creation.verification.insert-revision": { rows: [], rowCount: 1 },
        "community.creation.verification.load-result-replay": {
          rows: [
            {
              proof_session_id: proofSessionId,
              callback_idempotency_key: "completion-1",
              callback_request_hash: resultHash,
              outcome_status: "satisfied",
              result_hash: resultHash,
              terminal_at: completedAt,
              satisfied_at: completedAt,
            },
          ],
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
    ).resolves.toEqual({ kind: "advanced", intent_id: intentId, revision: 2 });

    await expect(
      Effect.runPromise(
        advanceCommunityCreationVerificationInTransaction(transaction, {
          actor_id: actorId,
          proof_session_id: proofSessionId,
          result_hash: resultHash,
        }),
      ),
    ).resolves.toEqual({ kind: "already_ready", intent_id: intentId, revision: 2 });

    const labels = statements.map((statement) => statement.label);
    expect(
      labels.filter((label) => label === "community.creation.verification.insert-result"),
    ).toHaveLength(1);
    expect(
      labels.filter((label) => label === "community.creation.verification.insert-revision"),
    ).toHaveLength(1);
    expect(labels).toContain("community.creation.verification.load-result-replay");
  });

  test("makes exact completion replay settlement idempotent", async () => {
    const statements: ControlPlaneStatement[] = [];
    const transaction = transactionWith(
      {
        "community.creation.verification.lock-session": { rows: [sessionRow()], rowCount: 1 },
        "community.creation.verification.lock-authority": {
          rows: [authorityRow("satisfied")],
          rowCount: 1,
        },
        "community.creation.get.lock-intent": {
          rows: [intentRow({ revision: 2, humanStatus: "satisfied", namespaceStatus: "pending" })],
          rowCount: 1,
        },
        "community.creation.verification.load-result-replay": {
          rows: [
            {
              proof_session_id: proofSessionId,
              callback_idempotency_key: "completion-1",
              callback_request_hash: resultHash,
              outcome_status: "satisfied",
              result_hash: resultHash,
              terminal_at: completedAt,
              satisfied_at: completedAt,
            },
          ],
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
    expect(statements.map((statement) => statement.label)).not.toContain(
      "community.creation.verification.insert-result",
    );
  });
});
