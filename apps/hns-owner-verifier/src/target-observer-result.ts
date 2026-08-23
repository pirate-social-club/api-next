import {
  decodeHnsControlObservationResultBytes,
  type HnsControlObservationRejectedReason,
  type HnsControlObservationRequestV1,
  type HnsControlObservationResultV1,
  type HnsControlObservationUnavailableReason,
  type HnsControlObserverTranscriptEntryV1,
} from "@pirate/application/namespace-ownership";

export type HnsTargetObserverSha256 =
  HnsControlObservationRequestV1["provider_configuration_digest"];

export type HnsTargetObserverExecutionResult = Readonly<{
  readonly result_bytes: Uint8Array;
  readonly result_sha256: HnsTargetObserverSha256;
  readonly result_status: "verified" | "rejected" | "unavailable";
  readonly result_reference_kind: "provider_evidence_ref" | "diagnostic_ref";
  readonly semantic_facts_bytes: Uint8Array;
  readonly transcript: ReadonlyArray<HnsControlObserverTranscriptEntryV1>;
}>;

export type HnsTargetObserverChainFacts = Readonly<{
  readonly network: string;
  readonly best_block_hash: HnsTargetObserverSha256;
  readonly height: number;
  readonly median_time: number;
}>;

export function makeHnsUnavailableControlResult(input: {
  readonly request: HnsControlObservationRequestV1;
  readonly request_sha256: HnsTargetObserverSha256;
  readonly reason: HnsControlObservationUnavailableReason;
  readonly snapshot_reference: string;
}): HnsControlObservationResultV1 {
  return {
    version: "pirate-hns-control-observation-result-v1",
    observation_id: input.request.observation_id,
    request_sha256: input.request_sha256,
    status: "unavailable",
    reason_code: input.reason,
    retry_after_seconds: null,
    diagnostic_ref: input.snapshot_reference,
  };
}

export function makeHnsRejectedControlResult(input: {
  readonly request: HnsControlObservationRequestV1;
  readonly request_sha256: HnsTargetObserverSha256;
  readonly reason: HnsControlObservationRejectedReason;
  readonly expected_txt_value_sha256: HnsTargetObserverSha256;
  readonly observed_txt_values_digest: HnsTargetObserverSha256 | null;
  readonly chain_authority_digest: HnsTargetObserverSha256;
  readonly chain_anchor: HnsTargetObserverChainFacts;
  readonly chain_genesis_block_hash: HnsTargetObserverSha256;
  readonly expiry_height: number | null;
  readonly snapshot_reference: string;
}): HnsControlObservationResultV1 {
  return {
    version: "pirate-hns-control-observation-result-v1",
    observation_id: input.request.observation_id,
    request_sha256: input.request_sha256,
    status: "rejected",
    reason_code: input.reason,
    provider_id: input.request.provider_id,
    provider_configuration_reference: input.request.provider_configuration_reference,
    provider_configuration_version: input.request.provider_configuration_version,
    provider_configuration_digest: input.request.provider_configuration_digest,
    environment: input.request.environment,
    ownership_source: input.request.ownership_source,
    root_label: input.request.root_label,
    txt_name: input.request.txt_name,
    expected_txt_value_sha256: input.expected_txt_value_sha256,
    observed_txt_values_digest: input.observed_txt_values_digest,
    chain_authority_digest: input.chain_authority_digest,
    chain_network: input.chain_anchor.network,
    chain_genesis_block_hash: input.chain_genesis_block_hash,
    chain_anchor_height: input.chain_anchor.height,
    chain_anchor_block_hash: input.chain_anchor.best_block_hash,
    chain_anchor_median_time: input.chain_anchor.median_time,
    expiry_height: input.expiry_height,
    provider_evidence_ref: input.snapshot_reference,
  };
}

export function makeHnsVerifiedControlResult(input: {
  readonly request: HnsControlObservationRequestV1;
  readonly request_sha256: HnsTargetObserverSha256;
  readonly expected_txt_value_sha256: HnsTargetObserverSha256;
  readonly control_identity_digest: HnsTargetObserverSha256;
  readonly chain_authority_digest: HnsTargetObserverSha256;
  readonly chain_anchor: HnsTargetObserverChainFacts;
  readonly chain_genesis_block_hash: HnsTargetObserverSha256;
  readonly expiry_height: number;
  readonly snapshot_reference: string;
}): HnsControlObservationResultV1 {
  return {
    version: "pirate-hns-control-observation-result-v1",
    observation_id: input.request.observation_id,
    request_sha256: input.request_sha256,
    status: "verified",
    provider_id: input.request.provider_id,
    provider_configuration_reference: input.request.provider_configuration_reference,
    provider_configuration_version: input.request.provider_configuration_version,
    provider_configuration_digest: input.request.provider_configuration_digest,
    environment: input.request.environment,
    ownership_source: input.request.ownership_source,
    root_label: input.request.root_label,
    txt_name: input.request.txt_name,
    expected_txt_value_sha256: input.expected_txt_value_sha256,
    control_identity_digest: input.control_identity_digest,
    chain_authority_digest: input.chain_authority_digest,
    root_exists: true,
    root_control_verified: true,
    expiry_horizon_sufficient: true,
    chain_network: input.chain_anchor.network,
    chain_genesis_block_hash: input.chain_genesis_block_hash,
    chain_anchor_height: input.chain_anchor.height,
    chain_anchor_block_hash: input.chain_anchor.best_block_hash,
    chain_anchor_median_time: input.chain_anchor.median_time,
    expiry_height: input.expiry_height,
    provider_evidence_ref: input.snapshot_reference,
  };
}

export async function finalizeHnsControlObserverResult(input: {
  readonly request: HnsControlObservationRequestV1;
  readonly result: HnsControlObservationResultV1;
  readonly transcript: ReadonlyArray<HnsControlObserverTranscriptEntryV1>;
  readonly semantic_facts_bytes: Uint8Array | null;
  readonly signal: AbortSignal;
  readonly abort_error: (message: string) => Error;
}): Promise<HnsTargetObserverExecutionResult> {
  if (input.signal.aborted) {
    throw input.abort_error("HNS control result finalization started after abort");
  }
  const bytes = new TextEncoder().encode(JSON.stringify(input.result));
  const decoded = await decodeHnsControlObservationResultBytes(bytes, input.request);
  if (input.signal.aborted) {
    throw input.abort_error("HNS control result finalization completed after abort");
  }
  return {
    result_bytes: decoded.result_bytes,
    result_sha256: decoded.result_sha256,
    result_status: decoded.result.status,
    result_reference_kind:
      decoded.result.status === "unavailable" ? "diagnostic_ref" : "provider_evidence_ref",
    semantic_facts_bytes:
      input.semantic_facts_bytes === null
        ? new Uint8Array(decoded.result_bytes)
        : new Uint8Array(input.semantic_facts_bytes),
    transcript: input.transcript,
  };
}
