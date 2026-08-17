import { describe, expect, test } from "bun:test";
import type { ProofProviderManifest } from "@pirate/domain/verification";
import { Effect } from "effect";
import {
  makeStaticVerificationIntentResolver,
  PLATFORM_AGE_18_VERIFICATION_INTENT_ID,
  PLATFORM_AGE_21_VERIFICATION_INTENT_ID,
  PLATFORM_VERIFICATION_RP_SCOPE,
} from "./verification-intent-resolver.ts";

const manifest: ProofProviderManifest = {
  provider_id: "provider.from-manifest",
  manifest_version: "1",
  operation_deadlines: { plan_ms: 1_000, start_ms: 1_000, complete_ms: 1_000, callback_ms: 1_000 },
  callback_mode: "none",
  callback_header_allowlist: [],
  protocol_versions: ["protocol.from-manifest"],
  environments: ["test"],
  supported_methods: ["document"],
  claim_ids: ["age.minimum", "credential.subject_unique", "document.valid"],
  claim_capabilities: [
    { claim_id: "age.minimum", request_modes: ["dynamic"] },
    { claim_id: "credential.subject_unique", request_modes: ["dynamic"] },
    { claim_id: "document.valid", request_modes: ["dynamic"] },
  ],
  presentation_kinds: ["none"],
  assurance_levels: ["document_zk"],
  subject_key_scope_semantics: "issuer_rp_scope",
};

describe("static verification intent resolver", () => {
  test("derives issuer and protocol from the provider manifest", async () => {
    const resolver = makeStaticVerificationIntentResolver([manifest], "test");
    const resolved = await Effect.runPromise(
      resolver.resolve({
        actor_id: "user-1",
        intent_id: PLATFORM_AGE_18_VERIFICATION_INTENT_ID,
        provider_id: manifest.provider_id,
      }),
    );
    expect(resolved).toEqual({
      method: "document",
      scope: {
        kind: "named",
        scope_semantics: "issuer_rp_scope",
        issuer: manifest.provider_id,
        rp_scope: PLATFORM_VERIFICATION_RP_SCOPE,
      },
      requested_requirements: [
        { claim_id: "age.minimum", minimum_age: "18" },
        { claim_id: "credential.subject_unique" },
        { claim_id: "document.valid" },
      ],
      requested_claim_ids: ["age.minimum", "credential.subject_unique", "document.valid"],
      subject_binding_intent: "establish",
      protocol_version: "protocol.from-manifest",
      environment: "test",
    });
  });

  test("keeps the second curated threshold canonical", async () => {
    const resolver = makeStaticVerificationIntentResolver([manifest], "test");
    const resolved = await Effect.runPromise(
      resolver.resolve({
        actor_id: "user-1",
        intent_id: PLATFORM_AGE_21_VERIFICATION_INTENT_ID,
        provider_id: manifest.provider_id,
      }),
    );
    expect(
      (resolved as { readonly requested_requirements: readonly unknown[] } | null)
        ?.requested_requirements[0],
    ).toEqual({
      claim_id: "age.minimum",
      minimum_age: "21",
    });
  });

  test("fails closed for unknown intents, providers, environments, and ambiguous protocols", async () => {
    const cases = [
      makeStaticVerificationIntentResolver([manifest], "production").resolve({
        actor_id: "user-1",
        intent_id: PLATFORM_AGE_18_VERIFICATION_INTENT_ID,
        provider_id: manifest.provider_id,
      }),
      makeStaticVerificationIntentResolver(
        [{ ...manifest, protocol_versions: ["v1", "v2"] }],
        "test",
      ).resolve({
        actor_id: "user-1",
        intent_id: PLATFORM_AGE_18_VERIFICATION_INTENT_ID,
        provider_id: manifest.provider_id,
      }),
      makeStaticVerificationIntentResolver([manifest], "test").resolve({
        actor_id: "user-1",
        intent_id: "community-authored",
        provider_id: manifest.provider_id,
      }),
      makeStaticVerificationIntentResolver([manifest], "test").resolve({
        actor_id: "user-1",
        intent_id: PLATFORM_AGE_18_VERIFICATION_INTENT_ID,
        provider_id: "unknown.provider",
      }),
    ];
    for (const effect of cases) expect(await Effect.runPromise(effect)).toBeNull();
  });
});
