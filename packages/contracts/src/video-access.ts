import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import { AuthError, BadRequest, InternalError, NotFound, RateLimited } from "./errors.ts";

/** Poster and playback access share the coordinated registry/client release. */
export const GetVideoPoster = endpoint({
  method: "GET",
  path: "/posts/:postId/video/poster",
  auth: Auth.user({ optionalUser: true }),
  request: {
    path: Schema.Struct({ postId: Schema.String }),
    headers: Schema.Struct({ "if-none-match": Schema.optional(Schema.String) }),
  },
  response: Schema.Unknown,
  responseRepresentation: {
    kind: "binary",
    contentType: "image/jpeg",
    cacheControl: "private, no-cache",
    conditional: "authorized-etag",
  },
  successStatus: [200, 304],
  errors: [AuthError, BadRequest, NotFound, InternalError],
});

export const CreateVideoPlaybackAccess = endpoint({
  method: "POST",
  path: "/posts/:postId/video/playback-access",
  auth: Auth.user({ optionalUser: true }),
  request: { path: Schema.Struct({ postId: Schema.String }) },
  response: Schema.Struct({
    playback_url: Schema.String,
    expires_at: Schema.Number,
    renew_after: Schema.Number,
  }),
  errors: [AuthError, BadRequest, InternalError, NotFound, RateLimited],
});
