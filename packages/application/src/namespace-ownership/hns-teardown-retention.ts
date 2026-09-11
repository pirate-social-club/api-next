import type { HnsChainObservationResultV1 } from "./hns-chain-observation.ts";
import type { HnsRootResourceRecordV1 } from "./hns-root-import-plan.ts";

/**
 * Authority retention decision before any retirement — spec 012
 * "Authority retention, quota, and retirement" (2026-09-09 amendment).
 * DNS authority is retained independently of import status; retirement
 * requires positive evidence, and a terminal decision never implies
 * teardown. This pure gate applies to teardown_provisional_root_v1,
 * teardown_root_v1, partial provisioning, exhausted retries, ambiguous
 * provider responses, older name-signature sessions, and successor
 * reservations.
 */

export type HnsTeardownKindV1 = "teardown_provisional_root_v1" | "teardown_root_v1";

/**
 * The authority a retained plan asserts on the name.
 *
 * Whole-resource digest equality is not a reference test. The resource is a
 * complete replacement, so any unrelated change the owner makes — one extra
 * TXT record — alters its digest while our nameservers and delegation signer
 * remain published and serving. Judging absence by digest inequality would
 * read "the owner added a record" as "the owner never published", which is
 * the reading that authorizes deleting live infrastructure.
 */
export type HnsRetainedAuthorityReferenceV1 = Readonly<{
  readonly ns_names: readonly string[];
  readonly ds: readonly Readonly<{
    readonly key_tag: number;
    readonly algorithm: number;
    readonly digest_type: number;
    readonly digest: string;
  }>[];
  readonly challenge_txt_value: string | null;
}>;

const normalizeName = (value: string): string => value.trim().toLowerCase().replace(/\.$/u, "");

const recordField = (record: HnsRootResourceRecordV1, key: string): unknown =>
  (record as Record<string, unknown>)[key];

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

const asNumber = (value: unknown): number | null => (typeof value === "number" ? value : null);

/**
 * True when the observed resource still references the retained authority by
 * any of its nameservers, its delegation signer, or its verification
 * challenge. Any one of these means deleting the zone or keyset would break a
 * name the owner is currently serving.
 */
export function hnsObservationReferencesAuthorityV1(
  records: readonly HnsRootResourceRecordV1[],
  authority: HnsRetainedAuthorityReferenceV1,
): boolean {
  const wantedNs = new Set(authority.ns_names.map(normalizeName));
  const wantedDs = new Set(
    authority.ds.map(
      (entry) =>
        `${entry.key_tag}:${entry.algorithm}:${entry.digest_type}:${entry.digest.trim().toLowerCase()}`,
    ),
  );
  for (const record of records) {
    const type = asString(recordField(record, "type"))?.toUpperCase();
    if (type === "NS") {
      const name = asString(recordField(record, "ns"));
      if (name !== null && wantedNs.has(normalizeName(name))) return true;
    }
    if (type === "DS") {
      const keyTag =
        asNumber(recordField(record, "keyTag")) ?? asNumber(recordField(record, "key_tag"));
      const algorithm = asNumber(recordField(record, "algorithm"));
      const digestType =
        asNumber(recordField(record, "digestType")) ?? asNumber(recordField(record, "digest_type"));
      const digest = asString(recordField(record, "digest"));
      if (keyTag !== null && algorithm !== null && digestType !== null && digest !== null) {
        if (wantedDs.has(`${keyTag}:${algorithm}:${digestType}:${digest.trim().toLowerCase()}`)) {
          return true;
        }
      }
    }
    if (type === "TXT" && authority.challenge_txt_value !== null) {
      const values = recordField(record, "txt");
      if (Array.isArray(values)) {
        for (const value of values) {
          if (asString(value)?.trim() === authority.challenge_txt_value.trim()) return true;
        }
      }
    }
  }
  return false;
}

