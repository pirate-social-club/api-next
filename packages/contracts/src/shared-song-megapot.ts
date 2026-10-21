import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import { AuthError, InternalError, NotFound } from "./errors.ts";
import { IdV2, PublicPotSummaryV2 } from "./rewards-song-contributions-v2.ts";
/** Anonymous funder aggregate, account-authenticated content access. It never
 * exposes contributor/persona/wallet IDs or authorizes a payment instruction. */
export const GetSharedSongMegapotSummaryV2 = endpoint({
  method: "GET",
  path: "/communities/:communityId/posts/:postId/megapot-summary",
  auth: Auth.user({ browserSessionOnly: true }),
  cacheControl: "private, no-store",
  request: { path: Schema.Struct({ communityId: IdV2, postId: IdV2 }) },
  response: Schema.NullOr(PublicPotSummaryV2),
  errors: [AuthError, NotFound, InternalError],
});
