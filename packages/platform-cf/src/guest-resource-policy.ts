import {
  GuestParticipationStoreRejected,
  type GuestResourceAdmissionPolicy,
} from "@pirate/application";
import { Schema } from "effect";

const Positive = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const Version = Schema.NonEmptyString.check(Schema.isMaxLength(128));
const Cost = Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,77}$/u));
const Policy = Schema.Struct({
  version: Version,
  costPolicyVersion: Version,
  maximumOwnerActiveSessions: Schema.Literal(2),
  maximumOwnerReservedPaidCallsPerRollingDay: Schema.Literal(60),
  maximumGlobalActiveSessions: Positive,
  maximumGlobalPaidCallsPerRollingDay: Positive,
  maximumGlobalCostMicrosPerRollingDay: Cost,
  maximumOwnerCostMicrosPerRollingDay: Cost,
  maximumTrustedEdgeSessionsPerWindow: Positive,
  trustedEdgeWindowSeconds: Positive,
  maximumProviderCallCostMicros: Cost,
});

/** Optional trusted composition input. No numerical production policy is inferred.
 * Callers must keep paid guest composition absent unless this returns a policy.
 */
export function readGuestResourceAdmissionPolicy(
  input: unknown,
): GuestResourceAdmissionPolicy | null {
  if (input === null || input === undefined) return null;
  try {
    return Schema.decodeUnknownSync(Policy, { onExcessProperty: "error" })(input);
  } catch {
    throw new GuestParticipationStoreRejected({ reason: "resource-policy-unavailable" });
  }
}
