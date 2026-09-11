import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import { AuthError, BadRequest, InternalError, NotFound, RateLimited } from "./errors.ts";

/** Short-lived full-mix listening access. No source, download or derivative permission. */
export const CreateSongPlaybackAccess = endpoint({
  method: "POST",
  path: "/posts/:postId/song/playback-access",
  auth: Auth.user({ optionalUser: true }),
  request: { path: Schema.Struct({ postId: Schema.String }) },
  response: Schema.Struct({
    kind: Schema.Literal("full_mix"),
    playback_url: Schema.String,
    expires_at: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    renew_after: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  errors: [AuthError, BadRequest, InternalError, NotFound, RateLimited],
});
