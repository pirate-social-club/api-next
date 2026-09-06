import { VIDEO_POSTER_POLICY_V1 } from "@pirate/domain";
import type { VideoPosterAuthority } from "./video-poster-authority.ts";

export interface VideoPosterObjectMetadata {
  readonly key: string;
  readonly size: number;
  readonly httpMetadata?: { readonly contentType?: string; readonly contentEncoding?: string };
  readonly customMetadata?: Record<string, string>;
}

/** Shared by availability observation and serving; neither accepts caller storage keys. */
export function matchesSealedVideoPoster(
  found: VideoPosterObjectMetadata,
  authority: VideoPosterAuthority,
): boolean {
  return (
    found.key === authority.key &&
    Number.isSafeInteger(found.size) &&
    found.size > 0 &&
    found.size <= VIDEO_POSTER_POLICY_V1.maxBytesPerFrame &&
    found.httpMetadata?.contentType === "image/jpeg" &&
    found.httpMetadata.contentEncoding === undefined &&
    found.customMetadata?.sha256 === authority.sha256 &&
    found.customMetadata.sourceSha256 === authority.sourceSha256 &&
    found.customMetadata.policyRevision === authority.policyRevision
  );
}
