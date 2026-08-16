// GENERATED FILE. DO NOT EDIT. Regenerate with bun run generate:contracts.
import type { Schema } from "effect";
import type { EndpointRequest } from "@pirate/contracts";
import {
  Health,
  CastPostVote,
  ClearPostVote,
  CreateCommentReply,
  CreatePost,
  FollowCommunity,
  GetCommunityPreview,
  GetCurrentUser,
  GetHomeFeed,
  GetJoinEligibility,
  GetJwks,
  GetMyProfile,
  GetOAuthAuthorizationServer,
  GetOAuthProtectedResource,
  GetOpenIdConfiguration,
  GetPost,
  GetPublicHomeFeed,
  JoinCommunity,
  SessionExchange,
  UnfollowCommunity,
} from "@pirate/contracts";

type Part<Name extends string, S, Optional extends boolean = false> = S extends Schema.Schema<infer I>
  ? Optional extends true ? { [K in Name]?: I } : { [K in Name]: I }
  : {};
type ClientInput<E> = E extends { readonly request: infer R }
  ? R extends EndpointRequest
    ? Part<"body", R["body"], R["bodyRequired"] extends false ? true : false>
      & Part<"path", R["path"]>
      & Part<"query", R["query"], true>
    : R extends Schema.Schema<infer I> ? { body: I } : undefined
  : undefined;
type ClientOutput<E> = E extends { readonly response: Schema.Schema<infer A> } ? A : never;

export interface PirateApiClient {
  get_health: (input: ClientInput<typeof Health>) => Promise<ClientOutput<typeof Health>>;
  post_postsPostIdVote: (input: ClientInput<typeof CastPostVote>) => Promise<ClientOutput<typeof CastPostVote>>;
  post_postsPostIdClearVote: (input: ClientInput<typeof ClearPostVote>) => Promise<ClientOutput<typeof ClearPostVote>>;
  post_commentsCommentIdReplies: (input: ClientInput<typeof CreateCommentReply>) => Promise<ClientOutput<typeof CreateCommentReply>>;
  post_communitiesCommunityIdPosts: (input: ClientInput<typeof CreatePost>) => Promise<ClientOutput<typeof CreatePost>>;
  post_communitiesCommunityIdFollow: (input: ClientInput<typeof FollowCommunity>) => Promise<ClientOutput<typeof FollowCommunity>>;
  get_communitiesCommunityIdPreview: (input: ClientInput<typeof GetCommunityPreview>) => Promise<ClientOutput<typeof GetCommunityPreview>>;
  get_usersMe: (input: ClientInput<typeof GetCurrentUser>) => Promise<ClientOutput<typeof GetCurrentUser>>;
  get_feedHome: (input: ClientInput<typeof GetHomeFeed>) => Promise<ClientOutput<typeof GetHomeFeed>>;
  get_communitiesCommunityIdJoinEligibility: (input: ClientInput<typeof GetJoinEligibility>) => Promise<ClientOutput<typeof GetJoinEligibility>>;
  get_wellKnownJwksJson: (input: ClientInput<typeof GetJwks>) => Promise<ClientOutput<typeof GetJwks>>;
  get_profilesMe: (input: ClientInput<typeof GetMyProfile>) => Promise<ClientOutput<typeof GetMyProfile>>;
  get_wellKnownOauthAuthorizationServer: (input: ClientInput<typeof GetOAuthAuthorizationServer>) => Promise<ClientOutput<typeof GetOAuthAuthorizationServer>>;
  get_wellKnownOauthProtectedResource: (input: ClientInput<typeof GetOAuthProtectedResource>) => Promise<ClientOutput<typeof GetOAuthProtectedResource>>;
  get_wellKnownOpenidConfiguration: (input: ClientInput<typeof GetOpenIdConfiguration>) => Promise<ClientOutput<typeof GetOpenIdConfiguration>>;
  get_postsPostId: (input: ClientInput<typeof GetPost>) => Promise<ClientOutput<typeof GetPost>>;
  get_feedHomePublic: (input: ClientInput<typeof GetPublicHomeFeed>) => Promise<ClientOutput<typeof GetPublicHomeFeed>>;
  post_communitiesCommunityIdJoin: (input: ClientInput<typeof JoinCommunity>) => Promise<ClientOutput<typeof JoinCommunity>>;
  post_authSessionExchange: (input: ClientInput<typeof SessionExchange>) => Promise<ClientOutput<typeof SessionExchange>>;
  post_communitiesCommunityIdUnfollow: (input: ClientInput<typeof UnfollowCommunity>) => Promise<ClientOutput<typeof UnfollowCommunity>>;
}

export function createPirateApiClient(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): PirateApiClient {
  const request = async <T>(method: string, path: string, input: unknown): Promise<T> => {
    const requestInput = (input ?? {}) as {
      body?: unknown;
      path?: Record<string, unknown>;
      query?: Record<string, unknown>;
    };
    const pathValue = Object.entries(requestInput.path ?? {}).reduce(
      (u, [key, value]) => u.replaceAll(`:${key}`, encodeURIComponent(String(value))),
      path,
    );
    const url = new URL(pathValue, baseUrl);
    for (const [key, value] of Object.entries(requestInput.query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const response = await fetchImpl(url, {
      method,
      headers: { "content-type": "application/json" },
      body: requestInput.body === undefined ? undefined : JSON.stringify(requestInput.body),
    });
    if (!response.ok) throw await response.json();
    return response.json() as Promise<T>;
  };
  return {
  get_health: (input) => request("GET", "/health", input),
  post_postsPostIdVote: (input) => request("POST", "/posts/:postId/vote", input),
  post_postsPostIdClearVote: (input) => request("POST", "/posts/:postId/clear_vote", input),
  post_commentsCommentIdReplies: (input) => request("POST", "/comments/:commentId/replies", input),
  post_communitiesCommunityIdPosts: (input) => request("POST", "/communities/:communityId/posts", input),
  post_communitiesCommunityIdFollow: (input) => request("POST", "/communities/:communityId/follow", input),
  get_communitiesCommunityIdPreview: (input) => request("GET", "/communities/:communityId/preview", input),
  get_usersMe: (input) => request("GET", "/users/me", input),
  get_feedHome: (input) => request("GET", "/feed/home", input),
  get_communitiesCommunityIdJoinEligibility: (input) => request("GET", "/communities/:communityId/join-eligibility", input),
  get_wellKnownJwksJson: (input) => request("GET", "/.well-known/jwks.json", input),
  get_profilesMe: (input) => request("GET", "/profiles/me", input),
  get_wellKnownOauthAuthorizationServer: (input) => request("GET", "/.well-known/oauth-authorization-server", input),
  get_wellKnownOauthProtectedResource: (input) => request("GET", "/.well-known/oauth-protected-resource", input),
  get_wellKnownOpenidConfiguration: (input) => request("GET", "/.well-known/openid-configuration", input),
  get_postsPostId: (input) => request("GET", "/posts/:postId", input),
  get_feedHomePublic: (input) => request("GET", "/feed/home/public", input),
  post_communitiesCommunityIdJoin: (input) => request("POST", "/communities/:communityId/join", input),
  post_authSessionExchange: (input) => request("POST", "/auth/session/exchange", input),
  post_communitiesCommunityIdUnfollow: (input) => request("POST", "/communities/:communityId/unfollow", input),
  };
}
