import { describe, expect, test } from "bun:test";
import { canonicalJson } from "@pirate/domain";
import {
  buildHnsRootReadinessObservationRequestV1,
  encodeHnsRootReadinessObservationRequestV1,
  HNS_ROOT_READINESS_OBSERVATION_REQUEST_VERSION,
  type HnsRootReadinessObservationRequestFieldsV1,
} from "./hns-readiness-observation-request.ts";

const fields: HnsRootReadinessObservationRequestFieldsV1 = {
  root_import_session_id: "root-import-session",
  namespace_session_id: "namespace-session",
  root_label: "newroot",
  challenge_txt_value: "pirate-verification=newroot",
  ownership_result_sha256: "a".repeat(64),
  publish_plan_sha256: "b".repeat(64),
  provision_result_sha256: "c".repeat(64),
  expires_at: "2099-01-01T00:00:00.000Z",
};

describe("HNS readiness observation request envelope", () => {
  test("the shared builder owns the wire version and field list", () => {
    expect(buildHnsRootReadinessObservationRequestV1(fields)).toEqual({
      version: HNS_ROOT_READINESS_OBSERVATION_REQUEST_VERSION,
      ...fields,
    });
  });

  test("the encoder emits the canonical JSON bytes", () => {
    const encoded = encodeHnsRootReadinessObservationRequestV1(fields);
    const canonical = canonicalJson(buildHnsRootReadinessObservationRequestV1(fields));
    expect(Buffer.from(encoded).toString("utf8")).toBe(canonical);
  });

  test("field declaration order does not change the bytes", () => {
    const reordered: HnsRootReadinessObservationRequestFieldsV1 = {
      expires_at: fields.expires_at,
      provision_result_sha256: fields.provision_result_sha256,
      publish_plan_sha256: fields.publish_plan_sha256,
      ownership_result_sha256: fields.ownership_result_sha256,
      challenge_txt_value: fields.challenge_txt_value,
      root_label: fields.root_label,
      namespace_session_id: fields.namespace_session_id,
      root_import_session_id: fields.root_import_session_id,
    };
    expect(encodeHnsRootReadinessObservationRequestV1(reordered)).toEqual(
      encodeHnsRootReadinessObservationRequestV1(fields),
    );
  });
});
