import { Effect } from "effect";
import type { MediaProcessingArtifactReader } from "../../application/src/media/processing-contracts.ts";
import { mediaSha256Bytes } from "../../application/src/media/submission-service.ts";
import type { MediaIdentificationProviderService } from "../../application/src/media-identification-provider.ts";
import type {
  VideoAnalysisProviders,
  VideoSoundtrackFact,
} from "../../application/src/video/analysis.ts";
import type { VideoRecognitionEvidence } from "../../application/src/video/recognition-evidence.ts";
import { videoDerivedArtifactKey } from "./video-stage-artifact-head.ts";

/** External identification only. Provider matches do not establish Pirate asset ownership. */
export function makeVideoRecognitionProvider(
  options: Readonly<{
    identification: MediaIdentificationProviderService | null;
    reader: MediaProcessingArtifactReader;
    sleep?: (milliseconds: number) => Promise<void>;
  }>,
): VideoAnalysisProviders["identifySoundtrack"] {
  return async (input) => {
    const evidence: VideoRecognitionEvidence[] = [];
    const adapterRevision = "video-acr-clips-v1";
    const finish = async (
      status: "no_match" | "inconclusive" | "known_recording" | "acr_exhausted" | "acr_skipped",
      providerRef?: string,
    ): Promise<VideoSoundtrackFact> => {
      const evidenceRef = `evidence_${await mediaSha256Bytes(
        new TextEncoder().encode(
          JSON.stringify([
            adapterRevision,
            input.operationId,
            input.videoRevision,
            input.creationRevision,
            input.clips,
            status,
            evidence,
          ]),
        ),
      )}`;
      const common = { evidenceRef, adapterRevision, privateEvidence: evidence };
      if (status === "acr_exhausted" || status === "acr_skipped")
        return { ...common, verification: null, exhaustion: status };
      if (status === "known_recording") {
        if (!providerRef) throw new Error("recognition match identity missing");
        return {
          ...common,
          verification: {
            status,
            identified: { kind: "external", providerRef },
            evidenceRef,
            adapterRevision,
          },
        };
      }
      return { ...common, verification: { status, evidenceRef, adapterRevision } };
    };
    if (options.identification === null) return finish("acr_skipped");
    let inconclusive = false;
    for (const [index, clip] of input.clips.entries()) {
      const variant = index === 0 ? "primary" : "alternate";
      const requestId = `video-acr-${input.operationId}-c${input.creationRevision}-${variant}`;
      let bytes: Uint8Array;
      try {
        if (clip.variant !== variant || clip.mediaType !== "audio/mpeg")
          throw new Error("invalid clip");
        bytes = await options.reader.readAudioSample(
          {
            version: "media-transform-sample-artifact-v1",
            objectKey: videoDerivedArtifactKey(clip.artifactRef),
            contentType: "audio/mpeg",
            byteLength: clip.sizeBytes,
            offsetMs: clip.offsetMs,
            durationMs: clip.durationMs,
            variant,
            retainedObjectVerification: "required",
          },
          4_000_000,
          AbortSignal.timeout(30_000),
        );
        if (
          bytes.byteLength !== clip.sizeBytes ||
          (await mediaSha256Bytes(bytes)) !== clip.canonicalSha256
        )
          throw new Error("clip digest mismatch");
      } catch {
        evidence.push({
          variant,
          requestId,
          sampleSha256: clip.canonicalSha256,
          attempt: 0,
          outcome: "unavailable",
          reason: "artifact_unavailable",
        });
        return finish("acr_exhausted");
      }
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const result = await Effect.runPromise(
            options.identification.identify({
              version: "media-identification-request-v1",
              operationId: input.operationId,
              audioRevision: input.videoRevision,
              analysisRevision: input.creationRevision,
              canonicalAudioSha256: clip.canonicalSha256,
              requestId,
              sample: { bytes, filename: `${variant}.mp3`, contentType: "audio/mpeg" },
            }),
          );
          if (
            result.context.operationId !== input.operationId ||
            result.context.requestId !== requestId ||
            result.context.audioRevision !== input.videoRevision ||
            result.context.analysisRevision !== input.creationRevision ||
            result.context.canonicalAudioSha256 !== clip.canonicalSha256
          )
            throw new Error("recognition context mismatch");
          evidence.push({
            variant,
            requestId,
            sampleSha256: clip.canonicalSha256,
            attempt,
            outcome: result.outcome,
            adapterRevision: result.context.adapterRevision,
            ...("reason" in result ? { reason: result.reason } : {}),
            ...(result.outcome === "retained_reference_match"
              ? {
                  match: {
                    provider: "acrcloud",
                    providerMatchId: result.evidence.providerMatchId,
                    matchKind: result.evidence.matchKind,
                    title: result.evidence.title?.slice(0, 2048) ?? null,
                    artists: result.evidence.artists
                      .slice(0, 20)
                      .map((artist) => artist.slice(0, 512)),
                    score: result.evidence.score,
                  },
                }
              : {}),
          });
          if (result.outcome === "retained_reference_match")
            return finish("known_recording", result.evidence.providerMatchId);
          if (result.outcome === "inconclusive_fingerprint") {
            inconclusive = true;
            break;
          }
          if (result.outcome === "no_match") break;
          if (result.outcome !== "retryable_failure" || attempt === 3)
            return finish("acr_exhausted");
        } catch {
          evidence.push({
            variant,
            requestId,
            sampleSha256: clip.canonicalSha256,
            attempt,
            outcome: "unavailable",
            reason: "provider_unavailable",
          });
          if (attempt === 3) return finish("acr_exhausted");
        }
        await (options.sleep ?? ((ms) => Effect.runPromise(Effect.sleep(ms))))(
          1000 * 2 ** (attempt - 1),
        );
      }
    }
    return finish(inconclusive ? "inconclusive" : "no_match");
  };
}
