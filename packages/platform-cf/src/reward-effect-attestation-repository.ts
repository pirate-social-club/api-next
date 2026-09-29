import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import { Effect, type Layer } from "effect";
import type { MegapotChainEffectKind } from "./megapot-work-repository.ts";
import { MegapotWorkStorageFailed } from "./megapot-work-repository.ts";

/** Resolve reconciliation from its persisted effect, never the active deployment. */
export function makeControlPlaneRewardEffectAttestationStore(
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
) {
  return {
    load: (effectId: string, effectKind: MegapotChainEffectKind) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<Record<string, unknown>>({
          label: "reward-effect.attestation.read",
          text: `SELECT CASE effect.effect_kind
                   WHEN 'usdc_approval' THEN approval.attestation_id
                   WHEN 'ticket_purchase' THEN purchase.attestation_id
                   WHEN 'winnings_claim' THEN claim.attestation_id
                   WHEN 'reward_payout' THEN payout.attestation_id
                   WHEN 'reward_refund' THEN refund.attestation_id
                 END AS attestation_id
                 FROM reward_chain_effects effect
                 LEFT JOIN megapot_usdc_approval_effects approval ON approval.approval_effect_id=effect.effect_id
                 LEFT JOIN megapot_ticket_purchase_effects purchase ON purchase.purchase_effect_id=effect.effect_id
                 LEFT JOIN megapot_claim_effects claim ON claim.claim_effect_id=effect.effect_id
                 LEFT JOIN reward_payout_effects payout ON payout.payout_effect_id=effect.effect_id
                 LEFT JOIN reward_refund_effects refund ON refund.refund_effect_id=effect.effect_id
                WHERE effect.effect_id=$1 AND effect.effect_kind=$2`,
          values: [effectId, effectKind],
          readonly: true,
        });
        const id = result.rows[0]?.attestation_id;
        if (result.rows.length !== 1 || typeof id !== "string" || id.length === 0) {
          return yield* new MegapotWorkStorageFailed({ reason: "invalid-row" });
        }
        return id;
      }).pipe(
        Effect.provide(layer),
        Effect.mapError((error) =>
          error instanceof MegapotWorkStorageFailed
            ? error
            : new MegapotWorkStorageFailed({ reason: "unavailable" }),
        ),
      ),
  };
}
