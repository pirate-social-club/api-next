import type { ControlPlaneTransaction } from "@pirate/application";
import {
  communityJoinNationalityIntentId,
  type NationalityPolicy,
  nationalityProviderBindingHash,
} from "@pirate/domain";
import { Effect } from "effect";
import {
  NationalityCeremonyDataInvalid,
  resolveOrIssueNationalityCeremony,
} from "./nationality-ceremony-store.ts";

/** The caller holds the community lock and has already found current evidence unmet.
 * A refetch preserves the bound provider. A satisfied historical action stays
 * immutable; renewed evidence belongs to a new action, never a reopened one.
 */
export const resolveJoinNationalityCeremony = Effect.fn("resolveJoinNationalityCeremony")(
  function* (
    transaction: ControlPlaneTransaction,
    input: Readonly<{
      actorId: string;
      communityId: string;
      policy: NationalityPolicy;
    }>,
  ) {
    const latest = yield* transaction.execute<Readonly<Record<string, unknown>>>({
      label: "community.nationality.latest-requirement.lock",
      text: `SELECT state.intent_id, state.status, state.current_provider_id,
                    state.current_provider_binding_hash
               FROM nationality_requirement_states AS state
               JOIN nationality_ceremony_attempts AS attempt
                 ON attempt.ceremony_intent_id = state.current_ceremony_intent_id
                AND attempt.actor_id = state.actor_id
                AND attempt.intent_id = state.intent_id
                AND attempt.action_kind = state.action_kind
                AND attempt.generation = state.generation
              WHERE state.action_kind = 'community_join'
                AND state.requirement_kind = 'nationality'
                AND state.actor_id = $1 AND state.requirement_hash = $2
                AND attempt.reservation_request->>'community_id' = $3
           ORDER BY state.created_at DESC, state.intent_id DESC
              LIMIT 1 FOR UPDATE OF state`,
      values: [input.actorId, input.policy.requirement_hash, input.communityId],
      readonly: false,
    });
    const previous = latest.rows[0];
    const selected =
      previous === undefined
        ? input.policy.provider_bindings[0]
        : input.policy.provider_bindings.find(
            (binding) => binding.provider_id === previous.current_provider_id,
          );
    if (
      selected === undefined ||
      (previous !== undefined && typeof previous.intent_id !== "string")
    ) {
      return yield* Effect.fail(new NationalityCeremonyDataInvalid());
    }
    const bindingHash = nationalityProviderBindingHash(selected);
    const bindingChanged =
      previous !== undefined && previous.current_provider_binding_hash !== bindingHash;
    let intentId = communityJoinNationalityIntentId({
      actorId: input.actorId,
      communityId: input.communityId,
      requirementHash: input.policy.requirement_hash,
    });
    if (previous !== undefined) {
      if (previous.status === "satisfied" || bindingChanged) {
        if (previous.status === "pending") {
          yield* transaction.execute({
            label: "community.nationality.retire-changed-binding",
            text: `UPDATE nationality_requirement_states SET status = 'expired', updated_at = clock_timestamp()
                    WHERE action_kind = 'community_join' AND intent_id = $1
                      AND requirement_kind = 'nationality' AND status = 'pending'`,
            values: [previous.intent_id],
            readonly: false,
          });
        }
        intentId = `community-join-nationality_${crypto.randomUUID()}`;
      } else {
        intentId = previous.intent_id as string;
      }
    }
    const action = yield* resolveOrIssueNationalityCeremony(transaction, {
      actionKind: "community_join",
      intentId,
      actorId: input.actorId,
      requirementHash: input.policy.requirement_hash,
      acceptedProviderIds: ["self.pass", "zkpassport"],
      selectedProviderId: selected.provider_id,
      selectedBinding: {
        bindingHash,
        configurationKind: selected.provider_configuration.kind,
        configurationRef: selected.provider_configuration.reference,
        configurationVersion: selected.provider_configuration.version,
      },
      reservationRequest: {
        action_kind: "community_join",
        actor_id: input.actorId,
        community_id: input.communityId,
        intent_id: intentId,
        requirement_hash: input.policy.requirement_hash,
        provider_id: selected.provider_id,
        provider_binding_hash: bindingHash,
      },
      ttlSeconds: 3_600,
    });
    return { ...action, providerId: selected.provider_id };
  },
);
