import type { ControlPlaneError, ControlPlaneTransaction } from "@pirate/application";
import {
  COMMUNITY_GATE_COMPILER_VERSION,
  CURATED_AGE_18_POLICY,
  CURATED_HUMAN_MEMBERSHIP_POLICY,
  type CuratedAgeEvaluation,
  type CuratedHumanMembershipEvaluation,
  communityJoinActionPayloadHash,
  communityJoinIntentBindingHash,
  evaluateCuratedAge,
  evaluateCuratedHumanMembership,
  evaluateNationality,
  HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
  type NationalityEvaluation,
  type NationalityPolicy,
  NationalityPolicy as NationalityPolicySchema,
  VERY_WEB_CONFIGURATION_REFERENCE,
  VERY_WEB_CONFIGURATION_VERSION,
  VERY_WEB_ISSUER,
  VERY_WEB_METHOD,
  VERY_WEB_PROTOCOL_VERSION,
  VERY_WEB_PROVIDER_ID,
  VERY_WEB_RP_SCOPE,
} from "@pirate/domain";
import { CanonicalIsoInstant, type SubjectScope } from "@pirate/domain/verification";
import { Data, Effect, Option, Predicate, Schema } from "effect";

type Row = Readonly<Record<string, unknown>>;
type Json = Schema.Schema.Type<typeof Schema.Json>;
export type CommunityGateEvaluation = CuratedAgeEvaluation | CuratedHumanMembershipEvaluation;

const CANONICAL_HUMAN_COMPILED_PLAN = {
  compiler_version: COMMUNITY_GATE_COMPILER_VERSION,
  evaluator: CURATED_HUMAN_MEMBERSHIP_POLICY.policy_version_id,
  provider_binding: {
    provider_id: VERY_WEB_PROVIDER_ID,
    provider_configuration: {
      kind: "dynamic",
      reference: VERY_WEB_CONFIGURATION_REFERENCE,
      version: VERY_WEB_CONFIGURATION_VERSION,
    },
    method: VERY_WEB_METHOD,
    protocol_version: VERY_WEB_PROTOCOL_VERSION,
    scope: {
      kind: "named",
      scope_semantics: "issuer_rp_scope",
      issuer: VERY_WEB_ISSUER,
      rp_scope: VERY_WEB_RP_SCOPE,
    },
  },
} as const;
const VERY_WEB_EVIDENCE_KIND = "very.web.server-verified.v1" as const;

export class GatesV2CommunityDataInvalid extends Data.TaggedError("GatesV2CommunityDataInvalid")<{
  readonly source: "policy" | "evidence" | "clock";
}> {}

const stringField = (row: Row, name: string): string | null =>
  typeof row[name] === "string" ? row[name] : null;

const jsonValue = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

const jsonObject = (value: unknown): Record<string, unknown> => {
  const parsed = jsonValue(value);
  return Predicate.isObject(parsed) ? parsed : {};
};

const canonicalInstant = (value: unknown): string | null => {
  const instant =
    value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (instant === null || !Number.isFinite(instant.getTime())) return null;
  const candidate = instant.toISOString();
  if (candidate === null) return null;
  const decoded = Schema.decodeUnknownOption(CanonicalIsoInstant)(candidate);
  return Option.isSome(decoded) ? decoded.value : null;
};

const optionalInstant = (value: unknown): string | undefined => {
  if (value === null || value === undefined) return undefined;
  return canonicalInstant(value) ?? undefined;
};

const scopeFromRow = (row: Row): SubjectScope | null => {
  const kind = stringField(row, "scope_kind");
  const issuer = stringField(row, "issuer");
  if (kind === null || issuer === null) return null;
  if (kind === "none") return { kind: "none", issuer };
  const rpScope = stringField(row, "issuer_rp_scope");
  if (rpScope === null) return null;
  if (kind === "issuer_rp_scope") {
    return {
      kind: "named",
      scope_semantics: "issuer_rp_scope",
      issuer,
      rp_scope: rpScope,
    };
  }
  if (kind === "issuer_rp_action_scope") {
    const actionScope = stringField(row, "issuer_rp_action_scope");
    if (actionScope === null) return null;
    return {
      kind: "named",
      scope_semantics: "issuer_rp_action_scope",
      issuer,
      rp_scope: rpScope,
      action_scope: actionScope,
    };
  }
  return null;
};

const policyFromRow = (row: Row): unknown | null => {
  const policyVersionId = stringField(row, "policy_version_id");
  const policyKey = stringField(row, "policy_key");
  const policyHash = stringField(row, "policy_hash");
  const revision = row.revision;
  if (
    policyVersionId === null ||
    policyKey === null ||
    policyHash === null ||
    !(typeof revision === "number" || typeof revision === "string")
  ) {
    return null;
  }
  const parsedRevision = typeof revision === "number" ? revision : Number(revision);
  if (!Number.isSafeInteger(parsedRevision)) return null;
  const stored = jsonValue(row.policy);
  if (!Predicate.isObject(stored)) return null;

  for (const [key, expected] of [
    ["policy_version_id", policyVersionId],
    ["policy_key", policyKey],
    ["policy_hash", policyHash],
    ["policy_revision", parsedRevision],
  ] as const) {
    if (key in stored && stored[key] !== expected) return null;
  }

  return {
    ...stored,
    policy_version_id: policyVersionId,
    policy_key: policyKey,
    policy_hash: policyHash,
    policy_revision: parsedRevision,
  };
};

type EvidenceRow = Row & {
  readonly proof_session_id?: unknown;
  readonly assertion_id?: unknown;
  readonly evidence_receipt_id?: unknown;
  readonly binding_group_id?: unknown;
};

const emptyEvidenceBundle = () => ({
  id: "gates-v2-no-evidence",
  proof_session_id: "gates-v2-no-proof-session",
  receipts: [],
  subject_keys: [],
  binding_groups: [],
  assertions: [],
});

