import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import {
  type VerificationIntentResolver,
  VerificationProviderPlanInput,
  VerificationStartStorageFailed,
} from "@pirate/application/verification";
import {
  VERY_WEB_PROVIDER_ID,
  WALLET_SEND_ACTION_KIND,
  walletSendActionPayloadHash,
  walletSendIntentBindingHash,
} from "@pirate/domain";
import { Effect, type Layer, Option, Schema } from "effect";
import { veryHumanMembershipPlan } from "./community-join-intent-resolver.ts";

type Row = Readonly<Record<string, unknown>>;

export class WalletSendIntentDataInvalid extends Error {
  readonly _tag = "WalletSendIntentDataInvalid";
}

/** A persona-bound return intent. Issuing or completing it never authorizes a transfer. */
export const issueWalletSendVerificationIntent = (
  accountId: string,
  personaId: string,
  nextIntentId: () => string = () => `wallet-send_${globalThis.crypto.randomUUID()}`,
): Effect.Effect<string, ControlPlaneError | WalletSendIntentDataInvalid, ControlPlaneDb> =>
  Effect.gen(function* () {
    const db = yield* ControlPlaneDb;
    const payloadHash = walletSendActionPayloadHash(accountId, personaId);
    const bindingHash = walletSendIntentBindingHash(accountId, personaId);
    return yield* db.withTransaction((transaction) =>
      Effect.gen(function* () {
        const persona = yield* transaction.execute<Row>({
          label: "wallet-send-intents.persona",
          text: `SELECT persona_id FROM personas
                  WHERE account_id=$1 AND persona_id=$2 AND status='active'
                  FOR UPDATE`,
          values: [accountId, personaId],
          readonly: false,
        });
        if (persona.rows.length !== 1) return yield* Effect.fail(new WalletSendIntentDataInvalid());
        const existing = yield* transaction.execute<Row>({
          label: "wallet-send-intents.reuse",
          text: `SELECT intent.action_intent_id
                   FROM action_intents AS intent
                  WHERE intent.user_id = $1
                    AND intent.action_kind = $2
                    AND intent.action_scope = $5
                    AND intent.community_id IS NULL
                    AND intent.action_payload_hash = $3
                    AND intent.intent_binding_hash = $4
                    AND intent.status = 'open'
                    AND intent.expires_at > clock_timestamp() + interval '5 minutes'
                    AND NOT EXISTS (
                      SELECT 1 FROM proof_sessions AS session
                       WHERE session.actor_id = intent.user_id
                         AND session.intent_id = intent.action_intent_id
                         AND (session.status <> 'pending'
                           OR session.expires_at <= clock_timestamp())
                    )
                  ORDER BY intent.created_at DESC, intent.action_intent_id DESC
                  LIMIT 1
                  FOR UPDATE OF intent`,
          values: [accountId, WALLET_SEND_ACTION_KIND, payloadHash, bindingHash, personaId],
          readonly: false,
        });
        const reused = existing.rows[0]?.action_intent_id;
        if (typeof reused === "string" && reused.length > 0) return reused;
        const intentId = nextIntentId();
        const inserted = yield* transaction.execute<Row>({
          label: "wallet-send-intents.insert",
          text: `INSERT INTO action_intents (
                   action_intent_id, user_id, community_id, action_kind, action_scope,
                   action_payload_hash, intent_binding_hash, idempotency_key, status, expires_at
                 ) VALUES ($1, $2, NULL, $3, $6, $4, $5, $1, 'open',
                           clock_timestamp() + interval '1 hour')
                 RETURNING action_intent_id`,
          values: [
            intentId,
            accountId,
            WALLET_SEND_ACTION_KIND,
            payloadHash,
            bindingHash,
            personaId,
          ],
          readonly: false,
        });
        if (inserted.rows[0]?.action_intent_id !== intentId) {
          return yield* Effect.fail(new WalletSendIntentDataInvalid());
        }
        return intentId;
      }),
    );
  });

/** Reuse the canonical Very palm plan so one palm has the same subject as Claim and Join. */
export function makeControlPlaneWalletSendIntentResolver(
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
        if (!input.intent_id.startsWith("wallet-send_")) return null;
        const found = yield* Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.execute<Row>({
            label: "wallet-send-intents.resolve",
            text: `SELECT intent.action_payload_hash, intent.intent_binding_hash, intent.action_scope
                     FROM action_intents AS intent
                     JOIN personas AS persona ON persona.persona_id=intent.action_scope
                      AND persona.account_id=intent.user_id AND persona.status='active'
                    WHERE intent.action_intent_id = $1
                      AND intent.user_id = $2
                      AND intent.action_kind = $3
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
              WALLET_SEND_ACTION_KIND,
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
          typeof row.action_scope !== "string" ||
          row.action_payload_hash !==
            walletSendActionPayloadHash(input.actor_id, row.action_scope) ||
          row.intent_binding_hash !== walletSendIntentBindingHash(input.actor_id, row.action_scope)
        ) {
          return null;
        }
        return decodedPlan.value;
      }),
  };
}
