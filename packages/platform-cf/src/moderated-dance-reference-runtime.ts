import { Effect, type Layer, Schema } from "effect";
import type { ControlPlaneDb, ControlPlaneError } from "../../application/src/ports.ts";
import { canonicalBodyHash } from "../../application/src/use-cases/content/common.ts";
import { ModeratedDanceIntakeProfile } from "../../application/src/use-cases/dance/moderated-intake.ts";
import { withRetainedControlPlaneCommandTransaction } from "./control-plane-command-transaction.ts";
import {
  decodeModeratedDanceFramehash,
  makeModeratedDanceNormalizationJob,
  moderatedDanceReplayDigests,
  readModeratedDanceExport,
} from "./moderated-dance-normalization.ts";
import { bindModeratedDanceReplayKeys } from "./moderated-dance-public-replay.ts";
import type { makeSongVideoCloudConvertTransport } from "./song-video-cloudconvert-transport.ts";
import { makeSongVideoPcmExcerpt } from "./song-video-pcm-excerpt.ts";
import { makeR2SongVideoPcmRangeReader } from "./song-video-pcm-r2-range.ts";
import { videoSourceCapabilityDigest } from "./video-source-capability.ts";
import { makeVideoSourceUrl } from "./video-source-gateway.ts";

const Id = Schema.NonEmptyString,
  N = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  H = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Pcm = Schema.Struct({
  songPostId: Id,
  audioRevision: N,
  canonicalAudioSha256: H,
  durationSamples: N,
  objectKey: Id,
  objectVersion: Id,
  objectEtag: Id,
  pcmSha256: H,
  byteLength: N,
  decoderRecipe: Id,
});
const Segment = Schema.Struct({
  segmentId: Id,
  segmentTermsHash: H,
  key: Id,
  version: Id,
  etag: Id,
  size: N,
  sha256: H,
});
const Work = Schema.Struct({
  choreographyId: Id,
  segmentId: Id,
  token: Id,
  state: Schema.Literals(["copying", "normalizing", "unknown"]),
  communityId: Id,
  songPostId: Id,
  referencePostId: Id,
  masterRevisionId: Id,
  profile: ModeratedDanceIntakeProfile,
  normalizationHash: H,
  source: Schema.Struct({ key: Id, version: Id, etag: Id, size: N, sha256: H }),
  pcm: Pcm,
  songSubmissionId: Id,
  clipStartSamples: N,
  clipDurationSamples: N,
  segmentIdentity: Schema.NullOr(Segment),
  providerTag: Id,
  providerJobId: Schema.NullOr(Id),
  normalizationClaimed: Schema.Boolean,
  deadlineMs: N,
});
const parse = <S extends Schema.ConstraintDecoder<unknown>>(s: S, v: unknown) =>
  Schema.decodeUnknownSync(s, { onExcessProperty: "error" })(v);

/** Actual pose-free reference production from the accepted canonical renderer:
 * verify the exact admitted PCM range, create its independently owned WAV,
 * normalize the published master under the same replay family, then atomically
 * publish the immutable segment/reference. Never trust a client alignment. */