const evidenceBundleFromRows = (rows: readonly EvidenceRow[]): unknown => {
  const firstSessionId = rows
    .map((candidate) => stringField(candidate, "proof_session_id"))
    .find((candidate): candidate is string => candidate !== null);
  if (firstSessionId === undefined) return emptyEvidenceBundle();

  const sessionRows = rows.filter(
    (candidate) => stringField(candidate, "proof_session_id") === firstSessionId,
  );
  const receipts = new Map<string, Record<string, unknown>>();
  const subjects = new Map<string, Record<string, unknown>>();
  const bindings = new Map<string, Record<string, unknown>>();
  const assertions: Record<string, unknown>[] = [];

  for (const candidate of sessionRows) {
    const receiptId = stringField(candidate, "evidence_receipt_id");
    const receiptScope = scopeFromRow(candidate);
    const receiptObservedAt = canonicalInstant(candidate.receipt_observed_at);
    const receiptExpiresAt = optionalInstant(candidate.receipt_expires_at);
    const receiptConfigurationKind = stringField(candidate, "receipt_provider_configuration_kind");
    const receiptConfigurationRef = stringField(candidate, "receipt_provider_configuration_ref");
    const receiptConfigurationVersion = stringField(
      candidate,
      "receipt_provider_configuration_version",
    );
    if (
      receiptId !== null &&
      receiptScope !== null &&
      receiptObservedAt !== null &&
      receiptConfigurationKind !== null &&
      receiptConfigurationRef !== null &&
      receiptConfigurationVersion !== null
    ) {
      receipts.set(receiptId, {
        id: receiptId,
        proof_session_id: firstSessionId,
        provider_id: stringField(candidate, "provider_id") ?? "",
        issuer: stringField(candidate, "issuer") ?? "",
        method: stringField(candidate, "receipt_method") ?? "",
        scope: receiptScope,
        provider_configuration: {
          kind: receiptConfigurationKind,
          reference: receiptConfigurationRef,
          version: receiptConfigurationVersion,
        },
        protocol_version: stringField(candidate, "receipt_protocol_version") ?? "",
        environment: stringField(candidate, "receipt_environment") ?? "",
        provenance_kind: "proof_session",
        evidence_kind: stringField(candidate, "evidence_kind") ?? "",
        evidence_hash: stringField(candidate, "evidence_hash") ?? "",
        metadata: jsonObject(candidate.receipt_metadata),
        observed_at: receiptObservedAt,
        ...(receiptExpiresAt === undefined ? {} : { expires_at: receiptExpiresAt }),
        ...(stringField(candidate, "receipt_subject_key_id") === null
          ? {}
          : { subject_key_id: stringField(candidate, "receipt_subject_key_id") }),
      });
    }

    const subjectKeyId = stringField(candidate, "subject_key_id");
    const subjectScope = scopeFromRow({
      scope_kind: candidate.subject_scope_kind,
      issuer: candidate.subject_issuer,
      issuer_rp_scope: candidate.subject_issuer_rp_scope,
      issuer_rp_action_scope: candidate.subject_issuer_rp_action_scope,
    });
    if (subjectKeyId !== null && subjectScope?.kind === "named") {
      subjects.set(subjectKeyId, {
        id: subjectKeyId,
        issuer: stringField(candidate, "subject_issuer") ?? "",
        method: stringField(candidate, "subject_method") ?? "",
        scope: subjectScope,
        subject_digest: stringField(candidate, "subject_digest") ?? "",
      });
    }

    const bindingGroupId = stringField(candidate, "binding_group_id");
    const bindingMode = stringField(candidate, "binding_mode");
    if (bindingGroupId !== null && bindingMode === "same_subject" && subjectKeyId !== null) {
      bindings.set(bindingGroupId, {
        id: bindingGroupId,
        kind: "same_subject",
        subject_key_id: subjectKeyId,
      });
    } else if (bindingGroupId !== null && bindingMode === "same_receipt" && receiptId !== null) {
      bindings.set(bindingGroupId, {
        id: bindingGroupId,
        kind: "same_receipt",
        evidence_receipt_id: receiptId,
      });
    }

    const assertionId = stringField(candidate, "assertion_id");
    const assertionObservedAt = canonicalInstant(candidate.assertion_observed_at);
    if (assertionId !== null && assertionObservedAt !== null) {
      assertions.push({
        id: assertionId,
        ...(stringField(candidate, "assertion_subject_key_id") === null
          ? {}
          : { subject_key_id: stringField(candidate, "assertion_subject_key_id") }),
        evidence_receipt_id: receiptId ?? "",
        assurance: stringField(candidate, "assurance") ?? "",
        binding_group_id: bindingGroupId ?? "",
        observed_at: assertionObservedAt,
        ...(optionalInstant(candidate.assertion_expires_at) === undefined
          ? {}
          : { expires_at: optionalInstant(candidate.assertion_expires_at) }),
        claim_id: stringField(candidate, "claim_id") ?? "",
        value: jsonValue(candidate.assertion_value),
      });
    }
  }

  return {
    id: `gates-v2-evidence-${firstSessionId}`,
    proof_session_id: firstSessionId,
    receipts: [...receipts.values()],
    subject_keys: [...subjects.values()],
    binding_groups: [...bindings.values()],
    assertions,
  };
};

const loadPolicy = (transaction: ControlPlaneTransaction, communityId: string) =>
  Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "community.gates.policy.load",
      text: `SELECT p.policy_version_id, p.policy_key, p.revision, p.policy_hash, p.policy
                FROM community_policy_current AS current_policy
                JOIN policy_versions AS p
                  ON p.community_id = current_policy.community_id
                 AND p.policy_key = current_policy.policy_key
                 AND p.policy_version_id = current_policy.policy_version_id
               WHERE current_policy.community_id = $1
                 AND current_policy.policy_key = $2
                 AND current_policy.policy_version_id = $3
                 AND p.policy_hash = $4`,
      values: [
        communityId,
        CURATED_AGE_18_POLICY.policy_key,
        CURATED_AGE_18_POLICY.policy_version_id,
        CURATED_AGE_18_POLICY.policy_hash,
      ],
      readonly: true,
    });
    if (result.rows.length !== 1) {
      return yield* Effect.fail(new GatesV2CommunityDataInvalid({ source: "policy" }));
    }
    const policy = policyFromRow(result.rows[0] ?? {});
    if (policy === null) {
      return yield* Effect.fail(new GatesV2CommunityDataInvalid({ source: "policy" }));
    }
    return policy;
  });

const loadHumanPolicy = (transaction: ControlPlaneTransaction, communityId: string) =>
  Effect.gen(function* () {
    // Policy versions and their current pointer are control-plane metadata.
    // The runtime may read but cannot update them, so row-locking this join
    // would reject the normal eligibility path. Mutable ceremony evidence is
    // locked separately after a passing evaluation. Any future writer that
    // advances the current-policy pointer must first lock the community row.
    const result = yield* transaction.execute<Row>({
      label: "community.gates.human-policy.load",
      text: `SELECT p.policy_version_id, p.policy_key, p.revision, p.policy_hash, p.policy
                FROM community_policy_current AS current_policy
                JOIN policy_versions AS p
                  ON p.community_id = current_policy.community_id
                 AND p.policy_key = current_policy.policy_key
                 AND p.policy_version_id = current_policy.policy_version_id
                JOIN community_policy_provider_bindings AS binding
                  ON binding.community_id = p.community_id
                 AND binding.policy_key = p.policy_key
                 AND binding.policy_version_id = p.policy_version_id
               WHERE current_policy.community_id = $1
                 AND current_policy.policy_key = $2
                 AND current_policy.policy_version_id = $3
                 AND p.revision = $4
                 AND p.policy_hash = $5
                 AND p.policy = $6::jsonb
                 AND p.compiled_plan = $7::jsonb
                 AND p.compiler_version = $8
                 AND p.policy_purpose = 'access'
                 AND binding.verification_requirement_hash = $9
                 AND binding.provider_id = $10
                 AND binding.provider_configuration_kind = 'dynamic'
                 AND binding.provider_configuration_ref = $11
                 AND binding.provider_configuration_version = $12
                 AND binding.method = $13
                 AND binding.protocol_version = $14
                 AND binding.issuer = $15
                 AND binding.scope_kind = 'issuer_rp_scope'
                 AND binding.issuer_rp_scope = $16
                 AND binding.issuer_rp_action_scope IS NULL
                 AND binding.request_mode = 'dynamic'
                 AND binding.evaluator_id = $3`,
      values: [
        communityId,
        CURATED_HUMAN_MEMBERSHIP_POLICY.policy_key,
        CURATED_HUMAN_MEMBERSHIP_POLICY.policy_version_id,
        CURATED_HUMAN_MEMBERSHIP_POLICY.policy_revision,
        CURATED_HUMAN_MEMBERSHIP_POLICY.policy_hash,
        JSON.stringify(CURATED_HUMAN_MEMBERSHIP_POLICY),
        JSON.stringify(CANONICAL_HUMAN_COMPILED_PLAN),
        COMMUNITY_GATE_COMPILER_VERSION,
        HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
        VERY_WEB_PROVIDER_ID,
        VERY_WEB_CONFIGURATION_REFERENCE,
        VERY_WEB_CONFIGURATION_VERSION,
        VERY_WEB_METHOD,
        VERY_WEB_PROTOCOL_VERSION,
        VERY_WEB_ISSUER,
        VERY_WEB_RP_SCOPE,
      ],
      readonly: true,
    });
    if (result.rows.length !== 1) {
      return yield* Effect.fail(new GatesV2CommunityDataInvalid({ source: "policy" }));
    }
    const policy = policyFromRow(result.rows[0] ?? {});
    if (policy === null) {
      return yield* Effect.fail(new GatesV2CommunityDataInvalid({ source: "policy" }));
    }
    return policy;
  });

