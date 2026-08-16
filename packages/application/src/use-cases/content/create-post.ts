import { BadRequest, CreatePost } from "@pirate/contracts";
import { Effect } from "effect";
import type { M2Actor } from "../../ports.ts";
import {
  type ContentUseCaseServices,
  canonicalBodyHash,
  decodeBody,
  mapContentFailure,
  validateHumanDirectActor,
  validateIdentifier,
  validPublicHumanDirectPost,
} from "./common.ts";

export type CreatePostInput = Readonly<{
  readonly communityId: string;
  readonly actor: M2Actor;
  readonly body: unknown;
}>;

const hasUnsupportedMetadata = (body: object): boolean => {
  const disallowed = [
    "agent_id",
    "agent_action_proof",
    "anonymous_scope",
    "disclosed_qualifier_ids",
    "parent_post_id",
    "label_id",
    "caption",
    "link_url",
    "media_refs",
    "creator_relation",
    "promotion_disclosure",
    "asset_id",
    "file_upload",
    "song_artifact_bundle",
    "song_mode",
    "rights_basis",
    "upstream_asset_refs",
    "license_preset",
    "commercial_rev_share_pct",
    "royalty_allocations",
    "lyrics",
    "source_post",
    "source_community",
    "crosspost_source",
    "event",
    "listing_draft",
    "age_gate_policy",
    "access_mode",
    "translation_policy",
    "publish_mode",
  ];
  return disallowed.some((key) => {
    const value = (body as Record<string, unknown>)[key];
    return value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0);
  });
};

export const createPost = Effect.fn("createPost")(function* (
  input: CreatePostInput,
  services: ContentUseCaseServices,
) {
  yield* validateIdentifier(input.communityId, "Invalid community identifier");
  yield* validateHumanDirectActor(input.actor);

  const body = yield* decodeBody(CreatePost.request.body, input.body);
  if (
    !validPublicHumanDirectPost(body) ||
    hasUnsupportedMetadata(body) ||
    body.idempotency_key.trim().length === 0 ||
    typeof body.body !== "string" ||
    body.body.trim().length === 0
  ) {
    return yield* new BadRequest({
      message: "Only public human text posts are supported",
    });
  }

  const bodyHash = yield* canonicalBodyHash(body);
  return yield* services.contentStore
    .createPost({
      communityId: input.communityId,
      actor: input.actor,
      body,
      idempotencyBodyHash: bodyHash,
    })
    .pipe(Effect.mapError(mapContentFailure));
});
