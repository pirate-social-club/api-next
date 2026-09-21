import type { ControlPlaneTransaction } from "@pirate/application";
import type { AvatarAttachmentOutcomes, CommunityCreationDraftV2 } from "@pirate/contracts";
import { Effect, type Schema } from "effect";

const requested = (draft: CommunityCreationDraftV2) =>
  [
    { id: draft.community_avatar_ref, purpose: "community" },
    { id: draft.persona_avatar_ref, purpose: "persona" },
  ]
    .filter((entry): entry is { id: string; purpose: string } => entry.id !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id));

/** A foreign or reused reference remains an unavailable optional image, never authority. */
export const bindCreationAvatars = Effect.fn("avatars.bindCreation")(function* (
  tx: ControlPlaneTransaction,
  ownerId: string,
  intentId: string,
  draft: CommunityCreationDraftV2,
) {
  for (const asset of requested(draft)) {
    yield* tx.execute({
      label: "avatars.bind-intent",
      text: `UPDATE avatar_assets SET intent_id=$3 WHERE asset_id=$1 AND owner_account_id=$2 AND purpose=$4 AND intent_id IS NULL AND state IN ('reserved','ready') AND expires_at > clock_timestamp()`,
      values: [asset.id, ownerId, intentId, asset.purpose],
      readonly: false,
    });
  }
});

export const attachCreationAvatars = Effect.fn("avatars.attachCreation")(function* (
  tx: ControlPlaneTransaction,
  input: {
    ownerId: string;
    intentId: string;
    communityId: string;
    personaId: string;
    draft: CommunityCreationDraftV2;
  },
) {
  const outcomes: {
    community: Schema.Schema.Type<typeof AvatarAttachmentOutcomes>["community"];
    persona: Schema.Schema.Type<typeof AvatarAttachmentOutcomes>["persona"];
  } = {
    community: input.draft.community_avatar_ref ? "omitted_unavailable" : "not_requested",
    persona: input.draft.persona_avatar_ref ? "omitted_unavailable" : "not_requested",
  };
  let communityRef: string | null = null;
  for (const asset of requested(input.draft)) {
    const rows = yield* tx.execute<{ asset_id: string }>({
      label: "avatars.attach.lock",
      text: `SELECT asset_id FROM avatar_assets WHERE asset_id=$1 AND owner_account_id=$2 AND purpose=$3 AND intent_id=$4 AND state='ready' AND moderation_status='unscanned' FOR UPDATE`,
      values: [asset.id, input.ownerId, asset.purpose, input.intentId],
      readonly: false,
    });
    if (!rows.rows[0]) continue;
    const live = yield* tx.execute({
      label: "avatars.attach.expiry",
      text: "SELECT 1 FROM avatar_assets WHERE asset_id=$1 AND expires_at > clock_timestamp()",
      values: [asset.id],
      readonly: true,
    });
    if (live.rowCount !== 1) continue;

    const ref = `/api/avatars/${asset.id}`;
    if (asset.purpose === "persona") {
      const updated = yield* tx.execute({
        label: "avatars.attach.persona",
        text: `UPDATE persona_profiles SET avatar_ref=$3, revision=revision+1, updated_at=clock_timestamp() WHERE persona_id=$1 AND avatar_ref IS NULL AND EXISTS(SELECT 1 FROM personas WHERE persona_id=$1 AND account_id=$2 AND status='active') AND NOT EXISTS(SELECT 1 FROM persona_community_bindings WHERE persona_id=$1)`,
        values: [input.personaId, input.ownerId, ref],
        readonly: false,
      });
      if (updated.rowCount !== 1) {
        outcomes.persona = "preserved_existing";
        continue;
      }
      outcomes.persona = "attached";
    } else {
      communityRef = ref;
      outcomes.community = "attached";
    }
    yield* tx.execute({
      label: "avatars.attach.asset",
      text: `UPDATE avatar_assets SET state='attached', attached_target_id=$2 WHERE asset_id=$1`,
      values: [asset.id, asset.purpose === "community" ? input.communityId : input.personaId],
      readonly: false,
    });
  }
  return { communityRef, outcomes };
});