const loadEvidence = (transaction: ControlPlaneTransaction, userId: string) =>
  Effect.gen(function* () {
    const result = yield* transaction.execute<EvidenceRow>({
      label: "community.gates.evidence.load",
      text: `SELECT ps.proof_session_id,
                    a.assertion_id,
                    a.subject_key_id AS assertion_subject_key_id,
                    a.claim_id,
                    a.assertion_value,
                    a.assurance,
                    a.observed_at AS assertion_observed_at,
                    a.expires_at AS assertion_expires_at,
                    b.binding_group_id,
                    b.binding_mode,
                    r.evidence_receipt_id,
                    r.provider_id,
                    r.issuer AS issuer,
                    r.method AS receipt_method,
                    r.scope_kind,
                    r.issuer_rp_scope,
                    r.issuer_rp_action_scope,
                    r.provider_configuration_kind AS receipt_provider_configuration_kind,
                    r.provider_configuration_ref AS receipt_provider_configuration_ref,
                    r.provider_configuration_version AS receipt_provider_configuration_version,
                    r.protocol_version AS receipt_protocol_version,
                    r.environment AS receipt_environment,
                    r.evidence_kind,
                    r.evidence_hash,
                    r.receipt_metadata,
                    r.observed_at AS receipt_observed_at,
                    r.expires_at AS receipt_expires_at,
                    r.subject_key_id AS receipt_subject_key_id,
                    sk.subject_key_id,
                    sk.issuer AS subject_issuer,
                    sk.method AS subject_method,
                    sk.scope_kind AS subject_scope_kind,
                    sk.issuer_rp_scope AS subject_issuer_rp_scope,
                    sk.issuer_rp_action_scope AS subject_issuer_rp_action_scope,
                    sk.subject_digest
               FROM proof_sessions AS ps
               JOIN assertions AS a
                 ON a.user_id = ps.actor_id
                AND a.evidence_receipt_id IN (
                      SELECT evidence_receipt_id
                        FROM evidence_receipts
                       WHERE proof_session_id = ps.proof_session_id
                         AND user_id = ps.actor_id
                    )
               JOIN assertion_bindings AS b
                 ON b.binding_group_id = a.binding_group_id
                AND b.user_id = a.user_id
               JOIN evidence_receipts AS r
                 ON r.evidence_receipt_id = a.evidence_receipt_id
                AND r.proof_session_id = ps.proof_session_id
                AND r.user_id = ps.actor_id
               LEFT JOIN subject_keys AS sk
                 ON sk.subject_key_id = a.subject_key_id
              WHERE ps.actor_id = $1
                AND ps.status = 'completed'
           ORDER BY ps.completed_at DESC, ps.proof_session_id, a.created_at, a.assertion_id`,
      values: [userId],
      readonly: true,
    });
    return evidenceBundleFromRows(result.rows);
  });

