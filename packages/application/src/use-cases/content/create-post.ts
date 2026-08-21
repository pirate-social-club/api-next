import { BadRequest, CreatePost } from "@pirate/contracts";
import { Effect, Schema } from "effect";
import type { M2Actor } from "../../ports.ts";
import {
  type ContentUseCaseServices,
  canonicalBodyHash,
  mapContentFailure,
  validateHumanDirectActor,
  validateIdentifier,
  validPublicHumanDirectPost,
} from "./common.ts";
import { createTextPost } from "./text-post.ts";

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
  ];
  return disallowed.some((key) => {
    const value = (body as Record<string, unknown>)[key];
    return value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0);
  });
};

/** CreatePost is decoded strictly here because the shared decoder is reused by other content paths. */
const decodeCreatePostBody = (
  input: unknown,
): Effect.Effect<Schema.Schema.Type<(typeof CreatePost.request)["body"]>, BadRequest> =>
  Effect.try({
    try: () =>
      Schema.decodeUnknownSync(CreatePost.request.body, { onExcessProperty: "error" })(input),
    catch: () => new BadRequest({ message: "Invalid request body" }),
  });

export const createPost = Effect.fn("createPost")(function* (
  input: CreatePostInput,
  services: ContentUseCaseServices,
) {
  const textStore = services.textPostStore ?? services.textStore;
  const moderation = services.textModeration ?? services.moderation;
  if (textStore !== undefined && moderation !== undefined) {
    return yield* createTextPost(input, {
      store: textStore,
      moderation,
    });
  }
  yield* validateIdentifier(input.communityId, "Invalid community identifier");
  yield* validateHumanDirectActor(input.actor);

  const body = yield* decodeCreatePostBody(input.body);
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
