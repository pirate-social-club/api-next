import { Schema } from "effect";
import { canonicalJson } from "../canonical-json.ts";
import {
  Assertion,
  EvidenceReceipt,
  ProofSession,
  SameSubjectBindingGroup,
  SubjectKey,
} from "../verification/evidence.ts";
import { CanonicalIsoInstant, NonNegativeIntegerString } from "../verification/scalars.ts";
import type { EvaluatorWitness, EvidenceUnavailableReason } from "./evaluator.ts";
import { NationalityPolicy } from "./nationality-policy.ts";

const strict = { onExcessProperty: "error" } as const;
const AccountBinding = Schema.Struct({
  account_id: Schema.NonEmptyString,
  subject_key_id: Schema.NonEmptyString,
  binding_epoch: NonNegativeIntegerString,
  binding_event_id: Schema.NonEmptyString,
});

/** Loaded from accepted evidence and current account bindings in one transaction snapshot. */
const Candidate = Schema.Struct({
  proof_session: ProofSession,
  receipt: EvidenceReceipt,
  assertion: Assertion,
  subject_key: SubjectKey,
  binding_group: SameSubjectBindingGroup,
  receipt_account_id: Schema.NonEmptyString,
  assertion_account_id: Schema.NonEmptyString,
  recorded_binding: AccountBinding,
  active_binding: AccountBinding,
  /** Accepted means the original acceptance remains valid after checking revalidation events. */
  revalidation: Schema.Literals(["accepted", "revoked", "rejected", "indeterminate"]),
});

const Input = Schema.Struct({
  policy: NationalityPolicy,
  account_id: Schema.NonEmptyString,
  now: CanonicalIsoInstant,
  evidence: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("available"), candidate: Schema.NullOr(Candidate) }),
    Schema.Struct({
      kind: Schema.Literal("indeterminate"),
      reason: Schema.Literals([
        "provider_unavailable",
        "evidence_store_unavailable",
        "snapshot_unavailable",
      ]),
    }),
  ]),
});
export type NationalityEvaluatorInput = Schema.Schema.Type<typeof Input>;

type Metadata = Readonly<{
  policy_hash: string;
  requirement_hash: string;
}>;
export type NationalityEvaluation =
  | Readonly<{ outcome: "fail"; reason: "invalid_input" | "invalid_evidence" }>
  | (Metadata & Readonly<{ outcome: "pass"; winning_witness: readonly [EvaluatorWitness] }>)
  | (Metadata &
      Readonly<{
        outcome: "needs_evidence";
        reason:
          | "missing"
          | "requirement_changed"
          | "provider_binding_changed"
          | "expired"
          | "revoked";
      }>)
  | (Metadata & Readonly<{ outcome: "indeterminate"; reason: EvidenceUnavailableReason }>);

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/**
 * Evaluates only nationality, never Palm participation, age, membership, or a handle grant.
 * The caller supplies a server-owned policy and accepted evidence snapshot, not client facts,
 * then persists a separate decision for the consuming action. Ceremony/quote expiry is not TTL.
 */
