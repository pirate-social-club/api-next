import { Schema } from "effect";
import { canonicalJson } from "../canonical-json.ts";
import { VerificationRequirements } from "../verification/requirements.ts";
import { DocumentProviderAlternatives } from "./document-provider-binding.ts";
import { sha256Hex } from "./sha256.ts";

export const ACCOUNT_AGE_18_REQUIREMENTS = Schema.decodeUnknownSync(VerificationRequirements)([
  { claim_id: "age.minimum", minimum_age: "18" },
  { claim_id: "credential.subject_unique" },
  { claim_id: "document.valid" },
]);

export const ACCOUNT_AGE_18_REQUIREMENT_HASH = sha256Hex(
  canonicalJson({
    version: "account-age-requirement-v1",
    requirements: ACCOUNT_AGE_18_REQUIREMENTS,
  }),
);

export type AccountAgeVerificationPolicy = Readonly<{
  version: "account-age-verification-v1";
  requirement_hash: string;
  policy_hash: string;
  provider_bindings: Schema.Schema.Type<typeof DocumentProviderAlternatives>;
}>;

/** Age reuses current document evidence; nationality's one-year policy is not an age lifetime. */
export function compileAccountAgeVerificationPolicy(
  bindings: unknown,
): AccountAgeVerificationPolicy | null {
  const decoded = Schema.decodeUnknownOption(DocumentProviderAlternatives, {
    onExcessProperty: "error",
  })(bindings);
  if (
    decoded._tag === "None" ||
    decoded.value.some(
      (binding) =>
        binding.scope.scope_semantics !== "issuer_rp_scope" ||
        binding.scope.rp_scope !== "pirate-social",
    )
  )
    return null;
  const [first, second] = decoded.value;
  const provider_bindings: AccountAgeVerificationPolicy["provider_bindings"] =
    first.provider_id === "self.pass" ? [first, second] : [second, first];
  const policy = {
    version: "account-age-verification-v1" as const,
    requirement_hash: ACCOUNT_AGE_18_REQUIREMENT_HASH,
    provider_bindings,
  };
  return { ...policy, policy_hash: sha256Hex(canonicalJson(policy)) };
}

export function ageVerificationReservationHash(reservation: unknown): string {
  return sha256Hex(
    canonicalJson({ reservation, version: "age-verification-ceremony-reservation-v1" }),
  );
}
