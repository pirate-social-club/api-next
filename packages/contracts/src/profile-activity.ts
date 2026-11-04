import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { CommentThreadItemV1 } from "./comment-thread.ts";
import { endpoint } from "./endpoint.ts";
import { AuthError, BadRequest, InternalError, NotFound } from "./errors.ts";
import { PersonaIdV1 } from "./personas.ts";
import { LocalizedPost } from "./v1.ts";

export const ProfileActivitySurface = Schema.Literals(["overview", "posts", "comments"]);
const Common = {
  activity_id: PersonaIdV1,
  activity_at: Schema.String,
  community_id: PersonaIdV1,
  post_id: PersonaIdV1,
  href: Schema.NullOr(Schema.String),
};
export const ProfileActivityItemV1 = Schema.Union([
  Schema.Struct({ ...Common, kind: Schema.Literal("post"), content: LocalizedPost }),
  Schema.Struct({
    ...Common,
    kind: Schema.Literal("comment"),
    comment: CommentThreadItemV1,
    post_title: Schema.NullOr(Schema.String),
    community_name: Schema.String,
  }),
]);
export type ProfileActivityItemV1 = Schema.Schema.Type<typeof ProfileActivityItemV1>;

/** Viewer-authorized published text/song activity for a public persona. */
export const GetPublicProfileActivity = endpoint({
  method: "GET",
  path: "/public/personas/:personaId/activity",
  auth: Auth.userOrAdmin({ optionalUser: true }),
  request: {
    path: Schema.Struct({ personaId: PersonaIdV1 }),
    query: Schema.Struct({
      surface: Schema.optional(ProfileActivitySurface),
      cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))),
      locale: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
    }),
  },
  response: Schema.Struct({
    object: Schema.Literal("profile_activity_page"),
    items: Schema.Array(ProfileActivityItemV1),
    next_cursor: Schema.NullOr(Schema.String),
  }),
  errors: [AuthError, BadRequest, NotFound, InternalError],
});
