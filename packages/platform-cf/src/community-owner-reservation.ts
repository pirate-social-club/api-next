import type { ControlPlaneTransaction } from "@pirate/application";
import { CommunityOwnerSetupError } from "@pirate/application";
import { Effect, Option, Schema } from "effect";

const OwnerRow = Schema.Struct({
  persona_id: Schema.NonEmptyString,
  status: Schema.Literals(["pending_wallet", "active"]),
});

/** Caller holds the active account row before its creation intent row. */
export const reserveCommunityOwner = Effect.fn("reserveCommunityOwner")(function* (
  transaction: ControlPlaneTransaction,
  input: Readonly<{ accountId: string; intentId: string; publicName: string }>,
) {
  yield* transaction.execute({
    label: "community.owner.reserve.lock-wallet-allocation",
    text: "SELECT pg_advisory_xact_lock(hashtextextended($1, 14000046))",
    values: [JSON.stringify([input.accountId, "evm"])],
    readonly: false,
  });
  const current = yield* transaction.execute<{ minted_persona_id: string | null }>({
    label: "community.owner.reserve.current",
    text: "SELECT minted_persona_id FROM community_creation_intents WHERE intent_id=$1 AND actor_id=$2",
    values: [input.intentId, input.accountId],
    readonly: true,
  });
  const currentId = current.rows[0]?.minted_persona_id;
  if (currentId === undefined)
    return yield* new CommunityOwnerSetupError("Community setup could not be found");
  const reusable = yield* transaction.execute({
    label: "community.owner.reserve.recover",
    text: `SELECT persona.persona_id, persona.status
             FROM personas AS persona
            WHERE persona.account_id=$1 AND persona.status IN ('pending_wallet','active')
              AND ($2::text IS NULL OR persona.persona_id=$2)
              AND EXISTS (SELECT 1 FROM community_creation_intents AS intent
                           WHERE intent.actor_id=$1 AND intent.minted_persona_id=persona.persona_id
                             AND intent.status <> 'committed')
              AND EXISTS (SELECT 1 FROM persona_wallet_assignments AS wallet
                           WHERE wallet.account_id=$1 AND wallet.persona_id=persona.persona_id
                             AND wallet.chain_account_kind='evm' AND wallet.status IN ('pending','active'))
              AND NOT EXISTS (SELECT 1 FROM persona_community_bindings WHERE persona_id=persona.persona_id)
            ORDER BY persona.created_at, persona.persona_id LIMIT 1 FOR UPDATE OF persona`,
    values: [input.accountId, currentId],
    readonly: false,
  });
  const recovered = Schema.decodeUnknownOption(OwnerRow)(reusable.rows[0]);
  if (Option.isSome(recovered)) {
    const persona = recovered.value;
    // A membership commit may have bound this persona while our row lock waited.
    const bound = yield* transaction.execute({
      label: "community.owner.reserve.recheck-binding",
      text: "SELECT 1 FROM persona_community_bindings WHERE persona_id=$1",
      values: [persona.persona_id],
      readonly: true,
    });
    if (bound.rows.length !== 0)
      return yield* new CommunityOwnerSetupError(
        "This profile was used elsewhere. Retry community setup",
      );
    if (currentId === null) {
      // Every creation writer holds the account row, so another commit cannot
      // publish an older intent between supersession and attaching this owner.
      yield* transaction.execute({
        label: "community.owner.reserve.supersede",
        text: `WITH cancelled AS (
                 UPDATE community_creation_intents SET status=CASE WHEN expires_at<=clock_timestamp() THEN 'expired' ELSE 'cancelled' END,revision=revision+1,updated_at=clock_timestamp()
                  WHERE actor_id=$1 AND minted_persona_id=$2 AND intent_id<>$3
                    AND status IN ('draft','verification_required','commit_ready')
                  RETURNING intent_id,actor_id,revision,create_request_hash,status
               ) INSERT INTO community_creation_intent_revisions
                 (intent_id,actor_id,revision,operation_kind,request_hash,status,state_snapshot)
                 SELECT c.intent_id,c.actor_id,c.revision,CASE WHEN c.status='expired' THEN 'expire' ELSE 'cancel' END,c.create_request_hash,c.status,
                        prior.state_snapshot || jsonb_build_object('revision',c.revision,'status',c.status,
                          'next_action',jsonb_build_object('kind','none','reason',c.status))
                   FROM cancelled AS c JOIN LATERAL (
                     SELECT state_snapshot FROM community_creation_intent_revisions
                      WHERE intent_id=c.intent_id ORDER BY revision DESC LIMIT 1
                   ) AS prior ON true`,
        values: [input.accountId, persona.persona_id, input.intentId],
        readonly: false,
      });
      const renamed = yield* transaction.execute({
        label: "community.owner.reserve.rename",
        text:
          persona.status === "pending_wallet"
            ? "UPDATE persona_pending_profiles SET display_name=$2 WHERE persona_id=$1"
            : "UPDATE persona_profiles SET display_name=$2,revision=revision+1,updated_at=clock_timestamp() WHERE persona_id=$1",
        values: [persona.persona_id, input.publicName],
        readonly: false,
      });
      if (renamed.rowCount !== 1)
        return yield* new CommunityOwnerSetupError("Your profile could not be prepared");
    }
    return { personaId: persona.persona_id, status: persona.status };
  }
  if (currentId !== null)
    return yield* new CommunityOwnerSetupError(
      "This setup profile is no longer available. Start a new community setup",
    );
  const capacity = yield* transaction.execute<{
    slot_count: string;
    recent_count: string;
    retry_at: Date | string | null;
  }>({
    label: "community.owner.reserve.capacity",
    text: `SELECT count(*)::text AS slot_count,
                  count(*) FILTER (WHERE NOT persona.is_first_persona AND assignment.created_at > clock_timestamp()-interval '24 hours')::text AS recent_count,
                  min(assignment.created_at) FILTER (WHERE NOT persona.is_first_persona AND assignment.created_at > clock_timestamp()-interval '24 hours') + interval '24 hours' AS retry_at
             FROM persona_wallet_assignments AS assignment JOIN personas AS persona USING(persona_id)
            WHERE assignment.account_id=$1 AND assignment.chain_account_kind='evm'`,
    values: [input.accountId],
    readonly: true,
  });
  const limits = capacity.rows[0];
  if (limits === undefined)
    return yield* new CommunityOwnerSetupError(
      "Profile availability could not be checked. Retry setup",
    );
  if (Number(limits.slot_count) >= 10)
    return yield* new CommunityOwnerSetupError(
      "Your account has reached its profile limit. Retired profiles also count toward this limit. Your community draft is saved",
    );
  if (Number(limits.recent_count) >= 3) {
    const retryAt = new Date(String(limits.retry_at)).toISOString();
    return yield* new CommunityOwnerSetupError(
      `You can create another profile after ${retryAt}. Your community draft is saved`,
    );
  }
  const next = yield* transaction.execute<{ hd_wallet_index: string }>({
    label: "community.owner.reserve.next-index",
    text: "SELECT (COALESCE(max(hd_wallet_index),-1)+1)::text AS hd_wallet_index FROM persona_wallet_assignments WHERE account_id=$1 AND chain_account_kind='evm'",
    values: [input.accountId],
    readonly: true,
  });
  const index = Number(next.rows[0]?.hd_wallet_index);
  if (!Number.isSafeInteger(index) || index < 0)
    return yield* new CommunityOwnerSetupError("Your profile could not be prepared");
  const personaId = `persona_${crypto.randomUUID().replaceAll("-", "")}`;
  yield* transaction.execute({
    label: "community.owner.reserve.persona",
    text: "INSERT INTO personas (persona_id,account_id,status,is_first_persona,created_at) VALUES ($1,$2,'pending_wallet',false,clock_timestamp())",
    values: [personaId, input.accountId],
    readonly: false,
  });
  yield* transaction.execute({
    label: "community.owner.reserve.profile",
    text: "INSERT INTO persona_pending_profiles (persona_id,display_name,created_at) VALUES ($1,$2,clock_timestamp())",
    values: [personaId, input.publicName],
    readonly: false,
  });
  yield* transaction.execute({
    label: "community.owner.reserve.wallet",
    text: `INSERT INTO persona_wallet_assignments
             (assignment_id,persona_id,account_id,chain_account_kind,hd_wallet_index,status,reservation_idempotency_key,created_at,updated_at)
           VALUES ($1,$2,$3,'evm',$4,'pending',$5,clock_timestamp(),clock_timestamp())`,
    values: [
      `persona_wallet_${crypto.randomUUID().replaceAll("-", "")}`,
      personaId,
      input.accountId,
      index,
      `creation-${personaId}`,
    ],
    readonly: false,
  });
  return { personaId, status: "pending_wallet" as const };
});
