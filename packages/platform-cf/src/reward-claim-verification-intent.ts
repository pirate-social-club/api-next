import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import {
  type VerificationIntentResolver,
  VerificationProviderPlanInput,
  VerificationStartStorageFailed,
} from "@pirate/application/verification";
import {
  REWARD_CLAIM_ACTION_KIND,
  rewardClaimActionPayloadHash,
  rewardClaimIntentBindingHash,
  VERY_WEB_PROVIDER_ID,
} from "@pirate/domain";
import { Effect, type Layer, Option, Schema } from "effect";
import { veryHumanMembershipPlan } from "./community-join-intent-resolver.ts";

type Row = Readonly<Record<string, unknown>>;

export class RewardClaimIntentDataInvalid extends Error {
  readonly _tag = "RewardClaimIntentDataInvalid";
}

/**
 * Spec 015 §5.2a. Returns an open reward-claim intent for the account,
 * reusing one that is still usable (unexpired for at least five minutes and
 * with no terminal proof session) and otherwise issuing a new one valid for
 * an hour. The intent grants nothing by itself: the claim re-checks evidence.
 */
export const issueRewardClaimVerificationIntent = (
  accountId: string,
  nextIntentId: () => string = () => `reward-claim_${globalThis.crypto.randomUUID()}`,
): Effect.Effect<string, ControlPlaneError | RewardClaimIntentDataInvalid, ControlPlaneDb> =>
  Effect.gen(function* () {
    const db = yield* ControlPlaneDb;
    const payloadHash = rewardClaimActionPayloadHash(accountId);
    const bindingHash = rewardClaimIntentBindingHash(accountId);
    return yield* db.withTransaction((transaction) =>
      Effect.gen(function* () {
        const existing = yield* transaction.execute<Row>({
          label: "reward-claim-intents.reuse",
          text: `SELECT intent.action_intent_id
                   FROM action_intents AS intent
                  WHERE intent.user_id = $1
                    AND intent.action_kind = $2
                    AND intent.action_scope = $1
                    AND intent.community_id IS NULL
                    AND intent.action_payload_hash = $3
                    AND intent.intent_binding_hash = $4
                    AND intent.status = 'open'
                    AND intent.expires_at > clock_timestamp() + interval '5 minutes'
                    AND NOT EXISTS (
                      SELECT 1 FROM proof_sessions AS session
                       WHERE session.actor_id = intent.user_id
                         AND session.intent_id = intent.action_intent_id
                         AND session.status <> 'pending'
                    )
                  ORDER BY intent.created_at DESC, intent.action_intent_id DESC
                  LIMIT 1
                  FOR UPDATE OF intent`,
          values: [accountId, REWARD_CLAIM_ACTION_KIND, payloadHash, bindingHash],
          readonly: false,
        });
        const reused = existing.rows[0]?.action_intent_id;
        if (typeof reused === "string" && reused.length > 0) return reused;
        const intentId = nextIntentId();
        const inserted = yield* transaction.execute<Row>({
          label: "reward-claim-intents.insert",
          text: `INSERT INTO action_intents (
                   action_intent_id, user_id, community_id, action_kind, action_scope,
                   action_payload_hash, intent_binding_hash, idempotency_key, status, expires_at
                 ) VALUES ($1, $2, NULL, $3, $2, $4, $5, $1, 'open',
                           clock_timestamp() + interval '1 hour')
                 RETURNING action_intent_id`,
          values: [intentId, accountId, REWARD_CLAIM_ACTION_KIND, payloadHash, bindingHash],
          readonly: false,
        });
        if (inserted.rows[0]?.action_intent_id !== intentId) {
          return yield* Effect.fail(new RewardClaimIntentDataInvalid());
        }
        return intentId;
      }),
    );
  });

/**
 * Resolves a reward-claim intent to the Very human-membership plan. A start
 * that already bound a proof session may replay after the intent expires,
 * matching the join resolver's replay rule.
 */
export function makeControlPlaneRewardClaimIntentResolver(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  environment: string,
): VerificationIntentResolver {
  const decodedPlan = Schema.decodeUnknownOption(VerificationProviderPlanInput)(
    veryHumanMembershipPlan(environment),
  );
  const storageFailure = () => new VerificationStartStorageFailed();
  if (Option.isNone(decodedPlan)) return { resolve: () => Effect.fail(storageFailure()) };
  return {
    resolve: (input) =>
      Effect.gen(function* () {
        if (!("intent_id" in input) || input.provider_id !== VERY_WEB_PROVIDER_ID) return null;
        if (!input.intent_id.startsWith("reward-claim_")) return null;
        const found = yield* Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.execute<Row>({
            label: "reward-claim-intents.resolve",
            text: `SELECT intent.action_payload_hash, intent.intent_binding_hash
                     FROM action_intents AS intent
                    WHERE intent.action_intent_id = $1
                      AND intent.user_id = $2
                      AND intent.action_kind = $3
                      AND intent.action_scope = $2
                      AND intent.community_id IS NULL
                      AND intent.status = 'open'
                      AND (
                        intent.expires_at > clock_timestamp()
                        OR EXISTS (
                          SELECT 1 FROM proof_sessions AS session
                           WHERE session.actor_id = intent.user_id
                             AND session.intent_id = intent.action_intent_id
                             AND session.provider_id = $4
                        )
                      )`,
            values: [
              input.intent_id,
              input.actor_id,
              REWARD_CLAIM_ACTION_KIND,
              VERY_WEB_PROVIDER_ID,
            ],
            readonly: true,
          });
        }).pipe(
          Effect.provide(runtime),
          Effect.mapError(() => storageFailure()),
        );
        if (found.rows.length > 1) return yield* Effect.fail(storageFailure());
        const row = found.rows[0];
        if (row === undefined) return null;
        if (
          row.action_payload_hash !== rewardClaimActionPayloadHash(input.actor_id) ||
          row.intent_binding_hash !== rewardClaimIntentBindingHash(input.actor_id)
        ) {
          return null;
        }
        return decodedPlan.value;
      }),
  };
}