const loadHumanEvidence = (
  transaction: ControlPlaneTransaction,
  input: Readonly<{
    readonly communityId: string;
    readonly userId: string;
  }>,
) =>
  Effect.gen(function* () {
    const actionPayloadHash = communityJoinActionPayloadHash(input.communityId);
    const intentBindingHash = communityJoinIntentBindingHash({
      actorId: input.userId,
      communityId: input.communityId,
    });
    const result = yield* transaction.execute<EvidenceRow>({
      label: "community.gates.human-evidence.load",
      text: `SELECT ps.proof_session_id,
                    a.assertion_id,
                    a.subject_key_id AS assertion_subject_key_id,
                    a.claim_id,
                    a.assertion_value,
                    a.assurance,
                    a.observed_at AS assertion_observed_at,
                    a.expires_at AS assertion_expires_at,
                    b.binding_group_id,
                    b.binding_mode,
                    r.evidence_receipt_id,
                    r.provider_id,
                    r.issuer,
                    r.method AS receipt_method,
                    r.scope_kind,
                    r.issuer_rp_scope,
                    r.issuer_rp_action_scope,
                    r.provider_configuration_kind AS receipt_provider_configuration_kind,
                    r.provider_configuration_ref AS receipt_provider_configuration_ref,
                    r.provider_configuration_version AS receipt_provider_configuration_version,
                    r.protocol_version AS receipt_protocol_version,
                    r.environment AS receipt_environment,
                    r.evidence_kind,
                    r.evidence_hash,
                    r.receipt_metadata,
                    r.observed_at AS receipt_observed_at,
                    r.expires_at AS receipt_expires_at,
                    r.subject_key_id AS receipt_subject_key_id,
                    sk.subject_key_id,
                    sk.issuer AS subject_issuer,
                    sk.method AS subject_method,
                    sk.scope_kind AS subject_scope_kind,
                    sk.issuer_rp_scope AS subject_issuer_rp_scope,
                    sk.issuer_rp_action_scope AS subject_issuer_rp_action_scope,
                    sk.subject_digest
               FROM action_intents AS intent
               JOIN proof_sessions AS ps
                 ON ps.actor_id = intent.user_id
                AND ps.intent_id = intent.action_intent_id
                AND ps.status = 'completed'
                AND ps.completed_at = ps.terminal_at
                AND ps.provider_id = $3
                AND ps.provider_configuration_kind = 'dynamic'
                AND ps.provider_configuration_ref = $4
                AND ps.provider_configuration_version = $5
                AND ps.method = $6
                AND ps.protocol_version = $7
                AND ps.issuer = $8
                AND ps.scope_kind = 'issuer_rp_scope'
                AND ps.issuer_rp_scope = $9
                AND ps.issuer_rp_action_scope IS NULL
                AND ps.request_mode = 'dynamic'
                AND ps.requested_requirements = $10::jsonb
                AND ps.requested_claim_ids = $11::jsonb
                AND ps.subject_binding_intent = 'establish'
               JOIN evidence_receipts AS r
                 ON r.proof_session_id = ps.proof_session_id
                AND r.user_id = ps.actor_id
                AND r.provider_id = ps.provider_id
                AND r.issuer = ps.issuer
                AND r.method = ps.method
                AND r.scope_kind = ps.scope_kind
                AND r.issuer_rp_scope = ps.issuer_rp_scope
                AND r.issuer_rp_action_scope IS NOT DISTINCT FROM ps.issuer_rp_action_scope
                AND r.protocol_version = ps.protocol_version
                AND r.environment = ps.environment
                AND r.provider_configuration_kind = ps.provider_configuration_kind
                AND r.provider_configuration_ref = ps.provider_configuration_ref
                AND r.provider_configuration_version = ps.provider_configuration_version
                AND r.provenance_kind = 'proof_session'
                AND r.evidence_kind = $12
                AND r.observed_at <= ps.terminal_at
               JOIN assertions AS a
                 ON a.user_id = ps.actor_id
                AND a.evidence_receipt_id = r.evidence_receipt_id
                AND a.subject_key_id = r.subject_key_id
                AND a.observed_at <= ps.terminal_at
               JOIN assertion_bindings AS b
                 ON b.binding_group_id = a.binding_group_id
                AND b.user_id = a.user_id
                AND b.binding_mode = 'same_subject'
                AND b.subject_key_id = a.subject_key_id
               JOIN subject_keys AS sk
                 ON sk.subject_key_id = a.subject_key_id
                AND sk.issuer = r.issuer
                AND sk.method = r.method
                AND sk.scope_kind = r.scope_kind
                AND sk.issuer_rp_scope = r.issuer_rp_scope
                AND sk.issuer_rp_action_scope IS NOT DISTINCT FROM r.issuer_rp_action_scope
               JOIN active_subject_key_bindings AS active_binding
                 ON active_binding.subject_key_id = sk.subject_key_id
                AND active_binding.user_id = ps.actor_id
                AND active_binding.binding_event_id = b.subject_binding_event_id
                AND active_binding.binding_epoch = b.subject_binding_epoch
              WHERE intent.user_id = $1
                AND intent.community_id = $2
                AND intent.action_kind = 'community_join'
                AND intent.action_scope = intent.community_id
                AND intent.status = 'open'
                AND intent.action_payload_hash = $13
                AND intent.intent_binding_hash = $14
           ORDER BY ps.completed_at DESC, ps.proof_session_id, a.created_at, a.assertion_id
              `,
      values: [
        input.userId,
        input.communityId,
        VERY_WEB_PROVIDER_ID,
        VERY_WEB_CONFIGURATION_REFERENCE,
        VERY_WEB_CONFIGURATION_VERSION,
        VERY_WEB_METHOD,
        VERY_WEB_PROTOCOL_VERSION,
        VERY_WEB_ISSUER,
        VERY_WEB_RP_SCOPE,
        JSON.stringify([
          { claim_id: "credential.subject_unique" },
          { claim_id: "human.personhood" },
        ]),
        JSON.stringify(["credential.subject_unique", "human.personhood"]),
        VERY_WEB_EVIDENCE_KIND,
        actionPayloadHash,
        intentBindingHash,
      ],
      readonly: true,
    });
    return {
      bundle: evidenceBundleFromRows(result.rows),
      proofSessionId:
        result.rows
          .map((candidate) => stringField(candidate, "proof_session_id"))
          .find((candidate): candidate is string => candidate !== null) ?? null,
    } as const;
  });

const lockPassingAccountEvidence = (
  transaction: ControlPlaneTransaction,
  input: Readonly<{
    readonly proofSessionId: string;
    readonly subjectKeyId: string;
    readonly userId: string;
  }>,
) =>
  Effect.gen(function* () {
    const session = yield* transaction.execute<Row>({
      label: "community.gates.human-evidence.lock-session",
      text: `SELECT proof_session_id, actor_id, status
               FROM proof_sessions
              WHERE proof_session_id = $1 AND actor_id = $2
              FOR UPDATE`,
      values: [input.proofSessionId, input.userId],
      readonly: false,
    });
    if (
      session.rows.length !== 1 ||
      session.rows[0]?.proof_session_id !== input.proofSessionId ||
      session.rows[0]?.actor_id !== input.userId ||
      session.rows[0]?.status !== "completed"
    ) {
      return yield* Effect.fail(new GatesV2CommunityDataInvalid({ source: "evidence" }));
    }

    const subject = yield* transaction.execute<Row>({
      label: "community.gates.human-evidence.lock-subject",
      text: `SELECT subject_key_id
               FROM subject_keys
              WHERE subject_key_id = $1
              FOR UPDATE`,
      values: [input.subjectKeyId],
      readonly: false,
    });
    if (subject.rows.length !== 1 || subject.rows[0]?.subject_key_id !== input.subjectKeyId) {
      return yield* Effect.fail(new GatesV2CommunityDataInvalid({ source: "evidence" }));
    }

    const activeBinding = yield* transaction.execute<Row>({
      label: "community.gates.human-evidence.lock-active-binding",
      text: `SELECT subject_key_id, user_id
               FROM active_subject_key_bindings
              WHERE subject_key_id = $1 AND user_id = $2
              FOR UPDATE`,
      values: [input.subjectKeyId, input.userId],
      readonly: false,
    });
    if (
      activeBinding.rows.length !== 1 ||
      activeBinding.rows[0]?.subject_key_id !== input.subjectKeyId ||
      activeBinding.rows[0]?.user_id !== input.userId
    ) {
      return yield* Effect.fail(new GatesV2CommunityDataInvalid({ source: "evidence" }));
    }
  });

const loadDatabaseNow = (transaction: ControlPlaneTransaction) =>
  Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "community.gates.database-clock",
      text: "SELECT clock_timestamp() AS database_now",
      values: [],
      readonly: true,
    });
    if (result.rows.length !== 1) {
      return yield* Effect.fail(new GatesV2CommunityDataInvalid({ source: "clock" }));
    }
    const now = canonicalInstant(result.rows[0]?.database_now);
    if (now === null) {
      return yield* Effect.fail(new GatesV2CommunityDataInvalid({ source: "clock" }));
    }
    return now;
  });

const nonNegativeIntegerString = (value: unknown): string | null => {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  }
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return null;
  return value;
};

const nationalityRevalidation = (value: unknown): "accepted" | "revoked" | "indeterminate" => {
  if (value === null || value === undefined || value === "accepted" || value === "stale") {
    return value === "stale" ? "revoked" : "accepted";
  }
  if (value === "indeterminate") return "indeterminate";
  return "revoked";
};

