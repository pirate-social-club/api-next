import {
  BadRequest,
  CommentThreadItemV1,
  type InternalError,
  type NotFound,
  PersonaIdV1,
  type ProfileActivityItemV1,
  ProfileActivitySurface,
} from "@pirate/contracts";
import { Effect, Schema } from "effect";
import type { ContentStoreService } from "../ports.ts";
import { postSlugCanonicalPath } from "../post-slug.ts";

export const ProfileActivityCursor = Schema.Struct({
  persona_id: PersonaIdV1,
  surface: ProfileActivitySurface,
  at: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u)),
  id: PersonaIdV1,
  kind: Schema.Literals(["post", "comment"]),
});
export type ProfileActivityCursor = Schema.Schema.Type<typeof ProfileActivityCursor>;
const Common = {
  activity_id: PersonaIdV1,
  activity_at: Schema.String,
  community_id: PersonaIdV1,
  post_id: PersonaIdV1,
  post_slug: Schema.NullOr(Schema.String),
};
export const ProfileActivityReference = Schema.Union([
  Schema.Struct({ ...Common, kind: Schema.Literal("post") }),
  Schema.Struct({
    ...Common,
    kind: Schema.Literal("comment"),
    comment: CommentThreadItemV1,
    post_title: Schema.NullOr(Schema.String),
    community_name: Schema.String,
  }),
]);
export type ProfileActivityReference = Schema.Schema.Type<typeof ProfileActivityReference>;
export interface ProfileActivityStore {
  list: (input: {
    personaId: string;
    viewerId?: string;
    surface: "overview" | "posts" | "comments";
    cursor: ProfileActivityCursor | null;
  }) => Effect.Effect<readonly ProfileActivityReference[], InternalError | NotFound>;
}

export const getPublicProfileActivity = Effect.fn("getPublicProfileActivity")(function* (
  input: {
    personaId: string;
    viewerId?: string;
    surface?: "overview" | "posts" | "comments";
    cursor?: string;
    locale?: string;
  },
  store: ProfileActivityStore,
  contentStore: Pick<ContentStoreService, "getPost">,
) {
  const surface = input.surface ?? "overview";
  const cursor = yield* Effect.try({
    try: () => {
      if (input.cursor === undefined) return null;
      const value = Schema.decodeUnknownSync(ProfileActivityCursor)(JSON.parse(input.cursor));
      const millis = Date.parse(`${value.at.slice(0, 23)}Z`);
      if (
        value.persona_id !== input.personaId ||
        value.surface !== surface ||
        !Number.isFinite(millis) ||
        new Date(millis).toISOString().slice(0, 23) !== value.at.slice(0, 23)
      )
        throw new Error("Invalid cursor");
      return value;
    },
    catch: () => new BadRequest({ message: "Invalid profile activity cursor" }),
  });
  const rows = yield* store.list({
    personaId: input.personaId,
    surface,
    cursor,
    ...(input.viewerId === undefined ? {} : { viewerId: input.viewerId }),
  });
  const items: ProfileActivityItemV1[] = [];
  for (const row of rows.slice(0, 20)) {
    const common = {
      activity_id: row.activity_id,
      activity_at: row.activity_at,
      community_id: row.community_id,
      post_id: row.post_id,
      href: row.post_slug === null ? null : postSlugCanonicalPath(row.post_slug),
    };
    if (row.kind === "comment") {
      items.push({
        ...common,
        kind: "comment",
        comment: row.comment,
        post_title: row.post_title,
        community_name: row.community_name,
      });
      continue;
    }
    const content = yield* contentStore.getPost({
      communityId: row.community_id,
      postId: row.post_id,
      viewerUserId: input.viewerId ?? "public-profile-anonymous",
      ...(input.locale === undefined ? {} : { locale: input.locale }),
    });
    if (
      content === null ||
      !("post" in content) ||
      content.post.status !== "published" ||
      content.post.identity_mode !== "public" ||
      content.post.author_persona?.persona_id !== input.personaId
    )
      continue;
    items.push({ ...common, kind: "post", content });
  }
  const last = rows.slice(0, 20).at(-1);
  return {
    object: "profile_activity_page" as const,
    items,
    next_cursor:
      rows.length > 20 && last
        ? JSON.stringify({
            persona_id: input.personaId,
            surface,
            at: last.activity_at,
            id: last.activity_id,
            kind: last.kind,
          })
        : null,
  };
});
