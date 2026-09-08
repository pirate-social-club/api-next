import type { SongSourceAudioReader } from "@pirate/application/media/source-recording-authority";
import { mediaProcessingPhysicalObjectKey } from "./media-immutable-object-key.ts";
import { readBoundedStream } from "./media-processing-runtime.ts";

async function readExact(
  bucket: R2Bucket,
  key: string,
  maximumBytes: number,
  expectedBytes: number | null,
  expectedContentType: string | null,
  signal: AbortSignal,
): Promise<Readonly<{ bytes: Uint8Array; contentType: string }>> {
  const head = await bucket.head(key);
  if (
    head === null ||
    head.size < 1 ||
    head.size > maximumBytes ||
    (expectedBytes !== null && head.size !== expectedBytes) ||
    (expectedContentType !== null && head.httpMetadata?.contentType !== expectedContentType)
  ) {
    throw new TypeError("song source recording object fence failed");
  }
  const selected = await bucket.get(key, { onlyIf: { etagMatches: head.etag } });
  if (
    selected === null ||
    !("body" in selected) ||
    selected.etag !== head.etag ||
    selected.size !== head.size
  ) {
    if (selected !== null && "body" in selected) void selected.body.cancel("object_changed");
    throw new TypeError("song source recording object changed");
  }
  return {
    bytes: await readBoundedStream(selected.body, maximumBytes, signal),
    contentType: head.httpMetadata?.contentType ?? "application/octet-stream",
  };
}

export function makeSongSourceRecordingR2Reader(
  options: Readonly<{
    immutableOriginals: R2Bucket;
    derivedArtifacts: R2Bucket;
    maximumCanonicalBytes: number;
    maximumSampleBytes: number;
  }>,
): SongSourceAudioReader {
  return {
    readCanonical: async (registration, signal) => {
      const result = await readExact(
        options.immutableOriginals,
        mediaProcessingPhysicalObjectKey(registration.immutableAudioRef),
        options.maximumCanonicalBytes,
        null,
        null,
        signal,
      );
      if (!result.contentType.startsWith("audio/")) {
        throw new TypeError("song source canonical object is not audio");
      }
      return {
        bytes: result.bytes,
        filename: `source-a${registration.audioRevision}`,
        contentType: result.contentType,
      };
    },
    readVerificationSample: async (registration, signal) => {
      const sample = registration.verificationSample;
      const result = await readExact(
        options.derivedArtifacts,
        sample.objectKey,
        options.maximumSampleBytes,
        sample.byteLength,
        sample.contentType,
        signal,
      );
      return {
        bytes: result.bytes,
        filename: `source-a${registration.audioRevision}-sample`,
        contentType: sample.contentType,
      };
    },
  };
}
