import { describe, expect, test } from "bun:test";
import type { HnsChainObservationResultV1 } from "./hns-chain-observation.ts";
import {
  classifyHnsRecoveryEvidenceV1,
  type HnsRecoveryEvidenceV1,
  type HnsRecoveryReasonV1,
  hnsRecoveryEvidenceRefV1,
} from "./hns-incident-recovery.ts";
import type { HnsRootResourceRecordV1 } from "./hns-root-import-plan.ts";
import type { HnsRetainedAuthorityReferenceV1 } from "./hns-teardown-retention.ts";

/**
 * What recovery may conclude is bounded by what was read.
 *
 * These assert the boundary in both directions: a positive classification
 * requires every input it rests on, and a missing input produces
 * `insufficient_evidence` with the reason naming what was missing rather than a
 * negative finding about the name.
 */

const planDigest = "1".repeat(64);
const otherDigest = "2".repeat(64);

const authority: HnsRetainedAuthorityReferenceV1 = {
  ns_names: ["ns1.pirate.", "ns2.pirate."],
  ds: [{ key_tag: 12_345, algorithm: 13, digest_type: 2, digest: "ab".repeat(32) }],
  challenge_txt_value: "pirate-verification=incident",
};

const planRecords: readonly HnsRootResourceRecordV1[] = [
  { type: "NS", ns: "ns1.pirate." },
  { type: "NS", ns: "ns2.pirate." },
] as never;

function observed(view: "current" | "safe", height = 3_301): HnsChainObservationResultV1 {
  return {
    kind: "observed",
    observation: {
      view,
      network: "regtest",
      genesis_block_hash: `${"0".repeat(63)}1`,
      anchor: {
        network: "regtest",
        genesis_block_hash: `${"0".repeat(63)}1`,
        height,
        best_block_hash: "bb".repeat(32),
        median_time_past_epoch_seconds: 1_789_000_000,
        header_time_epoch_seconds: 1_789_000_030,
        confirmations: 1,
      },
      tip_height: height,
      update_inclusion_height: null,
      commitment: null,
      observed_at_epoch_ms: 1_789_000_060_000,
      records: planRecords,
      resource_sha256: `${"0".repeat(63)}${view === "current" ? "1" : "2"}`,
    },
  };
}

const absent = (): HnsChainObservationResultV1 => ({
  kind: "finding",
  classification: "resource_absent",
  anchor: {
    network: "regtest",
    genesis_block_hash: `${"0".repeat(63)}1`,
    height: 3_301,
    best_block_hash: "bb".repeat(32),
    median_time_past_epoch_seconds: 1_789_000_000,
    header_time_epoch_seconds: 1_789_000_030,
    confirmations: 1,
  },
  observed_at_epoch_ms: 1_789_000_060_000,
});

const unavailable = (): HnsChainObservationResultV1 => ({
  kind: "unavailable",
  classification: "node_unavailable",
});

const inclusion = (digest: string) => ({
  txid: "56e942fafae53a21".padEnd(64, "0"),
  output_index: 0,
  block_hash: "0db3146ef927b8b3".padEnd(64, "0"),
  block_height: 3_301,
  confirmations: 1,
  covenant_action: "UPDATE",
  covenant_resource_sha256: digest,
});

function evidence(overrides: Partial<HnsRecoveryEvidenceV1> = {}): HnsRecoveryEvidenceV1 {
  return {
    inclusion: inclusion(planDigest),
    decoded_resource: planRecords,
    retained_plan_encoded_sha256: planDigest,
    retained_authority: authority,
    current: observed("current"),
    safe: observed("safe"),
    zone: { zone_present: true, signing_keys_present: true },
    ...overrides,
  };
}