/**
 * Builds the evaluator candidate from one joined row. The row is server-owned
 * snapshot data; nothing here trusts client-supplied facts, and a structurally
 * incomplete row is rejected rather than defaulted into a weaker shape.
 */
const nationalityCandidateFromRow = (row: Row) => {
  const sessionId = stringField(row, "proof_session_id");
  const sessionActorId = stringField(row, "session_actor_id");
  const sessionIntentId = stringField(row, "session_intent_id");
  const sessionRequestHash = stringField(row, "session_request_hash");
  const sessionProviderId = stringField(row, "session_provider_id");
  const sessionConfigurationKind = stringField(row, "session_provider_configuration_kind");
  const sessionConfigurationRef = stringField(row, "session_provider_configuration_ref");
  const sessionConfigurationVersion = stringField(row, "session_provider_configuration_version");
  const sessionMethod = stringField(row, "session_method");
  const sessionScope = scopeFromRow({
    scope_kind: row.session_scope_kind,
    issuer: row.session_issuer,
    issuer_rp_scope: row.session_issuer_rp_scope,
    issuer_rp_action_scope: row.session_issuer_rp_action_scope,
  });
  const sessionRequestMode = stringField(row, "session_request_mode");
  const sessionRequestedRequirements = jsonValue(row.session_requested_requirements);
  const sessionRequestedClaimIds = jsonValue(row.session_requested_claim_ids);
  const sessionSubjectBindingIntent = stringField(row, "session_subject_binding_intent");
  const sessionProtocolVersion = stringField(row, "session_protocol_version");
  const sessionEnvironment = stringField(row, "session_environment");
  const sessionStatus = stringField(row, "session_status");
  const sessionStartedAt = canonicalInstant(row.session_started_at);
  const sessionExpiresAt = canonicalInstant(row.session_expires_at);
  const sessionCompletedAt = optionalInstant(row.session_completed_at);
  const sessionUpstreamRef = stringField(row, "session_upstream_session_ref");

  const receiptId = stringField(row, "evidence_receipt_id");
  const receiptAccountId = stringField(row, "receipt_account_id");
  const receiptProviderId = stringField(row, "receipt_provider_id");
  const receiptIssuer = stringField(row, "receipt_issuer");
  const receiptMethod = stringField(row, "receipt_method");
  const receiptScope = scopeFromRow({
    scope_kind: row.receipt_scope_kind,
    issuer: row.receipt_issuer,
    issuer_rp_scope: row.receipt_issuer_rp_scope,
    issuer_rp_action_scope: row.receipt_issuer_rp_action_scope,
  });
  const receiptConfigurationKind = stringField(row, "receipt_provider_configuration_kind");
  const receiptConfigurationRef = stringField(row, "receipt_provider_configuration_ref");
  const receiptConfigurationVersion = stringField(row, "receipt_provider_configuration_version");
  const receiptProtocolVersion = stringField(row, "receipt_protocol_version");
  const receiptEnvironment = stringField(row, "receipt_environment");
  const receiptEvidenceKind = stringField(row, "evidence_kind");
  const receiptEvidenceHash = stringField(row, "evidence_hash");
  const receiptObservedAt = canonicalInstant(row.receipt_observed_at);
  const receiptExpiresAt = optionalInstant(row.receipt_expires_at);
  const receiptSubjectKeyId = stringField(row, "receipt_subject_key_id");

  const assertionId = stringField(row, "assertion_id");
  const assertionAccountId = stringField(row, "assertion_account_id");
  const assertionSubjectKeyId = stringField(row, "assertion_subject_key_id");
  const assertionClaimId = stringField(row, "claim_id");
  const assertionAssurance = stringField(row, "assurance");
  const assertionObservedAt = canonicalInstant(row.assertion_observed_at);
  const assertionExpiresAt = optionalInstant(row.assertion_expires_at);
  const bindingGroupId = stringField(row, "binding_group_id");

  const subjectIssuer = stringField(row, "subject_issuer");
  const subjectMethod = stringField(row, "subject_method");
  const subjectScope = scopeFromRow({
    scope_kind: row.subject_scope_kind,
    issuer: row.subject_issuer,
    issuer_rp_scope: row.subject_issuer_rp_scope,
    issuer_rp_action_scope: row.subject_issuer_rp_action_scope,
  });
  const subjectDigest = stringField(row, "subject_digest");

  const recordedEpoch = nonNegativeIntegerString(row.recorded_binding_epoch);
  const recordedEventId = stringField(row, "recorded_binding_event_id");
  const activeAccountId = stringField(row, "active_binding_account_id");
  const activeEpoch = nonNegativeIntegerString(row.active_binding_epoch);
  const activeEventId = stringField(row, "active_binding_event_id");

  if (
    sessionId === null ||
    sessionActorId === null ||
    sessionIntentId === null ||
    sessionRequestHash === null ||
    sessionProviderId === null ||
    sessionConfigurationKind === null ||
    sessionConfigurationRef === null ||
    sessionConfigurationVersion === null ||
    sessionMethod === null ||
    sessionScope === null ||
    sessionRequestMode === null ||
    !Array.isArray(sessionRequestedRequirements) ||
    !Array.isArray(sessionRequestedClaimIds) ||
    sessionSubjectBindingIntent === null ||
    sessionProtocolVersion === null ||
    sessionEnvironment === null ||
    sessionStatus === null ||
    sessionStartedAt === null ||
    sessionExpiresAt === null ||
    sessionCompletedAt === undefined ||
    receiptId === null ||
    receiptAccountId === null ||
    receiptProviderId === null ||
    receiptIssuer === null ||
    receiptMethod === null ||
    receiptScope === null ||
    receiptConfigurationKind === null ||
    receiptConfigurationRef === null ||
    receiptConfigurationVersion === null ||
    receiptProtocolVersion === null ||
    receiptEnvironment === null ||
    receiptEvidenceKind === null ||
    receiptEvidenceHash === null ||
    receiptObservedAt === null ||
    assertionId === null ||
    assertionAccountId === null ||
    assertionSubjectKeyId === null ||
    assertionClaimId === null ||
    assertionAssurance === null ||
    assertionObservedAt === null ||
    bindingGroupId === null ||
    subjectIssuer === null ||
    subjectMethod === null ||
    subjectScope?.kind !== "named" ||
    subjectDigest === null ||
    recordedEpoch === null ||
    recordedEventId === null ||
    activeAccountId === null ||
    activeEpoch === null ||
    activeEventId === null
  ) {
    return null;
  }

  return {
    proof_session: {
      id: sessionId,
      actor_id: sessionActorId,
      intent_id: sessionIntentId,
      request_hash: sessionRequestHash,
      provider_id: sessionProviderId,
      ...(sessionUpstreamRef === null ? {} : { upstream_session_ref: sessionUpstreamRef }),
      provider_configuration: {
        kind: sessionConfigurationKind,
        reference: sessionConfigurationRef,
        version: sessionConfigurationVersion,
      },
      method: sessionMethod,
      scope: sessionScope,
      request_mode: sessionRequestMode,
      requested_requirements: sessionRequestedRequirements,
      requested_claim_ids: sessionRequestedClaimIds,
      subject_binding_intent: sessionSubjectBindingIntent,
      protocol_version: sessionProtocolVersion,
      environment: sessionEnvironment,
      status: sessionStatus,
      started_at: sessionStartedAt,
      expires_at: sessionExpiresAt,
      completed_at: sessionCompletedAt,
    },
    receipt: {
      id: receiptId,
      proof_session_id: sessionId,
      provider_id: receiptProviderId,
      issuer: receiptIssuer,
      method: receiptMethod,
      scope: receiptScope,
      provider_configuration: {
        kind: receiptConfigurationKind,
        reference: receiptConfigurationRef,
        version: receiptConfigurationVersion,
      },
      protocol_version: receiptProtocolVersion,
      environment: receiptEnvironment,
      provenance_kind: "proof_session",
      evidence_kind: receiptEvidenceKind,
      evidence_hash: receiptEvidenceHash,
      metadata: jsonObject(row.receipt_metadata),
      observed_at: receiptObservedAt,
      ...(receiptExpiresAt === undefined ? {} : { expires_at: receiptExpiresAt }),
      subject_key_id: receiptSubjectKeyId ?? assertionSubjectKeyId,
    },
    assertion: {
      id: assertionId,
      subject_key_id: assertionSubjectKeyId,
      evidence_receipt_id: receiptId,
      assurance: assertionAssurance,
      binding_group_id: bindingGroupId,
      observed_at: assertionObservedAt,
      ...(assertionExpiresAt === undefined ? {} : { expires_at: assertionExpiresAt }),
      claim_id: assertionClaimId,
      value: jsonValue(row.assertion_value),
    },
    subject_key: {
      id: assertionSubjectKeyId,
      issuer: subjectIssuer,
      method: subjectMethod,
      scope: subjectScope,
      subject_digest: subjectDigest,
    },
    binding_group: {
      id: bindingGroupId,
      kind: "same_subject",
      subject_key_id: assertionSubjectKeyId,
    },
    receipt_account_id: receiptAccountId,
    assertion_account_id: assertionAccountId,
    recorded_binding: {
      account_id: assertionAccountId,
      subject_key_id: assertionSubjectKeyId,
      binding_epoch: recordedEpoch,
      binding_event_id: recordedEventId,
    },
    active_binding: {
      account_id: activeAccountId,
      subject_key_id: assertionSubjectKeyId,
      binding_epoch: activeEpoch,
      binding_event_id: activeEventId,
    },
    revalidation: nationalityRevalidation(row.revalidation_outcome),
  } as const;
};

