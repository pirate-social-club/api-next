import type { NationalityEvaluation } from "../gates-v2/nationality-evaluator.ts";
import type { NationalityPolicy } from "../gates-v2/nationality-policy.ts";
import { nationalityProviderBindingHash } from "../gates-v2/nationality-policy.ts";
import { sha256Hex } from "../gates-v2/sha256.ts";

export type HandleNationalityProviderIdV1 = "self.pass" | "zkpassport";

export type HandleNationalityLifetimeV1 = Readonly<{
  readonly kind: "max_age_seconds";
  readonly seconds: number;
}>;

/**
 * Versioned nationality qualification authoring. It is independent of any
 * community join policy and reuses the curated Gates v2 nationality policy
 * identity, both provider binding hashes, and the explicit lifetime. The
 * existing none_v1 and private-account-allowlist wires are untouched.
 */
export type HandleNationalityQualificationPolicyRefV1 = Readonly<{
  readonly kind: "curated_nationality_v1";
  readonly policy_id: string;
  readonly policy_revision: number;
  readonly policy_hash: string;
  readonly requirement_hash: string;
  readonly provider_binding_hashes: readonly [string, string];
  readonly lifetime: HandleNationalityLifetimeV1;
}>;

export type HandleNationalityEligibilitySnapshotV1 = Readonly<{
  readonly decision: "passed";
  readonly policy_revision: number;
  readonly policy_hash: string;
  readonly requirement_hash: string;
  readonly selected_provider_id: HandleNationalityProviderIdV1;
  readonly selected_provider_binding_hash: string;
  readonly accepted_provider_ids: readonly [
    HandleNationalityProviderIdV1,
    HandleNationalityProviderIdV1,
  ];
  readonly lifetime: HandleNationalityLifetimeV1;
  readonly evidence_use_ids: readonly string[];
  readonly evaluated_at: string;
}>;

export type HandleNationalityQualificationRejectionV1 =
  | "offering_changed"
  | "qualification_changed"
  | "requirement_changed"
  | "provider_binding_changed"
  | "evidence_missing"
  | "evidence_expired"
  | "evidence_revoked"
  | "evidence_invalid"
  | "indeterminate";

export type HandleNationalityQualificationRecheckOutcomeV1 =
  | Readonly<{ readonly kind: "qualified" }>
  | Readonly<{
      readonly kind: "rejected";
      readonly reason: HandleNationalityQualificationRejectionV1;
    }>;

export type HandleNationalityQualificationRecheckInputV1 = Readonly<{
  readonly pin: Readonly<{
    readonly offering_revision: number;
    readonly offering_hash: string;
    readonly qualification: HandleNationalityQualificationPolicyRefV1;
    readonly eligibility: HandleNationalityEligibilitySnapshotV1;
  }>;
  readonly current: Readonly<{
    readonly offering_revision: number;
    readonly offering_hash: string;
    readonly qualification: HandleNationalityQualificationPolicyRefV1;
  }>;
  readonly evaluation: NationalityEvaluation;
  /** Server-derived binding hash of the winning receipt's provider, or null. */
  readonly winning_provider_binding_hash: string | null;
}>;

export type HandleNationalityQualificationHashV1 = Readonly<{
  readonly bytes: number;
  readonly preimage: string;
  readonly sha256: string;
}>;

const encoded = (preimage: readonly unknown[]): HandleNationalityQualificationHashV1 => {
  const json = JSON.stringify(preimage);
  return {
    bytes: new TextEncoder().encode(json).byteLength,
    preimage: json,
    sha256: sha256Hex(json),
  };
};