describe("incident recovery classification", () => {
  test("a published resource whose covenant bytes match the plan supports resuming", () => {
    const finding = classifyHnsRecoveryEvidenceV1(evidence());
    expect(finding.classification).toBe("matching_authority_available");
    expect(finding.reason).toBe("published_resource_matches_plan");
    expect(finding.supported_action).toBe("resume");
    expect(finding.inspected_views).toEqual(["current", "safe"]);
  });

  test("a resource that differs but still delegates to the authority is adopted, not a conflict", () => {
    // The owner kept our nameservers and published more besides. That is their
    // resource to shape; treating it as a conflict would fight the owner.
    const finding = classifyHnsRecoveryEvidenceV1(
      evidence({
        inclusion: inclusion(otherDigest),
        decoded_resource: [
          { type: "NS", ns: "NS1.Pirate" },
          { type: "TXT", txt: ["something the owner added"] },
        ] as never,
      }),
    );
    expect(finding.classification).toBe("matching_authority_available");
    expect(finding.reason).toBe("published_resource_references_authority");
    // Adopt rather than resume: what is published is not what the plan
    // specified, so the operation must bind to what is actually there.
    expect(finding.supported_action).toBe("adopt");
  });

  test("a resource that neither matches nor delegates to us is a conflicting publication", () => {
    const finding = classifyHnsRecoveryEvidenceV1(
      evidence({
        inclusion: inclusion(otherDigest),
        decoded_resource: [{ type: "NS", ns: "ns1.someone-else." }] as never,
      }),
    );
    expect(finding.classification).toBe("conflicting_publication");
    expect(finding.reason).toBe("published_resource_replaces_authority");
    // Nothing is supported: resuming would fight a name somebody else serves.
    expect(finding.supported_action).toBeNull();
  });

  test("a missing zone or missing keys is recoverable, and says which", () => {
    const missingZone = classifyHnsRecoveryEvidenceV1(
      evidence({ zone: { zone_present: false, signing_keys_present: false } }),
    );
    expect(missingZone.classification).toBe("recoverable_authority_missing");
    expect(missingZone.reason).toBe("zone_missing");
    expect(missingZone.supported_action).toBe("restore_authority");

    const missingKeys = classifyHnsRecoveryEvidenceV1(
      evidence({ zone: { zone_present: true, signing_keys_present: false } }),
    );
    expect(missingKeys.reason).toBe("signing_keys_missing");
    expect(missingKeys.supported_action).toBe("restore_authority");
  });

  test("nothing published with the authority intact supports resuming", () => {
    const finding = classifyHnsRecoveryEvidenceV1(
      evidence({ current: absent(), safe: absent(), inclusion: null, decoded_resource: null }),
    );
    expect(finding.classification).toBe("matching_authority_available");
    expect(finding.reason).toBe("authority_intact_no_publication");
    expect(finding.supported_action).toBe("resume");
  });

  test("nothing published with the authority gone is recoverable, not resumable", () => {
    const finding = classifyHnsRecoveryEvidenceV1(
      evidence({
        current: absent(),
        safe: absent(),
        inclusion: null,
        decoded_resource: null,
        zone: { zone_present: false, signing_keys_present: false },
      }),
    );
    expect(finding.classification).toBe("recoverable_authority_missing");
    expect(finding.supported_action).toBe("restore_authority");
  });

  test("every missing input is insufficient evidence, named, and supports nothing", () => {
    const cases: readonly [Partial<HnsRecoveryEvidenceV1>, HnsRecoveryReasonV1][] = [
      [{ retained_plan_encoded_sha256: null }, "retained_plan_digest_unknown"],
      [{ retained_authority: null }, "retained_plan_digest_unknown"],
      [{ current: unavailable() }, "chain_state_unavailable"],
      [{ safe: unavailable() }, "chain_state_unavailable"],
      [{ current: null }, "chain_state_unavailable"],
      [{ zone: null }, "provider_availability_unknown"],
      [{ inclusion: null }, "inclusion_unresolved"],
      [{ decoded_resource: null }, "chain_state_unavailable"],
    ];
    for (const [overrides, reason] of cases) {
      const finding = classifyHnsRecoveryEvidenceV1(evidence(overrides));
      expect(finding.classification).toBe("insufficient_evidence");
      expect(finding.reason).toBe(reason);
      expect(finding.supported_action).toBeNull();
    }
  });

  test("an unresolved inclusion for a published name is insufficient, never a conflict", () => {
    // Not knowing which transaction published a resource is not evidence that
    // somebody else did. This is the case that would otherwise authorize
    // acting against a name whose publication we simply failed to read.
    const finding = classifyHnsRecoveryEvidenceV1(
      evidence({ inclusion: null, decoded_resource: [{ type: "NS", ns: "ns1.other." }] as never }),
    );
    expect(finding.classification).toBe("insufficient_evidence");
    expect(finding.reason).toBe("inclusion_unresolved");
  });

  test("the evidence reference is stable per reading and changes when the reading does", () => {
    const base = evidence();
    expect(hnsRecoveryEvidenceRefV1(base)).toBe(hnsRecoveryEvidenceRefV1(evidence()));
    expect(hnsRecoveryEvidenceRefV1(evidence({ inclusion: inclusion(otherDigest) }))).toBe(
      hnsRecoveryEvidenceRefV1(base),
    );
    // A different block, a different tip, or different provider availability
    // are all different readings and must not replay as the same one.
    expect(
      hnsRecoveryEvidenceRefV1(
        evidence({ inclusion: { ...inclusion(planDigest), block_height: 3_302 } }),
      ),
    ).not.toBe(hnsRecoveryEvidenceRefV1(base));
    expect(hnsRecoveryEvidenceRefV1(evidence({ current: observed("current", 3_400) }))).not.toBe(
      hnsRecoveryEvidenceRefV1(base),
    );
    expect(
      hnsRecoveryEvidenceRefV1(
        evidence({ zone: { zone_present: true, signing_keys_present: false } }),
      ),
    ).not.toBe(hnsRecoveryEvidenceRefV1(base));
  });
});
