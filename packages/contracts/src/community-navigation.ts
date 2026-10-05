import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import { AuthError, BadRequest, InternalError } from "./errors.ts";

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const Limit = Schema.String.check(Schema.isPattern(/^(?:[1-9]|[1-9][0-9]|100)$/u));

export const NavigationCommunityV1 = Schema.Struct({
  community_id: Id,
  display_name: Schema.String,
  resource_href: Schema.String,
  member_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}).check(
  Schema.makeFilter((item) =>
    item.resource_href === `/c/${item.community_id}`
      ? undefined
      : "Expected a server-owned community destination",
  ),
);
export type NavigationCommunityV1 = Schema.Schema.Type<typeof NavigationCommunityV1>;

/** Active communities, ranked by active membership count, then community ID. */
export const ListPopularCommunities = endpoint({
  method: "GET",
  path: "/public/communities/popular",
  auth: Auth.public(),
  request: { query: Schema.Struct({ limit: Schema.optional(Limit) }) },
  response: Schema.Struct({
    object: Schema.Literal("popular_community_list"),
    ranked_by: Schema.Literal("members"),
    items: Schema.Array(NavigationCommunityV1),
  }),
  errors: [BadRequest, InternalError],
});

/** Membership and creation alone never grant moderation access. */
export const ListMyModerationCommunities = endpoint({
  method: "GET",
  path: "/users/me/moderation-communities",
  auth: Auth.userOrAdmin(),
  request: { query: Schema.Struct({ cursor: Schema.optional(Id) }) },
  response: Schema.Struct({
    object: Schema.Literal("moderation_community_page"),
    capability: Schema.Literal("moderation.view"),
    items: Schema.Array(NavigationCommunityV1),
    next_cursor: Schema.NullOr(Id),
  }),
  errors: [AuthError, BadRequest, InternalError],
});