type NationalityEvidenceInput = Readonly<{
  userId: string;
  policy: NationalityPolicy;
  /** A quote may reuse only its pinned winning provider. */
  providerId?: "self.pass" | "zkpassport";
  /** Enforcement holds proof, binding and revalidation locks through its grant transaction. */
  lockEvidence?: boolean;
}>;

const loadNationalityEvidence = (
  transaction: ControlPlaneTransaction,
  input: NationalityEvidenceInput & Readonly<{ receiptId?: string }>,
) =>
  Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "community.gates.nationality-evidence.load",
      text: `SELECT ps.proof_session_id,
                    ps.actor_id AS session_actor_id,
                    ps.intent_id AS session_intent_id,
                    ps.request_hash AS session_request_hash,
                    ps.provider_id AS session_provider_id,
                    ps.upstream_session_ref AS session_upstream_session_ref,
                    ps.provider_configuration_kind AS session_provider_configuration_kind,
                    ps.provider_configuration_ref AS session_provider_configuration_ref,
                    ps.provider_configuration_version AS session_provider_configuration_version,
                    ps.method AS session_method,
                    ps.scope_kind AS session_scope_kind,
                    ps.issuer AS session_issuer,
                    ps.issuer_rp_scope AS session_issuer_rp_scope,
                    ps.issuer_rp_action_scope AS session_issuer_rp_action_scope,
                    ps.request_mode AS session_request_mode,
                    ps.requested_requirements AS session_requested_requirements,
                    ps.requested_claim_ids AS session_requested_claim_ids,
                    ps.subject_binding_intent AS session_subject_binding_intent,
                    ps.protocol_version AS session_protocol_version,
                    ps.environment AS session_environment,
                    ps.status AS session_status,
                    ps.started_at AS session_started_at,
                    ps.expires_at AS session_expires_at,
                    ps.completed_at AS session_completed_at,
                    r.evidence_receipt_id,
                    r.user_id AS receipt_account_id,
                    r.provider_id AS receipt_provider_id,
                    r.issuer AS receipt_issuer,
                    r.method AS receipt_method,
                    r.scope_kind AS receipt_scope_kind,
                    r.issuer_rp_scope AS receipt_issuer_rp_scope,
                    r.issuer_rp_action_scope AS receipt_issuer_rp_action_scope,
                    r.provider_configuration_kind AS receipt_provider_configuration_kind,
                    r.provider_configuration_ref AS receipt_provider_configuration_ref,
                    r.provider_configuration_version AS receipt_provider_configuration_version,
                    r.protocol_version AS receipt_protocol_version,
                    r.environment AS receipt_environment,
                    r.evidence_kind,
                    r.evidence_hash,
                    r.receipt_metadata,
                    r.observed_at AS receipt_observed_at,
                    r.expires_at AS receipt_expires_at,
                    r.subject_key_id AS receipt_subject_key_id,
                    a.assertion_id,
                    a.user_id AS assertion_account_id,
                    a.subject_key_id AS assertion_subject_key_id,
                    a.claim_id,
                    a.assertion_value,
                    a.assurance,
                    a.observed_at AS assertion_observed_at,
                    a.expires_at AS assertion_expires_at,
                    a.binding_group_id,
                    b.subject_binding_event_id AS recorded_binding_event_id,
                    b.subject_binding_epoch AS recorded_binding_epoch,
                    sk.issuer AS subject_issuer,
                    sk.method AS subject_method,
                    sk.scope_kind AS subject_scope_kind,
                    sk.issuer_rp_scope AS subject_issuer_rp_scope,
                    sk.issuer_rp_action_scope AS subject_issuer_rp_action_scope,
                    sk.subject_digest,
                    act.user_id AS active_binding_account_id,
                    act.binding_epoch AS active_binding_epoch,
                    act.binding_event_id AS active_binding_event_id,
                    reval.outcome AS revalidation_outcome
               FROM proof_sessions AS ps
               JOIN evidence_receipts AS r
                 ON r.proof_session_id = ps.proof_session_id
                AND r.user_id = ps.actor_id
                AND r.provenance_kind = 'proof_session'
                AND r.subject_key_id IS NOT NULL
               JOIN assertions AS a
                 ON a.evidence_receipt_id = r.evidence_receipt_id
                AND a.user_id = ps.actor_id
                AND a.claim_id = 'nationality.allowed'
                AND a.subject_key_id = r.subject_key_id
               JOIN assertion_bindings AS b
                 ON b.binding_group_id = a.binding_group_id
                AND b.user_id = a.user_id
                AND b.binding_mode = 'same_subject'
                AND b.subject_key_id = a.subject_key_id
                AND b.subject_binding_event_id IS NOT NULL
                AND b.subject_binding_epoch IS NOT NULL
               JOIN subject_keys AS sk
                 ON sk.subject_key_id = a.subject_key_id
               JOIN active_subject_key_bindings AS act
                 ON act.subject_key_id = sk.subject_key_id
                AND act.user_id = ps.actor_id
               LEFT JOIN LATERAL (
                     SELECT event.outcome
                       FROM assertion_revalidation_events AS event
                      WHERE event.assertion_id = a.assertion_id
                        AND event.user_id = a.user_id
                      ORDER BY event.observed_at DESC, event.created_at DESC,
                               event.assertion_revalidation_event_id DESC
                      LIMIT 1
                   ) AS reval ON TRUE
              WHERE ps.actor_id = $1
                AND ps.status = 'completed'
                AND ps.completed_at = ps.terminal_at
                AND ps.requested_requirements = $2::jsonb
                AND ps.requested_claim_ids = $3::jsonb
                AND ($4::text IS NULL OR ps.provider_id = $4)
                AND ($5::text IS NULL OR r.evidence_receipt_id = $5)
           ORDER BY ps.completed_at DESC, ps.proof_session_id, a.observed_at DESC, a.assertion_id`,
      values: [
        input.userId,
        JSON.stringify([input.policy.requirement]),
        JSON.stringify(["nationality.allowed"]),
        input.providerId ?? null,
        input.receiptId ?? null,
      ],
      readonly: true,
    });
    const candidates = result.rows.map(nationalityCandidateFromRow);
    if (candidates.some((candidate) => candidate === null)) {
      return yield* Effect.fail(new GatesV2CommunityDataInvalid({ source: "evidence" }));
    }
    return candidates.filter(
      (candidate): candidate is NonNullable<typeof candidate> => candidate !== null,
    );
  });

