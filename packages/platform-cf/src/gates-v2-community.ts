import type { ControlPlaneError, ControlPlaneTransaction } from "@pirate/application";
import {
  CURATED_AGE_18_POLICY,
  type CuratedAgeEvaluation,
  evaluateCuratedAge,
} from "@pirate/domain";
import { CanonicalIsoInstant, type SubjectScope } from "@pirate/domain/verification";
import { Data, Effect, Option, Predicate, Schema } from "effect";

type Row = Readonly<Record<string, unknown>>;
type Json = Schema.Schema.Type<typeof Schema.Json>;

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

export const persistEnforceDecision = Effect.fn("persistEnforceDecision")(function* (
  transaction: ControlPlaneTransaction,
  input: Readonly<{
    readonly communityId: string;
    readonly userId: string;
    readonly requestId: string;
    readonly evaluation: CuratedAgeEvaluation;
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

export const CURATED_AGE_GATE_SUMMARY = {
  gate_id: CURATED_AGE_18_POLICY.policy_version_id,
  gate_type: "minimum_age",
  accepted_providers: ["self", "zkpassport"],
  required_minimum_age: 18,
} as const;

export function gateEvaluationDetails(
  evaluation: CuratedAgeEvaluation,
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
