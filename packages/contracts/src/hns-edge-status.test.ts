import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  HNS_EDGE_STATUS_MAX_BODY_BYTES,
  type HnsEdgeStatusReportV1 as HnsEdgeStatusReport,
  HnsEdgeStatusReportV1,
  PublishHnsEdgeStatusReport,
} from "./hns-edge-status.ts";

const valid: HnsEdgeStatusReport = {
  version: "pirate-hns-edge-status-v1",
  observer_id: "pirate-hns-primary-vps-v1",
  root: "jazleeuw",
  observed_at_unix_seconds: 1_800_000_000,
  authority_views: [
    {
      view_id: "primary",
      zone_serial: 2_026_080_805,
      rrsig_remaining_seconds: {
        dnskey: 900_000,
        soa: 900_000,
        app_a: 900_000,
        app_tlsa: 900_000,
        wildcard_tlsa: 900_000,
      },
    },
    {
      view_id: "secondary",
      zone_serial: 2_026_080_805,
      rrsig_remaining_seconds: {
        dnskey: 900_000,
        soa: 900_000,
        app_a: 900_000,
        app_tlsa: 900_000,
        wildcard_tlsa: 900_000,
      },
    },
  ],
  app: {
    certificate_not_after_unix_seconds: 1_802_592_000,
    served_spki_sha256: "a".repeat(64),
    primary_tlsa_spki_sha256: "a".repeat(64),
    secondary_tlsa_spki_sha256: "a".repeat(64),
    http_status: 421,
  },
  failed_units: [],
};

describe("HNS edge status contract", () => {
  test("publishes one exact bounded shared-secret report", () => {
    expect(PublishHnsEdgeStatusReport).toMatchObject({
      method: "POST",
      path: "/internal/hns-edge-status",
      auth: { policy: { kind: "sharedSecret", name: "hns-edge-status" } },
      successStatus: 202,
    });
    expect(PublishHnsEdgeStatusReport.request.maxBodyBytes).toBe(HNS_EDGE_STATUS_MAX_BODY_BYTES);
    expect(Schema.decodeUnknownSync(HnsEdgeStatusReportV1)(valid)).toEqual(valid);
  });

  test("refuses unknown fields and unbounded unit names", () => {
    const decode = Schema.decodeUnknownSync(HnsEdgeStatusReportV1, {
      onExcessProperty: "error",
    });
    expect(() => decode({ ...valid, healthy: true })).toThrow();
    expect(() => decode({ ...valid, failed_units: ["unit with spaces"] })).toThrow();
  });
});
