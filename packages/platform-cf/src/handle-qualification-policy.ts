import type { HandleQualificationPolicyRefV2 } from "@pirate/contracts";
import { handleNationalityQualificationRefFromPolicy, NationalityPolicy } from "@pirate/domain";
import { Schema } from "effect";
import { integer, type Row, text } from "./handle-sales-internals.ts";

/** Shared row decoding for authoring replay and the quote/claim qualification lookup. */
export function handleNationalityPolicyFromRow(row: Row): NationalityPolicy {
  const policy = Schema.decodeUnknownSync(NationalityPolicy, { onExcessProperty: "error" })(
    row.nationality_policy,
  );
  if (
    text(row, "policy_kind") !== "curated_nationality_v1" ||
    text(row, "policy_hash") !== policy.policy_hash ||
    integer(row, "policy_revision") !== policy.policy_revision ||
    policy.evidence_lifetime.kind !== "max_age_seconds"
  )
    throw new Error("Invalid nationality policy row");
  return policy;
}

export function handleQualificationPolicyRefFromRow(row: Row): HandleQualificationPolicyRefV2 {
  const identity = {
    policy_id: text(row, "policy_id"),
    policy_revision: integer(row, "policy_revision"),
    policy_hash: text(row, "policy_hash"),
  };
  switch (text(row, "policy_kind")) {
    case "none_v1":
      return { kind: "none_v1", ...identity };
    case "curated_policy_v1":
      return {
        kind: "curated_policy_v1",
        ...identity,
        provider_binding_hash: text(row, "provider_binding_hash"),
      };
    case "curated_nationality_v1":
      return handleNationalityQualificationRefFromPolicy(
        identity.policy_id,
        handleNationalityPolicyFromRow(row),
      );
    default:
      throw new Error("Invalid qualification policy kind");
  }
}
