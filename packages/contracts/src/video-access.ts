import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import { AuthError, BadRequest, InternalError, NotFound } from "./errors.ts";

/** Prepared for the coordinated access/client release; not in the live registry yet. */
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
