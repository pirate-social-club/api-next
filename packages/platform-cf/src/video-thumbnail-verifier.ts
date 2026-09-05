import type { VideoThumbnailServices } from "@pirate/application/video/thumbnail-enrichment";
import { Effect } from "effect";
import type { VideoPosterAuthority, VideoPosterIdentity } from "./video-poster-authority.ts";
import { matchesSealedVideoPoster, type VideoPosterObjectMetadata } from "./video-poster-object.ts";

export function makeVideoThumbnailVerifier(
  services: Readonly<{
    resolveArtifact(
      input: VideoPosterIdentity,
    ): Effect.Effect<VideoPosterAuthority | null, unknown>;
    bucket: { head(key: string): Promise<VideoPosterObjectMetadata | null> };
  }>,
): VideoThumbnailServices["verify"] {
  return async (claim) => {
    const authority = await Effect.runPromise(services.resolveArtifact(claim));
    if (
      authority === null ||
      authority.artifactRef !== claim.artifactRef ||
      authority.sha256 !== claim.sha256 ||
      authority.sourceSha256 !== claim.sourceSha256 ||
      authority.policyRevision !== claim.policyRevision
    )
      return "invalid";
    // The execution sealer owns byte/hash verification and immutable first-winner
    // writes. Delivery checks availability and seal metadata, without a second copy.
    const object = await services.bucket.head(authority.key);
    if (object === null) return "missing";
    return matchesSealedVideoPoster(object, authority) ? "available" : "invalid";
  };
}
