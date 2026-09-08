import { expect } from "bun:test";
import {
  type HnsControlObservationRequestV1,
  hnsChainAuthorityDigest,
  hnsControlIdentityDigest,
  hnsControlObservationRequestHash,
} from "@pirate/application/namespace-ownership";
import type { HnsTargetObserverRuntime } from "./target-observer.ts";

const encoder = new TextEncoder();
const genesisHash = "2".repeat(64);
const anchorHash = "3".repeat(64);
export function attachmentObserverFixture(
  status: "verified" | "pending" | "rejected" | "unavailable",
  observe = () => {},
): HnsTargetObserverRuntime {
  return {
    configuration: {
      provider_id: "hns.owner.v1",
      provider_configuration_reference: "hns-owner-staging",
      provider_configuration_version: "hns-owner-config-v1",
      provider_configuration_digest: "1".repeat(64),
      environment: "staging",
      ownership_source: "hns_parent_chain_txt",
      observer_deadline_ms: 12000,
      lease_policy: {
        expected_block_interval_seconds: 600,
        minimum_safe_remaining_blocks: 144,
        expiry_safety_blocks: 144,
        evidence_lease_seconds: 2592000,
      },
    },
    observer: {
      observe: async ({ request }) => {
        observe();
        expect(request.root_label).toBe("harbor");
        return innerResult(request, status);
      },
    },
  };
}
async function innerResult(
  requestValue: HnsControlObservationRequestV1,
  status: "verified" | "pending" | "rejected" | "unavailable",
): Promise<Uint8Array> {
  const requestHash = await hnsControlObservationRequestHash(requestValue);
  const base = {
    version: "pirate-hns-control-observation-result-v1",
    observation_id: requestValue.observation_id,
    request_sha256: requestHash,
  } as const;
  if (status === "unavailable") {
    return encoder.encode(
      JSON.stringify({
        ...base,
        status: "unavailable",
        reason_code: "chain_transport_unavailable",
        retry_after_seconds: 5,
        diagnostic_ref: "hns-observer:staging:attachment-unavailable",
      }),
    );
  }
  const chainAuthorityDigest = await hnsChainAuthorityDigest({
    chain_network: "regtest",
    chain_genesis_block_hash: genesisHash,
    root_label: requestValue.root_label,
    ownership_source: requestValue.ownership_source,
    authority_records: [],
  });
  const expectedTxtValueSha256 = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(requestValue.expected_txt_value)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  if (status !== "verified") {
    return encoder.encode(
      JSON.stringify({
        ...base,
        status: "rejected",
        reason_code: status === "pending" ? "txt_absent" : "root_absent",
        provider_id: requestValue.provider_id,
        provider_configuration_reference: requestValue.provider_configuration_reference,
        provider_configuration_version: requestValue.provider_configuration_version,
        provider_configuration_digest: requestValue.provider_configuration_digest,
        environment: requestValue.environment,
        ownership_source: requestValue.ownership_source,
        root_label: requestValue.root_label,
        txt_name: requestValue.txt_name,
        expected_txt_value_sha256: expectedTxtValueSha256,
        observed_txt_values_digest: null,
        chain_authority_digest: chainAuthorityDigest,
        chain_network: "regtest",
        chain_genesis_block_hash: genesisHash,
        chain_anchor_height: 123_500,
        chain_anchor_block_hash: anchorHash,
        chain_anchor_median_time: 1_787_486_400,
        expiry_height: status === "pending" ? 200_000 : null,
        provider_evidence_ref: `hns-observer:regtest:attachment-${status}`,
      }),
    );
  }
  const controlIdentityDigest = await hnsControlIdentityDigest({
    ownership_source: requestValue.ownership_source,
    txt_name: requestValue.txt_name,
    expected_txt_value: requestValue.expected_txt_value,
    root_label: requestValue.root_label,
    chain_authority_digest: chainAuthorityDigest,
  });
  return encoder.encode(
    JSON.stringify({
      ...base,
      status: "verified",
      provider_id: requestValue.provider_id,
      provider_configuration_reference: requestValue.provider_configuration_reference,
      provider_configuration_version: requestValue.provider_configuration_version,
      provider_configuration_digest: requestValue.provider_configuration_digest,
      environment: requestValue.environment,
      ownership_source: requestValue.ownership_source,
      root_label: requestValue.root_label,
      txt_name: requestValue.txt_name,
      expected_txt_value_sha256: expectedTxtValueSha256,
      control_identity_digest: controlIdentityDigest,
      chain_authority_digest: chainAuthorityDigest,
      root_exists: true,
      root_control_verified: true,
      expiry_horizon_sufficient: true,
      chain_network: "regtest",
      chain_genesis_block_hash: genesisHash,
      chain_anchor_height: 123_500,
      chain_anchor_block_hash: anchorHash,
      chain_anchor_median_time: 1_787_486_400,
      expiry_height: 200_000,
      provider_evidence_ref: "hns-observer:regtest:attachment-verified",
    }),
  );
}
