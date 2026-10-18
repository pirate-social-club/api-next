import { Schema } from "effect";
import { PublicPostCanonicalPathV1 } from "./public-post-routes.ts";

/** The ID route has its own codec; it is never a fallback for a failed alias. */
export function videoPostDetailPath(postId: string): string | null {
  if (
    !postId ||
    postId.length > 512 ||
    postId.trim() !== postId ||
    /[\s\p{Cc}%/\\?#]/u.test(postId) ||
    postId === "." ||
    postId === ".."
  )
    return null;
  try {
    const path = `/post/${encodeURIComponent(postId)}`;
    const url = new URL(path, "https://navigation.invalid");
    return url.pathname === path && decodeURIComponent(path.slice(6)) === postId ? path : null;
  } catch {
    return null;
  }
}

export const VideoPostDetailPathV1 = Schema.String.check(
  Schema.makeFilter((path) => {
    if (!path.startsWith("/post/")) return false;
    try {
      return videoPostDetailPath(decodeURIComponent(path.slice(6))) === path;
    } catch {
      return false;
    }
  }),
);
export const PostDetailNavigationPathV1 = Schema.Union([
  PublicPostCanonicalPathV1,
  VideoPostDetailPathV1,
]);
