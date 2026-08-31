import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import { AuthError, BadRequest, Conflict, InternalError, ProviderUnavailable } from "./errors.ts";

export const HNS_EDGE_STATUS_REPORT_VERSION = "pirate-hns-edge-status-v1" as const;
export const HNS_EDGE_STATUS_OBSERVER_ID = "pirate-hns-primary-vps-v1" as const;
export const HNS_EDGE_STATUS_ROOT = "jazleeuw" as const;
export const HNS_EDGE_STATUS_RRSIG_THRESHOLD_SECONDS = 7 * 24 * 60 * 60;
export const HNS_EDGE_STATUS_HEARTBEAT_STALE_SECONDS = 2 * 60 * 60;
export const HNS_EDGE_STATUS_FUTURE_SKEW_SECONDS = 5 * 60;
export const HNS_EDGE_STATUS_MAX_REPORT_AGE_SECONDS = 6 * 60 * 60;
export const HNS_EDGE_STATUS_MAX_BODY_BYTES = 8 * 1_024;

const UnixSeconds = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const RemainingSeconds = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 366 * 24 * 60 * 60 }),
);
const DnsSerial = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4_294_967_295 }));
const HttpStatus = Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }));
const Sha256Hex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const FailedUnit = Schema.String.check(
  Schema.isMaxLength(256),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9@_.:-]*$/u),
);

export const HnsEdgeRrsigMarginsV1 = Schema.Struct({
  dnskey: RemainingSeconds,
  soa: RemainingSeconds,
  app_a: RemainingSeconds,
  app_tlsa: RemainingSeconds,
  wildcard_tlsa: RemainingSeconds,
});

export const HnsEdgeAuthorityViewV1 = Schema.Struct({
  view_id: Schema.Literals(["primary", "secondary"]),
  zone_serial: DnsSerial,
  rrsig_remaining_seconds: HnsEdgeRrsigMarginsV1,
});

export const HnsEdgeStatusReportV1 = Schema.Struct({
  version: Schema.Literal(HNS_EDGE_STATUS_REPORT_VERSION),
  observer_id: Schema.Literal(HNS_EDGE_STATUS_OBSERVER_ID),
  root: Schema.Literal(HNS_EDGE_STATUS_ROOT),
  observed_at_unix_seconds: UnixSeconds,
  authority_views: Schema.Tuple([HnsEdgeAuthorityViewV1, HnsEdgeAuthorityViewV1]),
  app: Schema.Struct({
    certificate_not_after_unix_seconds: UnixSeconds,
    served_spki_sha256: Sha256Hex,
    primary_tlsa_spki_sha256: Sha256Hex,
    secondary_tlsa_spki_sha256: Sha256Hex,
    http_status: HttpStatus,
  }),
  failed_units: Schema.Array(FailedUnit).check(Schema.isMaxLength(32)),
});
export type HnsEdgeStatusReportV1 = Schema.Schema.Type<typeof HnsEdgeStatusReportV1>;

export const HnsEdgeStatusReportAcceptedV1 = Schema.Struct({
  accepted: Schema.Literal(true),
  observed_at_unix_seconds: UnixSeconds,
});

export const PublishHnsEdgeStatusReport = endpoint({
  method: "POST",
  path: "/internal/hns-edge-status",
  auth: Auth.sharedSecret("hns-edge-status"),
  request: {
    body: HnsEdgeStatusReportV1,
    bodyRequired: true,
    maxBodyBytes: HNS_EDGE_STATUS_MAX_BODY_BYTES,
  },
  response: HnsEdgeStatusReportAcceptedV1,
  successStatus: 202,
  errors: [AuthError, BadRequest, Conflict, ProviderUnavailable, InternalError],
});
