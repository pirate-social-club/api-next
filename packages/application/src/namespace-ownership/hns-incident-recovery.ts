import type { HnsChainObservationResultV1 } from "./hns-chain-observation.ts";
import type { HnsRootResourceRecordV1 } from "./hns-root-import-plan.ts";
import {
  type HnsRetainedAuthorityReferenceV1,
  hnsObservationReferencesAuthorityV1,
} from "./hns-teardown-retention.ts";

/**
 * Incident recovery evidence and its classification — spec 012, "Failed/expired
 * imports with retained authority or uncertain chain publication".
 *
 * Recovery decides what happens to live authority, so what it may conclude is
 * bounded by what was actually read. The classification is a pure function over
 * gathered evidence and it has an explicit "insufficient" outcome, because the
 * alternative — treating an unread field as a negative finding — is how a
 * healthy name gets classified as abandoned.
 *
 * Publication is judged on wire bytes. The covenant that carried the UPDATE
 * holds the encoded resource, and the retained plan carries the digest of the
 * bytes the owner was asked to publish, so the comparison is digest to digest
 * over the same encoding. The observation's canonical-JSON digest describes a
 * different byte sequence and is deliberately not an input to this decision.
 */

/**
 * The transaction that put the current resource on the name.
 *
 * `info.height` from a name read is the height the name was opened at and does
 * not move when the resource changes, so inclusion is established through the
 * owning outpoint's transaction and the block that confirmed it, never from the
 * name state alone.
 */
export type HnsRecoveryInclusionV1 = Readonly<{
  readonly txid: string;
  readonly output_index: number;
  readonly block_hash: string;
  readonly block_height: number;
  readonly confirmations: number;
  readonly covenant_action: string;
  /** SHA-256 of the encoded resource the covenant carried. */
  readonly covenant_resource_sha256: string;
}>;

export type HnsRecoveryZoneAvailabilityV1 = Readonly<{
  readonly zone_present: boolean;
  readonly signing_keys_present: boolean;
}>;

export type HnsRecoveryEvidenceV1 = Readonly<{
  /** Null when no transaction could be resolved for the current resource. */
  readonly inclusion: HnsRecoveryInclusionV1 | null;
  /** The decoded resource the name currently carries, or null when unread. */
  readonly decoded_resource: readonly HnsRootResourceRecordV1[] | null;
  /** The wire digest of the plan the owner was asked to publish. */
  readonly retained_plan_encoded_sha256: string | null;
  /** What the retained plan asserts on the name, for the reference test. */
  readonly retained_authority: HnsRetainedAuthorityReferenceV1 | null;
  readonly current: HnsChainObservationResultV1 | null;
  readonly safe: HnsChainObservationResultV1 | null;
  /** Null when provider availability was not established. */
  readonly zone: HnsRecoveryZoneAvailabilityV1 | null;
}>;

export type HnsRecoveryClassificationV1 =
  | "matching_authority_available"
  | "recoverable_authority_missing"
  | "conflicting_publication"
  | "insufficient_evidence";

export type HnsRecoveryReasonV1 =
  | "published_resource_matches_plan"
  | "published_resource_references_authority"
  | "authority_intact_no_publication"
  | "zone_missing"
  | "signing_keys_missing"
  | "published_resource_replaces_authority"
  | "retained_plan_digest_unknown"
  | "chain_state_unavailable"
  | "provider_availability_unknown"
  | "inclusion_unresolved";

export type HnsRecoveryFindingV1 = Readonly<{
  readonly classification: HnsRecoveryClassificationV1;
  readonly reason: HnsRecoveryReasonV1;
  /** Both views, in the order they were inspected, that produced this finding. */
  readonly inspected_views: readonly ("current" | "safe")[];
  /**
   * The supported recovery action, or null when the evidence supports none.
   * A replacement wallet update is never proposed here: it depends on findings
   * an operator reviews, and it is not what any of these classifications imply.
   */
  readonly supported_action: "resume" | "adopt" | "restore_authority" | null;
}>;

const observedOf = (result: HnsChainObservationResultV1 | null) =>
  result !== null && result.kind === "observed" ? result.observation : null;

const absentFinding = (result: HnsChainObservationResultV1 | null): boolean =>
  result !== null && result.kind === "finding" && result.classification === "resource_absent";

function insufficient(
  reason: HnsRecoveryReasonV1,
  inspected: readonly ("current" | "safe")[] = [],
): HnsRecoveryFindingV1 {
  return {
    classification: "insufficient_evidence",
    reason,
    inspected_views: inspected,
    supported_action: null,
  };
}

