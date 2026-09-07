import { mediaSha256Bytes } from "../../application/src/media/submission-service.ts";
import { VIDEO_POSTER_POLICY_V1 } from "../../domain/src/video-submission.ts";
import { readBoundedStream } from "./media-processing-runtime.ts";
import { videoDerivedArtifactKey } from "./video-stage-artifact-head.ts";

export function makeVideoSafetyFrameReader(bucket: R2Bucket) {
  return async (artifactRef: string, sha256: string): Promise<Uint8Array> => {
    const object = await bucket.get(videoDerivedArtifactKey(artifactRef));
    if (object === null) throw new Error("video safety frame absent");
    if (
      object.size < 1 ||
      object.size > VIDEO_POSTER_POLICY_V1.maxBytesPerFrame ||
      object.httpMetadata?.contentType !== "image/jpeg" ||
      object.customMetadata?.sha256 !== sha256
    ) {
      await object.body.cancel();
      throw new Error("video safety frame identity mismatch");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const bytes = await readBoundedStream(
        object.body,
        VIDEO_POSTER_POLICY_V1.maxBytesPerFrame,
        controller.signal,
      );
      if (bytes.byteLength !== object.size || (await mediaSha256Bytes(bytes)) !== sha256)
        throw new Error("video safety frame digest mismatch");
      return bytes;
    } finally {
      clearTimeout(timer);
    }
  };
}
