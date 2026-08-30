import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import { AuthError, BadRequest, InternalError, ProviderUnavailable } from "./errors.ts";

export const HNS_EDGE_ALERT_TEXT_MAX_BYTES = 4_096 as const;

export const HnsEdgeAlertRequest = Schema.Struct({
  text: Schema.NonEmptyString,
});
export type HnsEdgeAlertRequest = Schema.Schema.Type<typeof HnsEdgeAlertRequest>;

export const HnsEdgeAlertAccepted = Schema.Struct({
  accepted: Schema.Literal(true),
});

export const DeliverHnsEdgeAlert = endpoint({
  method: "POST",
  path: "/internal/hns-edge-alerts",
  auth: Auth.sharedSecret("hns-edge-alert"),
  request: {
    body: HnsEdgeAlertRequest,
    bodyRequired: true,
    bodyEncoding: "exact-json",
    // A 4 KiB text member can expand under JSON escaping; the use case applies
    // the authoritative UTF-8 text limit after closed-contract decoding.
    maxBodyBytes: 32 * 1_024,
  },
  response: HnsEdgeAlertAccepted,
  successStatus: 202,
  errors: [AuthError, BadRequest, ProviderUnavailable, InternalError],
});
