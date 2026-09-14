import {
  makeVerificationProviderRegistry,
  startVerification,
  type VerificationIntentResolver,
  type VerificationProviderAdapter,
  type VerificationSessionStartStore,
} from "@pirate/application/verification";
import type { NationalityPolicy } from "@pirate/domain";
import { Effect } from "effect";

/** Nationality and age use these deterministic local document provider adapters with the real generic start service
 * and PostgreSQL reservation/finalization store. No external proof is claimed.
 */
export async function startNationalityFixture(
  store: VerificationSessionStartStore,
  intents: VerificationIntentResolver,
  policy: Pick<NationalityPolicy, "provider_bindings">,
  input: Readonly<{ actor_id: string; intent_id: string; provider_id: "self.pass" | "zkpassport" }>,
  claims: readonly (
    | "nationality.allowed"
    | "age.minimum"
    | "credential.subject_unique"
    | "document.valid"
  )[] = ["nationality.allowed"],
) {
  const adapters: VerificationProviderAdapter[] = policy.provider_bindings.map((binding) => ({
    manifest: {
      provider_id: binding.provider_id,
      manifest_version: "1",
      operation_deadlines: { plan_ms: 1000, start_ms: 5000, complete_ms: 5000, callback_ms: 5000 },
      callback_mode: "none",
      callback_header_allowlist: [],
      protocol_versions: [binding.protocol_version],
      environments: [binding.environment],
      supported_methods: ["document"],
      claim_ids: claims,
      claim_capabilities: claims.map((claim_id) => ({
        claim_id,
        request_modes: ["dynamic"] as const,
      })),
      presentation_kinds: ["redirect"],
      assurance_levels: ["document_zk"],
      subject_key_scope_semantics: "issuer_rp_scope",
    },
    plan: () =>
      Effect.succeed({
        status: "supported" as const,
        request_mode: "dynamic" as const,
        provider_configuration: binding.provider_configuration,
      }),
    start: (start) => {
      const { verification_purpose: _purpose, ...sessionFields } = start;
      const id = `proof-document-start_${crypto.randomUUID()}`;
      return Effect.succeed({
        session: {
          ...sessionFields,
          id,
          provider_id: binding.provider_id,
          status: "pending" as const,
          started_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
        presentation: {
          kind: "redirect" as const,
          session_id: id,
          url: "https://example.invalid/verify",
        },
      });
    },
    complete: () => Effect.die("Completion is explicitly seeded by the consuming PostgreSQL proof"),
  }));
  const registry = await Effect.runPromise(
    makeVerificationProviderRegistry(adapters, { now: Date.now }),
  );
  return Effect.runPromise(
    Effect.scoped(
      startVerification(input, {
        registry,
        intents,
        store,
      }),
    ),
  );
}