/**
 * Loads the community's current nationality policy with both provider
 * binding rows pinned against the decoded policy. Returns null when the
 * community has no current nationality policy; anything structurally wrong
 * fails closed as invalid policy data.
 */
export const loadCuratedNationalityPolicy = (
  transaction: ControlPlaneTransaction,
  communityId: string,
) =>
  Effect.gen(function* () {
    const result = yield* transaction.execute<Row & Record<string, unknown>>({
      label: "community.gates.nationality-policy.load",
      text: `SELECT p.policy, b.provider_id, b.provider_configuration_kind,
                    b.provider_configuration_ref, b.provider_configuration_version,
                    b.method, b.protocol_version, b.issuer, b.scope_kind,
                    b.issuer_rp_scope, b.issuer_rp_action_scope, b.request_mode
               FROM community_policy_current AS current_policy
               LEFT JOIN policy_versions AS p
                 ON p.community_id = current_policy.community_id
                AND p.policy_key = current_policy.policy_key
                AND p.policy_version_id = current_policy.policy_version_id
               LEFT JOIN community_policy_provider_bindings AS b
                 ON b.community_id = p.community_id
                AND b.policy_key = p.policy_key
                AND b.policy_version_id = p.policy_version_id
              WHERE current_policy.community_id = $1
                AND current_policy.policy_key = 'curated-nationality'`,
      values: [communityId],
      readonly: true,
    });
    if (result.rows.length === 0) return null;
    const policyRow = result.rows[0];
    if (policyRow === undefined) {
      return yield* Effect.fail(new GatesV2CommunityDataInvalid({ source: "policy" }));
    }
    const decoded = Schema.decodeUnknownOption(NationalityPolicySchema)(
      jsonValue(policyRow.policy),
    );
    if (Option.isNone(decoded)) {
      return yield* Effect.fail(new GatesV2CommunityDataInvalid({ source: "policy" }));
    }
    const policy = decoded.value;
    if (result.rows.length !== 2) {
      return yield* Effect.fail(new GatesV2CommunityDataInvalid({ source: "policy" }));
    }
    for (const binding of policy.provider_bindings) {
      const row = result.rows.find((candidate) => candidate.provider_id === binding.provider_id);
      if (
        row === undefined ||
        row.provider_configuration_kind !== binding.provider_configuration.kind ||
        row.provider_configuration_ref !== binding.provider_configuration.reference ||
        row.provider_configuration_version !== binding.provider_configuration.version ||
        row.method !== binding.method ||
        row.protocol_version !== binding.protocol_version ||
        row.issuer !== binding.scope.issuer ||
        row.scope_kind !== "issuer_rp_scope" ||
        row.issuer_rp_scope !== binding.scope.rp_scope ||
        row.issuer_rp_action_scope !== null ||
        row.request_mode !== "dynamic"
      ) {
        return yield* Effect.fail(new GatesV2CommunityDataInvalid({ source: "policy" }));
      }
    }
    return policy;
  });

export const loadCuratedNationalityEvaluation = Effect.fn("loadCuratedNationalityEvaluation")(
  function* (
    transaction: ControlPlaneTransaction,
    input: NationalityEvidenceInput,
  ): Effect.fn.Return<NationalityEvaluation, ControlPlaneError | GatesV2CommunityDataInvalid> {
    const candidates = yield* loadNationalityEvidence(transaction, input);
    const now = yield* loadDatabaseNow(transaction);
    const evaluate = (candidate: (typeof candidates)[number] | null, at: string) =>
      evaluateNationality({
        policy: input.policy,
        account_id: input.userId,
        now: at,
        evidence: { kind: "available", candidate },
      });
    let fallback: NationalityEvaluation | undefined;
    for (const candidate of candidates) {
      const evaluation = evaluate(candidate, now);
      fallback ??= evaluation;
      if (evaluation.outcome !== "pass") continue;
      if (!input.lockEvidence) return evaluation;
      yield* lockPassingAccountEvidence(transaction, {
        proofSessionId: candidate.proof_session.id,
        subjectKeyId: candidate.subject_key.id,
        userId: input.userId,
      });
      // Revalidation inserts take a foreign-key key-share lock on this assertion.
      // FOR UPDATE serializes those inserts with the decision and grant.
      const assertion = yield* transaction.execute<Row>({
        label: "community.gates.nationality-evidence.lock-assertion",
        text: `SELECT assertion_id FROM assertions
                WHERE assertion_id = $1 AND user_id = $2 FOR UPDATE`,
        values: [candidate.assertion.id, input.userId],
        readonly: false,
      });
      if (assertion.rows.length !== 1) {
        return yield* Effect.fail(new GatesV2CommunityDataInvalid({ source: "evidence" }));
      }
      const locked = yield* loadNationalityEvidence(transaction, {
        ...input,
        receiptId: candidate.receipt.id,
      });
      const lockedNow = yield* loadDatabaseNow(transaction);
      const rechecked = evaluate(
        locked.find((value) => value.assertion.id === candidate.assertion.id) ?? null,
        lockedNow,
      );
      if (rechecked.outcome === "pass") return rechecked;
      fallback = rechecked;
    }
    return fallback ?? evaluate(null, now);
  },
);