/**
 * Classifies gathered incident evidence.
 *
 * The order matters. Unknown inputs are rejected before any positive
 * conclusion, so a missing read can never be scored as a negative finding, and
 * an unresolved inclusion for a name that does carry a resource is insufficient
 * rather than a conflict: not knowing which transaction published it is not
 * evidence that someone else did.
 */
export function classifyHnsRecoveryEvidenceV1(
  evidence: HnsRecoveryEvidenceV1,
): HnsRecoveryFindingV1 {
  if (evidence.retained_plan_encoded_sha256 === null || evidence.retained_authority === null) {
    return insufficient("retained_plan_digest_unknown");
  }
  const current = observedOf(evidence.current);
  const safe = observedOf(evidence.safe);
  const currentAbsent = absentFinding(evidence.current);
  const safeAbsent = absentFinding(evidence.safe);
  if ((current === null && !currentAbsent) || (safe === null && !safeAbsent)) {
    return insufficient("chain_state_unavailable");
  }
  const inspected: ("current" | "safe")[] = ["current", "safe"];
  if (evidence.zone === null) return insufficient("provider_availability_unknown", inspected);

  // Nothing is published on either view. The chain contradicts nothing, so the
  // question is only whether our own authority is still there to resume with.
  if (currentAbsent && safeAbsent) {
    if (!evidence.zone.zone_present) {
      return {
        classification: "recoverable_authority_missing",
        reason: "zone_missing",
        inspected_views: inspected,
        supported_action: "restore_authority",
      };
    }
    if (!evidence.zone.signing_keys_present) {
      return {
        classification: "recoverable_authority_missing",
        reason: "signing_keys_missing",
        inspected_views: inspected,
        supported_action: "restore_authority",
      };
    }
    return {
      classification: "matching_authority_available",
      reason: "authority_intact_no_publication",
      inspected_views: inspected,
      supported_action: "resume",
    };
  }

  // Something is published. Which transaction put it there is part of the
  // evidence, and without it the publication cannot be attributed at all.
  if (evidence.inclusion === null) return insufficient("inclusion_unresolved", inspected);
  if (evidence.decoded_resource === null) return insufficient("chain_state_unavailable", inspected);

  const matchesPlan =
    evidence.inclusion.covenant_resource_sha256 === evidence.retained_plan_encoded_sha256;
  const referencesAuthority = hnsObservationReferencesAuthorityV1(
    evidence.decoded_resource,
    evidence.retained_authority,
  );
  if (!matchesPlan && !referencesAuthority) {
    // A resource that is neither the plan nor anything delegating to us. The
    // name is serving somebody else's authority and resuming would fight it.
    return {
      classification: "conflicting_publication",
      reason: "published_resource_replaces_authority",
      inspected_views: inspected,
      supported_action: null,
    };
  }
  if (!evidence.zone.zone_present) {
    return {
      classification: "recoverable_authority_missing",
      reason: "zone_missing",
      inspected_views: inspected,
      supported_action: "restore_authority",
    };
  }
  if (!evidence.zone.signing_keys_present) {
    return {
      classification: "recoverable_authority_missing",
      reason: "signing_keys_missing",
      inspected_views: inspected,
      supported_action: "restore_authority",
    };
  }
  return {
    classification: "matching_authority_available",
    reason: matchesPlan
      ? "published_resource_matches_plan"
      : // The owner kept our delegation and published more besides. That is
        // their resource to shape, and it is not a conflict.
        "published_resource_references_authority",
    inspected_views: inspected,
    // An exact match resumes the original operation; a resource that merely
    // references the authority is adopted, because what is published is not
    // what the plan specified and the operation must bind to what is there.
    supported_action: matchesPlan ? "resume" : "adopt",
  };
}

/** A stable reference for one gathered evidence set, so a replay is recognised. */
export function hnsRecoveryEvidenceRefV1(evidence: HnsRecoveryEvidenceV1): string {
  const view = (result: HnsChainObservationResultV1 | null, name: string): string => {
    if (result === null) return `${name}:absent`;
    if (result.kind === "observed") {
      return `${name}:${result.observation.anchor.height}:${result.observation.resource_sha256.slice(0, 16)}`;
    }
    return `${name}:${result.kind}:${result.classification}`;
  };
  const inclusion =
    evidence.inclusion === null
      ? "inclusion:none"
      : `inclusion:${evidence.inclusion.txid.slice(0, 16)}:${evidence.inclusion.output_index}:${evidence.inclusion.block_height}`;
  const zone =
    evidence.zone === null
      ? "zone:unknown"
      : `zone:${evidence.zone.zone_present ? "present" : "absent"}:${
          evidence.zone.signing_keys_present ? "keyed" : "unkeyed"
        }`;
  return `recovery:${view(evidence.current, "current")}:${view(evidence.safe, "safe")}:${inclusion}:${zone}`;
}