const validIdentifier = (value: string): boolean =>
  value.length > 0 &&
  value === value.trim() &&
  ![...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
const validRevision = (value: number): boolean => Number.isSafeInteger(value) && value > 0;
const validDigest = (value: string): boolean => /^[0-9a-f]{64}$/u.test(value);

const requireIdentifier = (value: string, name: string): void => {
  if (!validIdentifier(value)) throw new TypeError(`Invalid ${name}`);
};
const requireRevision = (value: number, name: string): void => {
  if (!validRevision(value)) throw new TypeError(`Invalid ${name}`);
};
const requireDigest = (value: string, name: string): void => {
  if (!validDigest(value)) throw new TypeError(`Invalid ${name}`);
};
const requireLifetime = (lifetime: HandleNationalityLifetimeV1): void => {
  if (lifetime.kind !== "max_age_seconds" || !validRevision(lifetime.seconds)) {
    throw new TypeError("Invalid nationality qualification lifetime");
  }
};

function requireQualificationRef(ref: HandleNationalityQualificationPolicyRefV1): void {
  if (ref.kind !== "curated_nationality_v1") {
    throw new TypeError("Invalid nationality qualification policy kind");
  }
  requireIdentifier(ref.policy_id, "qualification policy id");
  requireRevision(ref.policy_revision, "qualification policy revision");
  requireDigest(ref.policy_hash, "qualification policy hash");
  requireDigest(ref.requirement_hash, "qualification requirement hash");
  const [selfPass, zkPassport] = ref.provider_binding_hashes;
  if (
    selfPass === undefined ||
    zkPassport === undefined ||
    ref.provider_binding_hashes.length !== 2 ||
    !validDigest(selfPass) ||
    !validDigest(zkPassport)
  ) {
    throw new TypeError("Invalid qualification provider binding hashes");
  }
  requireLifetime(ref.lifetime);
}

function requireSnapshot(snapshot: HandleNationalityEligibilitySnapshotV1): void {
  if (snapshot.decision !== "passed")
    throw new TypeError("Invalid qualification snapshot decision");
  requireRevision(snapshot.policy_revision, "snapshot policy revision");
  requireDigest(snapshot.policy_hash, "snapshot policy hash");
  requireDigest(snapshot.requirement_hash, "snapshot requirement hash");
  requireDigest(snapshot.selected_provider_binding_hash, "snapshot selected binding hash");
  requireLifetime(snapshot.lifetime);
  const [first, second] = snapshot.accepted_provider_ids;
  if (
    first !== "self.pass" ||
    second !== "zkpassport" ||
    snapshot.accepted_provider_ids.length !== 2 ||
    !snapshot.accepted_provider_ids.includes(snapshot.selected_provider_id)
  ) {
    throw new TypeError("Invalid accepted document provider alternatives");
  }
  for (const evidenceUseId of snapshot.evidence_use_ids) {
    requireIdentifier(evidenceUseId, "evidence-use id");
  }
  requireIdentifier(snapshot.evaluated_at, "qualification evaluation instant");
}

/**
 * Builds the versioned qualification ref from a compiled curated nationality
 * policy. The explicit lifetime is part of the ref; an indefinite policy is
 * refused here because the owner has not adopted one.
 */
export function handleNationalityQualificationRefFromPolicy(
  policyId: string,
  policy: NationalityPolicy,
): HandleNationalityQualificationPolicyRefV1 {
  if (policy.evidence_lifetime.kind !== "max_age_seconds") {
    throw new TypeError("Nationality qualification requires an explicit bounded lifetime");
  }
  const ref: HandleNationalityQualificationPolicyRefV1 = {
    kind: "curated_nationality_v1",
    policy_id: policyId,
    policy_revision: policy.policy_revision,
    policy_hash: policy.policy_hash,
    requirement_hash: policy.requirement_hash,
    provider_binding_hashes: [
      nationalityProviderBindingHash(policy.provider_bindings[0]),
      nationalityProviderBindingHash(policy.provider_bindings[1]),
    ],
    lifetime: {
      kind: "max_age_seconds",
      seconds: policy.evidence_lifetime.seconds,
    },
  };
  requireQualificationRef(ref);
  return ref;
}

export function handleNationalityQualificationRefPreimage(
  ref: HandleNationalityQualificationPolicyRefV1,
): readonly unknown[] {
  requireQualificationRef(ref);
  return [
    "pirate-handle-nationality-qualification-ref-v1",
    ref.policy_id,
    ref.policy_revision,
    ref.policy_hash,
    ref.requirement_hash,
    [...ref.provider_binding_hashes],
    [ref.lifetime.kind, ref.lifetime.seconds],
  ];
}

export function handleNationalityQualificationRefHash(
  ref: HandleNationalityQualificationPolicyRefV1,
): HandleNationalityQualificationHashV1 {
  return encoded(handleNationalityQualificationRefPreimage(ref));
}

export function handleNationalityEligibilitySnapshotPreimage(
  snapshot: HandleNationalityEligibilitySnapshotV1,
): readonly unknown[] {
  requireSnapshot(snapshot);
  return [
    "pirate-handle-nationality-eligibility-snapshot-v1",
    snapshot.decision,
    snapshot.policy_revision,
    snapshot.policy_hash,
    snapshot.requirement_hash,
    snapshot.selected_provider_id,
    snapshot.selected_provider_binding_hash,
    [...snapshot.accepted_provider_ids],
    [snapshot.lifetime.kind, snapshot.lifetime.seconds],
    snapshot.evidence_use_ids,
    snapshot.evaluated_at,
  ];
}

export function handleNationalityEligibilitySnapshotHash(
  snapshot: HandleNationalityEligibilitySnapshotV1,
): HandleNationalityQualificationHashV1 {
  return encoded(handleNationalityEligibilitySnapshotPreimage(snapshot));
}

function sameQualification(
  left: HandleNationalityQualificationPolicyRefV1,
  right: HandleNationalityQualificationPolicyRefV1,
): boolean {
  return (
    left.kind === right.kind &&
    left.policy_id === right.policy_id &&
    left.policy_revision === right.policy_revision &&
    left.policy_hash === right.policy_hash &&
    left.requirement_hash === right.requirement_hash &&
    left.provider_binding_hashes[0] === right.provider_binding_hashes[0] &&
    left.provider_binding_hashes[1] === right.provider_binding_hashes[1] &&
    left.lifetime.kind === right.lifetime.kind &&
    left.lifetime.seconds === right.lifetime.seconds
  );
}

/**
 * Claim-time recheck against the pinned quote snapshot. The caller supplies
 * the current effective offering identity and a fresh evaluation at claim
 * time, so an unexpired quote can never extend an expired or revoked proof.
 * A pass is accepted only from the pinned selected provider; qualifying with
 * the other alternative requires a new quote.
 */
export function recheckHandleNationalityQualification(
  input: HandleNationalityQualificationRecheckInputV1,
): HandleNationalityQualificationRecheckOutcomeV1 {
  const { pin, current, evaluation } = input;
  requireQualificationRef(pin.qualification);
  requireQualificationRef(current.qualification);
  requireSnapshot(pin.eligibility);
  if (
    pin.offering_revision !== current.offering_revision ||
    pin.offering_hash !== current.offering_hash
  ) {
    return { kind: "rejected", reason: "offering_changed" };
  }
  if (!sameQualification(pin.qualification, current.qualification)) {
    return { kind: "rejected", reason: "qualification_changed" };
  }
  if (
    pin.eligibility.policy_revision !== current.qualification.policy_revision ||
    pin.eligibility.policy_hash !== current.qualification.policy_hash ||
    pin.eligibility.requirement_hash !== current.qualification.requirement_hash
  ) {
    return { kind: "rejected", reason: "qualification_changed" };
  }
  if (evaluation.outcome === "fail") {
    return { kind: "rejected", reason: "evidence_invalid" };
  }
  if (evaluation.policy_hash !== current.qualification.policy_hash) {
    return { kind: "rejected", reason: "qualification_changed" };
  }
  if (evaluation.requirement_hash !== current.qualification.requirement_hash) {
    return { kind: "rejected", reason: "requirement_changed" };
  }
  if (evaluation.outcome === "pass") {
    return input.winning_provider_binding_hash === pin.eligibility.selected_provider_binding_hash
      ? { kind: "qualified" }
      : { kind: "rejected", reason: "provider_binding_changed" };
  }
  if (evaluation.outcome === "indeterminate") {
    return { kind: "rejected", reason: "indeterminate" };
  }
  switch (evaluation.reason) {
    case "missing":
      return { kind: "rejected", reason: "evidence_missing" };
    case "expired":
      return { kind: "rejected", reason: "evidence_expired" };
    case "revoked":
      return { kind: "rejected", reason: "evidence_revoked" };
    case "requirement_changed":
      return { kind: "rejected", reason: "requirement_changed" };
    case "provider_binding_changed":
      return { kind: "rejected", reason: "provider_binding_changed" };
  }
}