export function makeModeratedDanceReferenceRuntime(
  input: Readonly<{
    runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError>;
    bucket: Pick<R2Bucket, "head" | "get" | "put">;
    transform: ReturnType<typeof makeSongVideoCloudConvertTransport>;
    replayKeys: ReadonlyMap<string, Uint8Array>;
    gatewayOrigin: string;
    runtimeRevision: string;
    send?: (url: string, init: RequestInit) => Promise<Response>;
    randomId?: () => string;
    now?: () => number;
  }>,
) {
  const call = (label: string, text: string, values: readonly unknown[]) =>
    Effect.runPromise(
      withRetainedControlPlaneCommandTransaction((tx) =>
        Effect.gen(function* () {
          const r = yield* tx.execute<{ packet: unknown }>({
            label,
            text,
            values,
            readonly: false,
          });
          if (r.rows.length !== 1 || r.rows[0] === undefined || !Object.hasOwn(r.rows[0], "packet"))
            throw new Error("Reference persistence outcome unknown");
          return r.rows[0].packet;
        }),
      ).pipe(Effect.provide(input.runtime)),
    );
  const invokeVoid = (label: string, text: string, values: readonly unknown[]) =>
    call(label, `${text} AS packet`, values);
  const run = async () => {
    await bindModeratedDanceReplayKeys(call, input.replayKeys);
    const raw = await call(
      "dance.reference.media.claim",
      "SELECT claim_moderated_dance_reference_media_v1($1,$2,$3::jsonb) AS packet",
      [
        (input.randomId ?? (() => crypto.randomUUID()))(),
        input.runtimeRevision,
        JSON.stringify([...input.replayKeys.keys()]),
      ],
    );
    if (raw === null) return { outcome: "empty" as const };
    const w = parse(Work, raw),
      keys = new Map<string, Uint8Array>();
    for (const epoch of w.profile.replayCompatibleEpochs) {
      const key = input.replayKeys.get(epoch);
      if (key === undefined) throw new Error("Reference replay epoch unavailable");
      keys.set(epoch, key);
    }
    let segment = w.segmentIdentity;
    if (segment === null) {
      const excerpt = await makeSongVideoPcmExcerpt({
        reference: w.pcm,
        clipStartSamples: w.clipStartSamples,
        clipDurationSamples: w.clipDurationSamples,
        reader: makeR2SongVideoPcmRangeReader(input.bucket),
      });
      const segmentTermsHash = await Effect.runPromise(
        canonicalBodyHash([
          "moderated-canonical-song-segment-v1",
          w.communityId,
          w.songPostId,
          w.pcm.audioRevision,
          w.pcm.canonicalAudioSha256,
          w.clipStartSamples,
          w.clipDurationSamples,
          excerpt.wavSha256,
          "canonical-pcm-excerpt-v1",
        ]),
      );
      const key = `moderated-dance/segments/${segmentTermsHash}/canonical.wav`;
      await input.bucket.put(key, excerpt.wav, {
        onlyIf: { etagDoesNotMatch: "*" },
        sha256: excerpt.wavSha256,
        httpMetadata: { contentType: "audio/wav" },
        customMetadata: { sha256: excerpt.wavSha256, segmentTermsHash },
      });
      const head = await input.bucket.head(key);
      if (
        head === null ||
        head.size !== excerpt.wav.length ||
        head.customMetadata?.sha256 !== excerpt.wavSha256 ||
        head.customMetadata?.segmentTermsHash !== segmentTermsHash
      )
        throw new Error("Canonical segment identity unresolved");
      segment = {
        segmentId: `seg-${segmentTermsHash}`,
        segmentTermsHash,
        key,
        version: head.version,
        etag: head.etag,
        size: head.size,
        sha256: excerpt.wavSha256,
      };
      await invokeVoid(
        "dance.reference.segment.commit",
        "SELECT persist_moderated_dance_reference_segment_v1($1,$2,$3::jsonb)",
        [w.choreographyId, w.token, JSON.stringify(segment)],
      );
    }
    const fresh = parse(
      Schema.Boolean,
      await call(
        "dance.reference.normalization.claim",
        "SELECT claim_moderated_dance_reference_normalization_v1($1,$2) AS packet",
        [w.choreographyId, w.token],
      ),
    );
    const unknown = async (cause: unknown) => {
      try {
        await invokeVoid(
          "dance.reference.provider.unknown",
          "SELECT record_moderated_dance_reference_provider_v1($1,$2,$3::jsonb)",
          [w.choreographyId, w.token, JSON.stringify({ status: "unknown" })],
        );
      } catch (persistence) {
        throw new AggregateError(
          [cause, persistence],
          "Reference provider and persistence outcomes unresolved",
        );
      }
      return { outcome: "unknown" as const };
    };
    if (fresh) {
      const bytes = crypto.getRandomValues(new Uint8Array(32)),
        cap = btoa(String.fromCharCode(...bytes))
          .replaceAll("+", "-")
          .replaceAll("/", "_")
          .replaceAll("=", "");
      await call(
        "dance.reference.source.issue",
        "SELECT issue_moderated_dance_reference_source_v1($1,$2,$3) AS packet",
        [w.choreographyId, w.token, await videoSourceCapabilityDigest(cap)],
      );
      // The durable claim commits before POST. Lost acknowledgements never regain
      // authorization: the next invocation only looks up this exact original tag.
      let created: Awaited<ReturnType<typeof input.transform.create>>;
      try {
        created = await input.transform.create(
          makeModeratedDanceNormalizationJob({
            tag: w.providerTag,
            sourceUrl: makeVideoSourceUrl(input.gatewayOrigin, cap),
            bodyStartMs: 0,
            bodyEndMs: w.clipDurationSamples / 48,
            profile: w.profile,
          }),
        );
      } catch (cause) {
        return unknown(cause);
      }
      await invokeVoid(
        "dance.reference.provider.attach",
        "SELECT attach_moderated_dance_reference_provider_v1($1,$2,$3,$4)",
        [w.choreographyId, w.token, created.id, created.tag],
      );
      return { outcome: "processing" as const };
    }
    if (w.providerJobId === null) {
      let found: Awaited<ReturnType<typeof input.transform.findByTag>>;
      try {
        found = await input.transform.findByTag(w.providerTag);
      } catch (cause) {
        return unknown(cause);
      }
      if (found === null)
        return unknown(new Error("Absence does not restore the consumed reference purpose"));
      await invokeVoid(
        "dance.reference.provider.reconcile",
        "SELECT attach_moderated_dance_reference_provider_v1($1,$2,$3,$4)",
        [w.choreographyId, w.token, found.id, found.tag],
      );
      return { outcome: "processing" as const };
    }
    let observed: Awaited<ReturnType<typeof input.transform.showPrivateDance>>;
    try {
      observed = await input.transform.showPrivateDance(w.providerJobId);
    } catch (cause) {
      return unknown(cause);
    }
    if (observed.id !== w.providerJobId || observed.tag !== w.providerTag)
      throw new Error("Reference provider provenance changed");
    if (observed.status === "error") {
      await invokeVoid(
        "dance.reference.provider.failure",
        "SELECT record_moderated_dance_reference_provider_v1($1,$2,$3::jsonb)",
        [
          w.choreographyId,
          w.token,
          JSON.stringify({
            status: "error",
            id: observed.id,
            tag: observed.tag,
            taskFailures: observed.taskFailures ?? [],
          }),
        ],
      );
      return { outcome: "failed" as const };
    }
    if (observed.status !== "finished" || observed.exports === null)
      return { outcome: "processing" as const };
    const controller = new AbortController(),
      remaining = w.deadlineMs - (input.now ?? Date.now)();
    if (remaining <= 0) return { outcome: "expired" as const };
    const timer = setTimeout(() => controller.abort(), Math.min(remaining, 2147483647));
    let frameHashes: readonly string[];
    try {
      frameHashes = decodeModeratedDanceFramehash(
        await readModeratedDanceExport(
          observed.exports.identity,
          1024 * 1024,
          controller.signal,
          input.send ?? fetch,
        ),
        w.profile,
        w.clipDurationSamples / 48,
      );
    } finally {
      clearTimeout(timer);
    }
    const digests = await moderatedDanceReplayDigests({
      scope: w.profile.replayScope,
      sourceSha256: w.source.sha256,
      frames: frameHashes,
      keys,
    });
    const referenceTermsHash = await Effect.runPromise(
      canonicalBodyHash([
        "moderated-canonical-reference-v1",
        w.choreographyId,
        1,
        w.masterRevisionId,
        w.referencePostId,
        w.source.sha256,
        segment.segmentTermsHash,
        w.normalizationHash,
      ]),
    );
    await invokeVoid(
      "dance.reference.publish",
      "SELECT publish_moderated_dance_reference_v1($1,$2,$3::jsonb,$4::jsonb)",
      [
        w.choreographyId,
        w.token,
        JSON.stringify({
          referenceTermsHash,
          segmentTermsHash: segment.segmentTermsHash,
          publicFrames: frameHashes,
        }),
        JSON.stringify(digests.claims),
      ],
    );
    return { outcome: "ready" as const };
  };
  return { run };
}