export const loadCuratedAgeEvaluation = Effect.fn("loadCuratedAgeEvaluation")(function* (
  transaction: ControlPlaneTransaction,
  input: Readonly<{ readonly communityId: string; readonly userId: string }>,
): Effect.fn.Return<CuratedAgeEvaluation, ControlPlaneError | GatesV2CommunityDataInvalid> {
  const [policy, evidence, now] = yield* Effect.all([
    loadPolicy(transaction, input.communityId),
    loadEvidence(transaction, input.userId),
    loadDatabaseNow(transaction),
  ]);
  return evaluateCuratedAge({
    policy,
    evidence: { kind: "available", bundle: evidence },
    now,
  });
});

export const loadCuratedHumanMembershipEvaluation = Effect.fn(
  "loadCuratedHumanMembershipEvaluation",
)(function* (
  transaction: ControlPlaneTransaction,
  input: Readonly<{
    readonly communityId: string;
    readonly userId: string;
    readonly lock?: boolean;
  }>,
): Effect.fn.Return<
  CuratedHumanMembershipEvaluation,
  ControlPlaneError | GatesV2CommunityDataInvalid
> {
  const lock = input.lock === true;
  const policy = yield* loadHumanPolicy(transaction, input.communityId);
  const evidence = yield* loadHumanEvidence(transaction, {
    communityId: input.communityId,
    userId: input.userId,
  });
  const now = yield* loadDatabaseNow(transaction);
  const evaluation = evaluateCuratedHumanMembership({
    policy,
    evidence: { kind: "available", bundle: evidence.bundle },
    now,
  });
  if (!lock || evaluation.outcome !== "pass") return evaluation;

  const witness = evaluation.winning_witness[0];
  if (
    evaluation.winning_witness.length !== 1 ||
    witness === undefined ||
    evidence.proofSessionId === null
  ) {
    return yield* Effect.fail(new GatesV2CommunityDataInvalid({ source: "evidence" }));
  }
  yield* lockPassingAccountEvidence(transaction, {
    proofSessionId: evidence.proofSessionId,
    subjectKeyId: witness.subject_key_id,
    userId: input.userId,
  });

  const lockedEvidence = yield* loadHumanEvidence(transaction, {
    communityId: input.communityId,
    userId: input.userId,
  });
  const lockedNow = yield* loadDatabaseNow(transaction);
  const lockedEvaluation = evaluateCuratedHumanMembership({
    policy,
    evidence: { kind: "available", bundle: lockedEvidence.bundle },
    now: lockedNow,
  });
  if (lockedEvaluation.outcome === "pass") {
    const lockedWitness = lockedEvaluation.winning_witness[0];
    if (
      lockedEvidence.proofSessionId !== evidence.proofSessionId ||
      lockedEvaluation.winning_witness.length !== 1 ||
      lockedWitness === undefined ||
      lockedWitness.subject_key_id !== witness.subject_key_id
    ) {
      return yield* Effect.fail(new GatesV2CommunityDataInvalid({ source: "evidence" }));
    }
  }
  return lockedEvaluation;
});

export const persistEnforceDecision = Effect.fn("persistEnforceDecision")(function* (
  transaction: ControlPlaneTransaction,
  input: Readonly<{
    readonly communityId: string;
    readonly userId: string;
    readonly requestId: string;
    readonly evaluation: CommunityGateEvaluation;
  }>,
): Effect.fn.Return<void, ControlPlaneError> {
  yield* transaction.execute({
    label: "community.gates.decision-records.insert",
    text: `INSERT INTO decision_records (
               decision_record_id, community_id, user_id, policy_version_id, policy_hash,
               evaluation_mode, outcome, winning_witness, trace, indeterminate_reason, request_id
             ) VALUES ($1, $2, $3, $4, $5, 'enforce', $6, $7::jsonb, $8::jsonb, $9, $10)`,
    values: [
      `decision-${globalThis.crypto.randomUUID()}`,
      input.communityId,
      input.userId,
      input.evaluation.policy_version_id,
      input.evaluation.policy_hash,
      input.evaluation.outcome,
      JSON.stringify(input.evaluation.winning_witness),
      JSON.stringify(input.evaluation.trace),
      input.evaluation.outcome === "indeterminate" ? input.evaluation.reason : null,
      input.requestId,
    ],
    readonly: false,
  });
});

export const persistNationalityEnforceDecision = Effect.fn("persistNationalityEnforceDecision")(
  function* (
    transaction: ControlPlaneTransaction,
    input: Readonly<{
      readonly communityId: string;
      readonly userId: string;
      readonly requestId: string;
      readonly policy: NationalityPolicy;
      readonly evaluation: NationalityEvaluation;
    }>,
  ): Effect.fn.Return<void, ControlPlaneError> {
    yield* transaction.execute({
      label: "community.gates.nationality-decision-records.insert",
      text: `INSERT INTO decision_records (
               decision_record_id, community_id, user_id, policy_version_id, policy_hash,
               evaluation_mode, outcome, winning_witness, trace, indeterminate_reason, request_id
             ) VALUES ($1, $2, $3, $4, $5, 'enforce', $6, $7::jsonb, $8::jsonb, $9, $10)`,
      values: [
        `decision-${globalThis.crypto.randomUUID()}`,
        input.communityId,
        input.userId,
        input.policy.policy_version_id,
        input.policy.policy_hash,
        input.evaluation.outcome,
        JSON.stringify(input.evaluation.outcome === "pass" ? input.evaluation.winning_witness : []),
        JSON.stringify(
          input.evaluation.outcome === "pass"
            ? []
            : "reason" in input.evaluation
              ? [input.evaluation.reason]
              : [],
        ),
        input.evaluation.outcome === "indeterminate" ? input.evaluation.reason : null,
        input.requestId,
      ],
      readonly: false,
    });
  },
);

export const CURATED_AGE_GATE_SUMMARY = {
  gate_id: CURATED_AGE_18_POLICY.policy_version_id,
  gate_type: "minimum_age",
  accepted_providers: ["self", "zkpassport"],
  required_minimum_age: 18,
} as const;

export const CURATED_HUMAN_GATE_SUMMARY = {
  gate_id: CURATED_HUMAN_MEMBERSHIP_POLICY.policy_version_id,
  gate_type: "human_verification",
  accepted_providers: [VERY_WEB_PROVIDER_ID],
} as const;

export function gateEvaluationDetails(
  evaluation: CommunityGateEvaluation,
): Readonly<Record<string, Json>> {
  switch (evaluation.outcome) {
    case "needs_evidence":
      return {
        outcome: evaluation.outcome,
        reasons: evaluation.reasons,
        claim_ids: evaluation.claim_ids,
      };
    case "fail":
      return { outcome: evaluation.outcome, reason: evaluation.reason };
    case "pass":
      return { outcome: evaluation.outcome };
    case "indeterminate":
      return { outcome: evaluation.outcome };
    default:
      return { outcome: "indeterminate" };
  }
}
