import type { ControlPlaneError, ControlPlaneTransaction } from "@pirate/application";
import { communityJoinActionPayloadHash, communityJoinIntentBindingHash } from "@pirate/domain";
import { Data, Effect } from "effect";

type Row = Readonly<Record<string, unknown>>;

export class CommunityJoinIntentDataInvalid extends Data.TaggedError(
  "CommunityJoinIntentDataInvalid",
) {}

export type CommunityJoinIntentAction =
  | Readonly<{ readonly kind: "start"; readonly intentId: string }>
  | Readonly<{ readonly kind: "wait"; readonly intentId: string }>;

const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value === value.trim() &&
  !value.includes("\u0000");

const active = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

function invalid(): CommunityJoinIntentDataInvalid {
  return new CommunityJoinIntentDataInvalid();
}

/**
 * Resolve or issue the actor's opaque Very join intent. The caller owns the
 * community-first lock and exact current-policy/provider-binding validation.
 */
export const resolveOrIssueCommunityJoinIntent = Effect.fn("resolveOrIssueCommunityJoinIntent")(
  function* (
    transaction: ControlPlaneTransaction,
    input: Readonly<{ readonly communityId: string; readonly userId: string }>,
    options: Readonly<{ readonly nextIntentId?: () => string }> = {},
  ): Effect.fn.Return<
    CommunityJoinIntentAction,
    ControlPlaneError | CommunityJoinIntentDataInvalid
  > {
    const actionPayloadHash = communityJoinActionPayloadHash(input.communityId);
    const intentBindingHash = communityJoinIntentBindingHash({
      actorId: input.userId,
      communityId: input.communityId,
    });
    const latestResult = yield* transaction.execute<Row>({
      label: "community.join-intents.lock-latest",
      text: `SELECT action_intent_id,
                  user_id,
                  community_id,
                  action_kind,
                  action_scope,
                  action_payload_hash,
                  intent_binding_hash,
                  status,
                  expires_at > clock_timestamp() AS active
             FROM action_intents
            WHERE user_id = $1
              AND community_id = $2
              AND action_kind = 'community_join'
              AND action_scope = community_id
              AND action_payload_hash = $3
              AND intent_binding_hash = $4
         ORDER BY created_at DESC, action_intent_id DESC
            LIMIT 1
              FOR UPDATE`,
      values: [input.userId, input.communityId, actionPayloadHash, intentBindingHash],
      readonly: false,
    });
    if (latestResult.rows.length > 1) return yield* Effect.fail(invalid());
    const latest = latestResult.rows[0];
    if (latest !== undefined) {
      if (
        !validId(latest.action_intent_id) ||
        latest.user_id !== input.userId ||
        latest.community_id !== input.communityId ||
        latest.action_kind !== "community_join" ||
        latest.action_scope !== input.communityId ||
        latest.action_payload_hash !== actionPayloadHash ||
        latest.intent_binding_hash !== intentBindingHash ||
        typeof latest.status !== "string" ||
        active(latest.active) === null
      ) {
        return yield* Effect.fail(invalid());
      }

      const sessionResult = yield* transaction.execute<Row>({
        label: "community.join-intents.lock-session",
        text: `SELECT proof_session_id,
                    actor_id,
                    intent_id,
                    status,
                    expires_at > clock_timestamp() AS active
               FROM proof_sessions
              WHERE actor_id = $1
                AND intent_id = $2
                FOR UPDATE`,
        values: [input.userId, latest.action_intent_id],
        readonly: false,
      });
      if (sessionResult.rows.length > 1) return yield* Effect.fail(invalid());
      const session = sessionResult.rows[0];
      if (session === undefined) {
        if (latest.status === "open" && latest.active === true) {
          return { kind: "start", intentId: latest.action_intent_id };
        }
      } else {
        if (
          !validId(session.proof_session_id) ||
          session.actor_id !== input.userId ||
          session.intent_id !== latest.action_intent_id ||
          !["pending", "completed", "failed", "expired"].includes(String(session.status)) ||
          active(session.active) === null
        ) {
          return yield* Effect.fail(invalid());
        }
        if (latest.status === "open" && session.status === "pending" && session.active === true) {
          return { kind: "wait", intentId: latest.action_intent_id };
        }
      }
    }

    const intentId = options.nextIntentId?.() ?? `community-join_${globalThis.crypto.randomUUID()}`;
    if (!validId(intentId)) return yield* Effect.fail(invalid());
    const inserted = yield* transaction.execute<Row>({
      label: "community.join-intents.insert",
      text: `INSERT INTO action_intents (
             action_intent_id, user_id, community_id, action_kind, action_scope,
             action_payload_hash, intent_binding_hash, idempotency_key, status, expires_at
           ) VALUES ($1, $2, $3, 'community_join', $3, $4, $5, $1, 'open',
                     clock_timestamp() + interval '1 hour')
           RETURNING action_intent_id, user_id, community_id, action_kind, action_scope,
                     action_payload_hash, intent_binding_hash, status,
                     expires_at > clock_timestamp() AS active`,
      values: [intentId, input.userId, input.communityId, actionPayloadHash, intentBindingHash],
      readonly: false,
    });
    if (inserted.rows.length !== 1) return yield* Effect.fail(invalid());
    const row = inserted.rows[0] ?? {};
    if (
      row.action_intent_id !== intentId ||
      row.user_id !== input.userId ||
      row.community_id !== input.communityId ||
      row.action_kind !== "community_join" ||
      row.action_scope !== input.communityId ||
      row.action_payload_hash !== actionPayloadHash ||
      row.intent_binding_hash !== intentBindingHash ||
      row.status !== "open" ||
      row.active !== true
    ) {
      return yield* Effect.fail(invalid());
    }
    return { kind: "start", intentId };
  },
);
