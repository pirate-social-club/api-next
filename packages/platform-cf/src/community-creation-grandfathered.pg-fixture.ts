import type { CommunityCreationIntentDocument, CommunityCreationStore } from "@pirate/application";
import {
  COMMUNITY_CREATION_CEREMONY_RESERVATION_VERSION,
  communityCreationCeremonyReservationHash,
  communityCreationProviderBindingHash,
  compileCommunityGatePolicy,
} from "@pirate/domain";
import { Effect } from "effect";
import type { Client } from "pg";

export type GrandfatheredCreationDraft = Readonly<{
  /** Creation persona choice (spec 014 section 10.2): existing or create_new. */
  readonly persona: Readonly<
    { readonly kind: "existing"; readonly persona_id: string } | { readonly kind: "create_new" }
  >;
  readonly name: string;
  readonly description: string | null;
  readonly policy: unknown;
}>;

/**
 * Seeds a pre-amendment optional-route creation intent: creator verification
 * authority on the intent, one pending `human_identity` requirement row, and
 * its reserved ceremony attempt. The store no longer produces this shape, but
 * intents that already held it at the amendment boundary stay grandfathered.
 */
export async function seedGrandfatheredCreationIntent(
  admin: Client,
  store: CommunityCreationStore["Service"],
  input: Readonly<{
    readonly intentId: string;
    readonly ceremonyIntentId?: string;
    readonly actorId: string;
    readonly requestHash: string;
    readonly idempotencyKey: string;
    readonly draft: GrandfatheredCreationDraft;
    readonly ttlSeconds?: number;
  }>,
): Promise<CommunityCreationIntentDocument> {
  const compilation = compileCommunityGatePolicy(input.draft.policy);
  if (compilation.kind !== "supported") {
    throw new Error("grandfathered fixture requires a supported member policy");
  }
  const binding = compilation.provider_binding;
  const providerBindingHash = communityCreationProviderBindingHash({
    requirement: "human_identity",
    family: null,
    provider_id: binding.provider_id,
    provider_configuration: binding.provider_configuration,
    protocol_version: binding.protocol_version,
  });
  const ceremonyIntentId = input.ceremonyIntentId ?? `${input.intentId}-ceremony-1`;
  const reservation = {
    actor_id: input.actorId,
    creation_intent_id: input.intentId,
    ceremony_intent_id: ceremonyIntentId,
    requirement: "human_identity" as const,
    generation: 1,
    requirement_hash: compilation.verification_requirement_hash,
    provider_id: binding.provider_id,
    provider_binding_hash: providerBindingHash,
    route: null,
  };
  const reservationHash = communityCreationCeremonyReservationHash(reservation);
  const ttlSeconds = input.ttlSeconds ?? 86_400;

  await admin.query("BEGIN");
  try {
    await admin.query({
      text: `INSERT INTO community_creation_intents (
               intent_id, actor_id, create_idempotency_key, create_request_hash,
               revision, status, draft, canonical_policy_revision, canonical_policy_hash,
               verification_requirement_hash, verification_provider_id,
               provider_configuration_kind, provider_configuration_ref,
               provider_configuration_version, expires_at, creation_contract_version
             ) VALUES (
               $1, $2, $3, $4, 1, 'verification_required', $5::jsonb, 1, $6, $7, $8, $9, $10, $11,
               clock_timestamp() + ($12::integer * interval '1 second'), 'optional_route_v2'
             )`,
      values: [
        input.intentId,
        input.actorId,
        input.idempotencyKey,
        input.requestHash,
        JSON.stringify(input.draft),
        compilation.canonical_policy_hash,
        compilation.verification_requirement_hash,
        binding.provider_id,
        binding.provider_configuration.kind,
        binding.provider_configuration.reference,
        binding.provider_configuration.version,
        ttlSeconds,
      ],
    });
    await admin.query({
      text: `INSERT INTO community_creation_requirement_states (
               intent_id, actor_id, requirement_kind, status, requirement_hash, provider_id,
               provider_binding_hash, provider_configuration_kind, provider_configuration_ref,
               provider_configuration_version, route_family, route_root_label,
               route_root_label_display, route_path_segment, generation,
               current_ceremony_intent_id
             ) VALUES ($1, $2, 'human_identity', 'unmet', $3, $4, $5, $6, $7, $8,
                       NULL, NULL, NULL, NULL, 0, NULL)`,
      values: [
        input.intentId,
        input.actorId,
        compilation.verification_requirement_hash,
        binding.provider_id,
        providerBindingHash,
        binding.provider_configuration.kind,
        binding.provider_configuration.reference,
        binding.provider_configuration.version,
      ],
    });
    await admin.query({
      text: `INSERT INTO community_creation_ceremony_attempts (
               ceremony_intent_id, actor_id, intent_id, requirement_kind, generation,
               requirement_hash, provider_id, provider_binding_hash,
               provider_configuration_kind, provider_configuration_ref,
               provider_configuration_version, route_family, route_root_label,
               route_root_label_display, route_path_segment,
               reservation_request_hash, reservation_request, expires_at
             )
             SELECT $1, $2, $3, 'human_identity', 1, $4, $5, $6, $7, $8, $9,
                    NULL, NULL, NULL, NULL, $10, $11::jsonb, intent.expires_at
               FROM community_creation_intents AS intent
              WHERE intent.intent_id = $3 AND intent.actor_id = $2`,
      values: [
        ceremonyIntentId,
        input.actorId,
        input.intentId,
        compilation.verification_requirement_hash,
        binding.provider_id,
        providerBindingHash,
        binding.provider_configuration.kind,
        binding.provider_configuration.reference,
        binding.provider_configuration.version,
        reservationHash,
        JSON.stringify({
          ...reservation,
          version: COMMUNITY_CREATION_CEREMONY_RESERVATION_VERSION,
        }),
      ],
    });
    // The attempt trigger requires the row to still be unmet at generation 0;
    // the reservation then advances it exactly as the pre-amendment store did.
    await admin.query({
      text: `UPDATE community_creation_requirement_states
                SET status = 'pending', generation = 1, current_ceremony_intent_id = $1,
                    updated_at = clock_timestamp()
              WHERE intent_id = $2 AND actor_id = $3 AND requirement_kind = 'human_identity'`,
      values: [ceremonyIntentId, input.intentId, input.actorId],
    });
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }

  const document = await Effect.runPromise(
    store.get({ actor: { kind: "user", userId: input.actorId }, intentId: input.intentId }),
  );
  if (document === null) throw new Error(`grandfathered intent ${input.intentId} was not seeded`);
  await admin.query({
    text: `INSERT INTO community_creation_intent_revisions (
             intent_id, revision, actor_id, operation_kind, idempotency_key,
             request_hash, status, state_snapshot
           ) VALUES ($1, 1, $2, 'create', $3, $4, $5, $6::jsonb)`,
    values: [
      input.intentId,
      input.actorId,
      input.idempotencyKey,
      input.requestHash,
      document.status,
      JSON.stringify(document),
    ],
  });
  return document;
}
