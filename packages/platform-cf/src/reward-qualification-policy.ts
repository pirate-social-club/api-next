import { RewardQualificationPoliciesV1 } from "@pirate/contracts";
import { Schema } from "effect";

/** NULL is historical, unbound evidence; missing/malformed columns fail decoding. */
export const decodeRewardQualificationPolicies = Schema.decodeUnknownSync(
  Schema.NullOr(RewardQualificationPoliciesV1),
);
export const decodeCurrentRewardQualificationPolicies = Schema.decodeUnknownSync(
  RewardQualificationPoliciesV1,
);
