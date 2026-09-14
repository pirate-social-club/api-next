import type { TelegramPublicationPoster } from "@pirate/application/telegram";

export interface TelegramPublicationPosterInput {
  /** Anonymous public eligibility, never a member's viewing right. */
  readonly authorize: (postId: string, communityId: string) => Promise<boolean>;
  readonly posterArtifactRef: (postId: string, communityId: string) => Promise<string | null>;
  readonly resolvePoster: (identity: {
    postId: string;
    communityId: string;
    artifactRef: string;
  }) => Promise<TelegramPublicationPoster | null>;
}

/**
 * Resolves the sealed poster identity for a publication only after anonymous
 * public eligibility passes. The result is a storage identity, not a fetchable
 * locator: the owning bucket reader validates it before any transfer, and a
 * missing or mismatched artifact is treated as no media so the caller can fall
 * back to text.
 */
export function makeTelegramPublicationPoster(input: TelegramPublicationPosterInput) {
  return async (
    post: Readonly<{ id: string; communityId: string }>,
  ): Promise<TelegramPublicationPoster | null> => {
    if (!(await input.authorize(post.id, post.communityId))) return null;
    const artifactRef = await input.posterArtifactRef(post.id, post.communityId);
    if (artifactRef === null || artifactRef.length === 0) return null;
    const authority = await input.resolvePoster({
      postId: post.id,
      communityId: post.communityId,
      artifactRef,
    });
    if (authority === null || authority.artifactRef !== artifactRef) return null;
    return authority;
  };
}