/**
 * Describe the authority an exposed plan asserts, for the reference test.
 *
 * A plan document that cannot be parsed, or that carries no replacement
 * records, yields an authority with no references. Callers that must
 * distinguish "the plan asserts nothing" from "the plan could not be read"
 * catch the throw and treat it as unknown provenance, which retains.
 */
export function hnsRetainedAuthorityFromPlanDocumentV1(
  bytes: Uint8Array,
): HnsRetainedAuthorityReferenceV1 {
  const plan = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  const records = Array.isArray(plan.replacement_records) ? plan.replacement_records : [];
  const nsNames: string[] = [];
  const ds: { key_tag: number; algorithm: number; digest_type: number; digest: string }[] = [];
  let challenge: string | null = null;
  for (const entry of records) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type.toUpperCase() : "";
    if (type === "NS" && typeof record.ns === "string") nsNames.push(record.ns);
    if (type === "DS") {
      const keyTag = record.keyTag ?? record.key_tag;
      const digestType = record.digestType ?? record.digest_type;
      if (
        typeof keyTag === "number" &&
        typeof record.algorithm === "number" &&
        typeof digestType === "number" &&
        typeof record.digest === "string"
      ) {
        ds.push({
          key_tag: keyTag,
          algorithm: record.algorithm,
          digest_type: digestType,
          digest: record.digest,
        });
      }
    }
    if (type === "TXT" && Array.isArray(record.txt)) {
      for (const value of record.txt) {
        if (typeof value === "string" && value.startsWith("pirate-verification="))
          challenge = value;
      }
    }
  }
  return { ns_names: nsNames, ds, challenge_txt_value: challenge };
}

export type HnsTeardownRetentionDecisionV1 = Readonly<{
  readonly decision: "retain" | "retire_eligible";
  readonly reason:
    | "chain_reference_retained"
    | "unavailable_chain_state_retained"
    | "chain_absence_after_exposure_retained"
    | "retirement_positive_evidence";
  readonly inspected_views: readonly ("current" | "safe")[];
}>;

export function decideHnsTeardownRetentionV1(
  input: Readonly<{
    readonly teardown_kind: HnsTeardownKindV1;
    readonly authority: HnsRetainedAuthorityReferenceV1;
    readonly current: HnsChainObservationResultV1 | null;
    readonly safe: HnsChainObservationResultV1 | null;
    /**
     * True only for positive evidence: a fresh current and safe inspection
     * showing no reference in either view after the exposure-horizon
     * analysis. An empty safe resource plus an empty node mempool does not
     * establish transaction absence.
     */
    readonly positive_absence_evidence: boolean;
  }>,
): HnsTeardownRetentionDecisionV1 {
  const inspectedViews: ("current" | "safe")[] = [];
  for (const [view, result] of [
    ["current", input.current],
    ["safe", input.safe],
  ] as const) {
    if (result === null) {
      // Unknown or unavailable chain state retains authority pending
      // another inspection; no result is inferred from missing evidence.
      return {
        decision: "retain",
        reason: "unavailable_chain_state_retained",
        inspected_views: inspectedViews,
      };
    }
    if (result.kind === "unavailable" || result.kind === "finding") {
      return {
        decision: "retain",
        reason: "unavailable_chain_state_retained",
        inspected_views: inspectedViews,
      };
    }
    if (hnsObservationReferencesAuthorityV1(result.observation.records, input.authority)) {
      // A reference to the retained zone or plan from either view retains
      // authority.
      return {
        decision: "retain",
        reason: "chain_reference_retained",
        inspected_views: [...inspectedViews, view],
      };
    }
    inspectedViews.push(view);
  }
  if (input.positive_absence_evidence) {
    return {
      decision: "retire_eligible",
      reason: "retirement_positive_evidence",
      inspected_views: inspectedViews,
    };
  }
  // Chain absence after exposure alone is insufficient to authorize
  // deletion: the owner may broadcast the issued plan later.
  return {
    decision: "retain",
    reason: "chain_absence_after_exposure_retained",
    inspected_views: inspectedViews,
  };
}
