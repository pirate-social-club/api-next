import { canonicalJson } from "@pirate/domain";

/**
 * The one TypeScript builder for the readiness observation request envelope.
 *
 * The SQL encoder `encode_hns_root_readiness_observation_request_v1` derives
 * the same bytes from retained session and provision evidence, and the
 * repository's byte-for-byte test pins the two implementations together.
 * Application and service callers route through this module rather than
 * restating the field list, so the wire contract has one TypeScript owner.
 */

export const HNS_ROOT_READINESS_OBSERVATION_REQUEST_VERSION =
  "pirate-hns-root-readiness-observation-request-v1" as const;

export type HnsRootReadinessObservationRequestFieldsV1 = Readonly<{
  readonly root_import_session_id: string;
  readonly namespace_session_id: string;
  readonly root_label: string;
  readonly challenge_txt_value: string;
  readonly ownership_result_sha256: string;
  readonly publish_plan_sha256: string;
  readonly provision_result_sha256: string;
  readonly expires_at: string;
}>;

export type HnsRootReadinessObservationRequestV1 = Readonly<{
  readonly version: typeof HNS_ROOT_READINESS_OBSERVATION_REQUEST_VERSION;
}> &
  HnsRootReadinessObservationRequestFieldsV1;

export function buildHnsRootReadinessObservationRequestV1(
  input: HnsRootReadinessObservationRequestFieldsV1,
): HnsRootReadinessObservationRequestV1 {
  return {
    version: HNS_ROOT_READINESS_OBSERVATION_REQUEST_VERSION,
    root_import_session_id: input.root_import_session_id,
    namespace_session_id: input.namespace_session_id,
    root_label: input.root_label,
    challenge_txt_value: input.challenge_txt_value,
    ownership_result_sha256: input.ownership_result_sha256,
    publish_plan_sha256: input.publish_plan_sha256,
    provision_result_sha256: input.provision_result_sha256,
    expires_at: input.expires_at,
  };
}

const encoder = new TextEncoder();

export function encodeHnsRootReadinessObservationRequestV1(
  input: HnsRootReadinessObservationRequestFieldsV1,
): Uint8Array {
  return encoder.encode(canonicalJson(buildHnsRootReadinessObservationRequestV1(input)));
}
