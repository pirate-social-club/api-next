import { Schema } from "effect";

export const DANCE_NETWORK_DAY_MS = 86_400_000;
export const DANCE_NETWORK_DAILY_LIMIT = 120;
export const DanceNetworkAdmissionRequest = Schema.Struct({
  bucketName: Schema.String.check(
    Schema.isPattern(/^dance-network-v1:[1-9][0-9]{0,7}:[a-f0-9]{64}$/u),
  ),
  commandDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});
export const DanceNetworkAdmissionDecision = Schema.Union([
  Schema.Struct({ allowed: Schema.Literal(true), retryAfterSeconds: Schema.Literal(0) }),
  Schema.Struct({
    allowed: Schema.Literal(false),
    retryAfterSeconds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 86_400 })),
  }),
]);
export type DanceNetworkAdmissionDecision = typeof DanceNetworkAdmissionDecision.Type;
