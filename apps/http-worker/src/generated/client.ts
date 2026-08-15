// GENERATED FILE. DO NOT EDIT. Regenerate with bun run generate:contracts.
import type { Schema } from "effect";
import {
  Health,
  CastPostVote,
  ClearPostVote,
  CreateCommentReply,
  CreatePost,
  FollowCommunity,
  GetCommunityPreview,
  GetHomeFeed,
  GetJoinEligibility,
  GetMe,
  GetPost,
  GetPublicHomeFeed,
  JoinCommunity,
  SessionExchange,
  UnfollowCommunity,
} from "@pirate/contracts";

type ClientInput<E> = E extends { readonly request: Schema.Schema<infer I> } ? I : undefined;
type ClientOutput<E> = E extends { readonly response: Schema.Schema<infer A> } ? A : never;

export interface PirateApiClient {
  get_health: (input: ClientInput<typeof Health>) => Promise<ClientOutput<typeof Health>>;
  post_communitiesCommunityIdPostsPostIdVote: (input: ClientInput<typeof CastPostVote>) => Promise<ClientOutput<typeof CastPostVote>>;
  post_communitiesCommunityIdPostsPostIdClearVote: (input: ClientInput<typeof ClearPostVote>) => Promise<ClientOutput<typeof ClearPostVote>>;
  post_communitiesCommunityIdCommentsCommentIdReplies: (input: ClientInput<typeof CreateCommentReply>) => Promise<ClientOutput<typeof CreateCommentReply>>;
  post_communitiesCommunityIdPosts: (input: ClientInput<typeof CreatePost>) => Promise<ClientOutput<typeof CreatePost>>;
  post_communitiesCommunityIdFollow: (input: ClientInput<typeof FollowCommunity>) => Promise<ClientOutput<typeof FollowCommunity>>;
  get_communitiesCommunityIdPreview: (input: ClientInput<typeof GetCommunityPreview>) => Promise<ClientOutput<typeof GetCommunityPreview>>;
  get_feedHome: (input: ClientInput<typeof GetHomeFeed>) => Promise<ClientOutput<typeof GetHomeFeed>>;
  get_communitiesCommunityIdJoinEligibility: (input: ClientInput<typeof GetJoinEligibility>) => Promise<ClientOutput<typeof GetJoinEligibility>>;
  get_me: (input: ClientInput<typeof GetMe>) => Promise<ClientOutput<typeof GetMe>>;
  get_communitiesCommunityIdPostsPostId: (input: ClientInput<typeof GetPost>) => Promise<ClientOutput<typeof GetPost>>;
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
    const url = Object.entries((input ?? {}) as Record<string, unknown>).reduce(
      (u, [key, value]) => u.replaceAll(`:${key}`, encodeURIComponent(String(value))),
      path,
    );
    const response = await fetchImpl(new URL(url, baseUrl), {
      method,
      headers: { "content-type": "application/json" },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    if (!response.ok) throw await response.json();
    return response.json() as Promise<T>;
  };
  return {
  get_health: (input) => request("GET", "/health", input),
  post_communitiesCommunityIdPostsPostIdVote: (input) => request("POST", "/communities/:communityId/posts/:postId/vote", input),
  post_communitiesCommunityIdPostsPostIdClearVote: (input) => request("POST", "/communities/:communityId/posts/:postId/clear_vote", input),
  post_communitiesCommunityIdCommentsCommentIdReplies: (input) => request("POST", "/communities/:communityId/comments/:commentId/replies", input),
  post_communitiesCommunityIdPosts: (input) => request("POST", "/communities/:communityId/posts", input),
  post_communitiesCommunityIdFollow: (input) => request("POST", "/communities/:communityId/follow", input),
  get_communitiesCommunityIdPreview: (input) => request("GET", "/communities/:communityId/preview", input),
  get_feedHome: (input) => request("GET", "/feed/home", input),
  get_communitiesCommunityIdJoinEligibility: (input) => request("GET", "/communities/:communityId/join-eligibility", input),
  get_me: (input) => request("GET", "/me", input),
  get_communitiesCommunityIdPostsPostId: (input) => request("GET", "/communities/:communityId/posts/:postId", input),
  get_feedHomePublic: (input) => request("GET", "/feed/home/public", input),
  post_communitiesCommunityIdJoin: (input) => request("POST", "/communities/:communityId/join", input),
  post_authSessionExchange: (input) => request("POST", "/auth/session/exchange", input),
  post_communitiesCommunityIdUnfollow: (input) => request("POST", "/communities/:communityId/unfollow", input),
  };
}
