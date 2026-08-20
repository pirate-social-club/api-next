import type { VerificationIntentResolver } from "@pirate/application/use-cases/verification-start";
import {
  type ProofProviderManifest,
  VerificationRequirements,
  verificationRequirementClaimIds,
} from "@pirate/domain/verification";
import { Effect, Schema } from "effect";

export const PLATFORM_AGE_18_VERIFICATION_INTENT_ID = "platform.document.age-18";
export const PLATFORM_AGE_21_VERIFICATION_INTENT_ID = "platform.document.age-21";
export const PLATFORM_VERIFICATION_RP_SCOPE = "pirate-social";

/** First non-null trusted intent wins; storage failures never fall through. */
export function makeOrderedVerificationIntentResolver(
  resolvers: readonly VerificationIntentResolver[],
): VerificationIntentResolver {
  return {
    resolve: (input) =>
      Effect.gen(function* () {
        for (const resolver of resolvers) {
          const resolved = yield* resolver.resolve(input);
          if (resolved !== null && resolved !== undefined) return resolved;
        }
        return null;
      }),
  };
}

const AGE_18_REQUIREMENTS = Schema.decodeUnknownSync(VerificationRequirements)([
  { claim_id: "age.minimum", minimum_age: "18" },
  { claim_id: "credential.subject_unique" },
  { claim_id: "document.valid" },
]);

const AGE_21_REQUIREMENTS = Schema.decodeUnknownSync(VerificationRequirements)([
  { claim_id: "age.minimum", minimum_age: "21" },
  { claim_id: "credential.subject_unique" },
  { claim_id: "document.valid" },
]);

const INTENTS = new Map([
  [PLATFORM_AGE_18_VERIFICATION_INTENT_ID, AGE_18_REQUIREMENTS],
  [PLATFORM_AGE_21_VERIFICATION_INTENT_ID, AGE_21_REQUIREMENTS],
]);

/**
 * Small trusted bridge until policy-authored intent persistence lands. The
 * catalog contains canonical requirements only; provider identity and
 * protocol are derived from the registered manifest at resolution time.
 */
export function makeStaticVerificationIntentResolver(
  manifests: readonly ProofProviderManifest[],
  environment: string,
): VerificationIntentResolver {
  const byProvider = new Map(manifests.map((manifest) => [manifest.provider_id, manifest]));
  return {
    resolve: ({ intent_id, provider_id }) => {
      const requirements = INTENTS.get(intent_id);
      const manifest = byProvider.get(provider_id);
      const protocolVersion = manifest?.protocol_versions[0];
      if (
        requirements === undefined ||
        manifest === undefined ||
        manifest.protocol_versions.length !== 1 ||
        protocolVersion === undefined ||
        !manifest.environments.includes(environment) ||
        !manifest.supported_methods.includes("document") ||
        manifest.subject_key_scope_semantics !== "issuer_rp_scope"
      ) {
        return Effect.succeed(null);
      }
      return Effect.succeed({
        method: "document",
        scope: {
          kind: "named" as const,
          scope_semantics: "issuer_rp_scope" as const,
          issuer: manifest.provider_id,
          rp_scope: PLATFORM_VERIFICATION_RP_SCOPE,
        },
        requested_requirements: requirements,
        requested_claim_ids: verificationRequirementClaimIds(requirements),
        subject_binding_intent: "establish" as const,
        protocol_version: protocolVersion,
        environment,
      });
    },
  };
}