export function evaluateNationality(input: unknown): NationalityEvaluation {
  const decoded = Schema.decodeUnknownOption(Input, strict)(input);
  if (decoded._tag === "None") return { outcome: "fail", reason: "invalid_input" };
  const { policy, account_id, now, evidence } = decoded.value;
  const metadata = { policy_hash: policy.policy_hash, requirement_hash: policy.requirement_hash };
  if (evidence.kind === "indeterminate") {
    return { ...metadata, outcome: "indeterminate", reason: evidence.reason };
  }
  const candidate = evidence.candidate;
  if (candidate === null) return { ...metadata, outcome: "needs_evidence", reason: "missing" };
  const {
    proof_session: session,
    receipt,
    assertion,
    subject_key: subject,
    binding_group: group,
    active_binding: active,
    recorded_binding: recorded,
  } = candidate;
  const invalid = { outcome: "fail", reason: "invalid_evidence" } as const;

  // The accepted predicate must carry provenance all the way to this account's current binding.
  if (
    session.actor_id !== account_id ||
    candidate.receipt_account_id !== account_id ||
    candidate.assertion_account_id !== account_id ||
    active.account_id !== account_id ||
    !same(active, recorded) ||
    active.subject_key_id !== subject.id ||
    receipt.proof_session_id !== session.id ||
    assertion.evidence_receipt_id !== receipt.id ||
    receipt.subject_key_id !== subject.id ||
    assertion.subject_key_id !== subject.id ||
    assertion.binding_group_id !== group.id ||
    group.subject_key_id !== subject.id ||
    assertion.claim_id !== "nationality.allowed" ||
    Object.keys(assertion.value).some((key) => key !== "allowed") ||
    assertion.assurance !== policy.required_assurance
  )
    return invalid;

  if (
    session.status !== "completed" ||
    session.completed_at === undefined ||
    session.started_at > session.completed_at ||
    session.completed_at >= session.expires_at ||
    session.completed_at > now ||
    session.request_mode !== "dynamic" ||
    session.subject_binding_intent === "none" ||
    !same(
      session.requested_claim_ids,
      session.requested_requirements.map((r) => r.claim_id),
    ) ||
    receipt.observed_at > now ||
    assertion.observed_at > now
  )
    return invalid;

  const requirement = session.requested_requirements.find(
    (r) => r.claim_id === "nationality.allowed",
  );
  if (requirement === undefined) return invalid;
  if (!same(requirement, policy.requirement)) {
    return { ...metadata, outcome: "needs_evidence", reason: "requirement_changed" };
  }

  // Configuration, protocol, scope, and environment are pinned for each user-selectable provider.
  const binding = policy.provider_bindings.find((b) => b.provider_id === receipt.provider_id);
  if (binding === undefined) return invalid;
  if (
    session.provider_id !== receipt.provider_id ||
    session.method !== receipt.method ||
    !same(session.scope, receipt.scope) ||
    !same(session.provider_configuration, receipt.provider_configuration) ||
    session.protocol_version !== receipt.protocol_version ||
    session.environment !== receipt.environment ||
    receipt.issuer !== receipt.scope.issuer ||
    subject.issuer !== receipt.issuer ||
    subject.method !== receipt.method ||
    !same(subject.scope, receipt.scope)
  )
    return invalid;
  if (
    receipt.method !== binding.method ||
    !same(receipt.scope, binding.scope) ||
    !same(receipt.provider_configuration, binding.provider_configuration) ||
    receipt.protocol_version !== binding.protocol_version ||
    receipt.environment !== binding.environment
  )
    return { ...metadata, outcome: "needs_evidence", reason: "provider_binding_changed" };

  if (candidate.revalidation === "indeterminate") {
    return { ...metadata, outcome: "indeterminate", reason: "evidence_store_unavailable" };
  }
  if (candidate.revalidation !== "accepted") {
    return { ...metadata, outcome: "needs_evidence", reason: "revoked" };
  }
  for (const fact of [receipt, assertion]) {
    if (fact.expires_at !== undefined && fact.expires_at <= fact.observed_at) return invalid;
    if (
      (fact.expires_at !== undefined && fact.expires_at <= now) ||
      (policy.evidence_lifetime.kind === "max_age_seconds" &&
        (Date.parse(now) - Date.parse(fact.observed_at)) / 1000 >= policy.evidence_lifetime.seconds)
    )
      return { ...metadata, outcome: "needs_evidence", reason: "expired" };
  }
  return {
    ...metadata,
    outcome: "pass",
    winning_witness: [
      {
        assertion_ids: [assertion.id],
        evidence_receipt_ids: [receipt.id],
        subject_key_id: subject.id,
        binding_group_id: group.id,
      },
    ],
  };
}
