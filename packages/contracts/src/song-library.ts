import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import { AuthError, BadRequest, InternalError, NotFound } from "./errors.ts";
import { PersonaIdV1 } from "./personas.ts";

export const ActivitySong = Schema.Struct({
  community_id: PersonaIdV1,
  post_id: PersonaIdV1,
  title: Schema.String,
  artist: Schema.NullOr(Schema.String),
});
export type ActivitySong = Schema.Schema.Type<typeof ActivitySong>;
export const PersonaActivitySong = Schema.Struct({
  ...ActivitySong.fields,
  last_activity_at: Schema.String,
  activities: Schema.Array(Schema.Literals(["study", "karaoke", "dance"])),
});
export type PersonaActivitySong = Schema.Schema.Type<typeof PersonaActivitySong>;

export const ListPersonaSongs = endpoint({
  method: "GET",
  path: "/personas/:personaId/songs",
  auth: Auth.userOrAdmin(),
  request: {
    path: Schema.Struct({ personaId: PersonaIdV1 }),
    query: Schema.Struct({
      cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))),
    }),
  },
  response: Schema.Struct({
    songs: Schema.Array(PersonaActivitySong),
    next_cursor: Schema.NullOr(Schema.String),
  }),
  errors: [AuthError, BadRequest, NotFound, InternalError],
});

/** Public, general-rated songs ranked by distinct active accounts starting activities in seven days. */
export const GetTrendingSongs = endpoint({
  method: "GET",
  path: "/songs/trending",
  auth: Auth.public(),
  response: Schema.Struct({ songs: Schema.Array(ActivitySong), window_days: Schema.Literal(7) }),
  errors: [InternalError],
});
