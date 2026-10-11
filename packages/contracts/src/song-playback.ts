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

const KaraokePlaybackIdentifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
  Schema.isTrimmed(),
  Schema.makeFilter((value) =>
    value.includes("\u0000") ? "Playback identifiers cannot contain NUL" : undefined,
  ),
);

/** Short-lived instrumental access bound to the exact accepted Karaoke source. */
export const CreateKaraokePlaybackAccess = endpoint({
  method: "POST",
  path: "/posts/:postId/karaoke/playback-access",
  auth: Auth.user({ optionalUser: true }),
  request: {
    path: Schema.Struct({ postId: KaraokePlaybackIdentifier }),
    body: Schema.Struct({
      community_id: KaraokePlaybackIdentifier,
      karaoke_revision_id: KaraokePlaybackIdentifier,
      playback_ref: KaraokePlaybackIdentifier,
    }),
  },
  response: Schema.Struct({
    kind: Schema.Literal("instrumental"),
    post_id: KaraokePlaybackIdentifier,
    community_id: KaraokePlaybackIdentifier,
    karaoke_revision_id: KaraokePlaybackIdentifier,
    playback_audio: Schema.Struct({
      kind: Schema.Literal("instrumental"),
      ref: KaraokePlaybackIdentifier,
    }),
    playback_url: Schema.String,
    expires_at: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    renew_after: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  errors: [AuthError, BadRequest, InternalError, NotFound, RateLimited],
});
