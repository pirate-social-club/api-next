import type {
  SongVideoRenderer,
  SongVideoRenderServices,
  SongVideoRenderStore,
} from "@pirate/application/video/song-render";
import { mediaProcessingPhysicalObjectKey } from "./media-immutable-object-key.ts";
import type { QencodeSourceGrantIssuer } from "./qencode-media-transform.ts";
import { makeSongVideoCloudConvertJob } from "./song-video-cloudconvert-job.ts";
import {
  type CloudConvertRenderObservation,
  reconcileCloudConvertRender,
} from "./song-video-cloudconvert-reconcile.ts";
import type { CloudConvertRenderRepository } from "./song-video-cloudconvert-repository.ts";
import {
  CloudConvertTransportError,
  makeSongVideoCloudConvertTransport,
} from "./song-video-cloudconvert-transport.ts";
import {
  makeR2SongVideoOutputStore,
  makeR2SongVideoOutputWriter,
} from "./song-video-master-store.ts";
import { MAX_SONG_VIDEO_MASTER_BYTES } from "./song-video-master-verifier/master-structure.ts";
import { makeSongVideoPcmExcerpt } from "./song-video-pcm-excerpt.ts";
import { makeR2SongVideoPcmRangeReader } from "./song-video-pcm-r2-range.ts";
import { videoSourceCapabilityDigest } from "./video-source-capability.ts";
import { makeVideoSourceUrl } from "./video-source-gateway.ts";

const CLOUDCONVERT_SONG_VIDEO_RENDERER_IDENTITY = "cloudconvert-song-video-pcm-v1";

export function makeCloudConvertRenderCleanup(
  input: Readonly<{
    repository: CloudConvertRenderRepository;
    bucket: Pick<R2Bucket, "delete">;
    jobs: Pick<ReturnType<typeof makeSongVideoCloudConvertTransport>, "findAllByTag" | "remove">;
  }>,
) {
  return async (attemptId: string): Promise<void> => {
    const attempt = await input.repository.read(attemptId);
    if (attempt === null || attempt.cleanupComplete) return;
    await input.repository.revoke(attemptId);
    const found = await input.jobs.findAllByTag(attemptId);
    const ids = new Set(found.map((job) => job.id));
    if (attempt.jobId !== null) ids.add(attempt.jobId);
    for (const id of ids) await input.jobs.remove(id);
    const excerptKeys = new Set(await input.repository.excerptKeys(attemptId));
    // The deterministic attempt key also covers a crash before the grant insert.
    excerptKeys.add(`song-video-excerpts/${attemptId}.wav`);
    for (const key of excerptKeys) await input.bucket.delete(key);
    // Empty lookup after an uncertain create proves nothing. Keep that intent
    // and its capacity occupied for operator reconciliation, with no resend.
    if (!attempt.createStarted || ids.size > 0 || attempt.jobId !== null)
      await input.repository.cleaned(attemptId);
    else
      console.error(
        JSON.stringify({
          event: "song_video_provider_reconciliation",
          attemptId,
          reason: "unresolved_create",
        }),
      );
  };
}

export function makeCloudConvertSongVideoRenderer(
  input: Readonly<{
    repository: CloudConvertRenderRepository;
    store: Pick<SongVideoRenderStore, "executionEvidence" | "recordExecution">;
    bucket: R2Bucket;
    sourceGrants: QencodeSourceGrantIssuer;
    gatewayOrigin: string;
    apiKey: string;
    fetch?: typeof fetch;
    now?: () => number;
  }>,
) {
  const now = input.now ?? Date.now;
  const send = input.fetch ?? fetch;
  const jobs = makeSongVideoCloudConvertTransport({ apiKey: input.apiKey, fetch: send });
  const repo = input.repository;
  const output = makeR2SongVideoOutputStore(input.bucket, MAX_SONG_VIDEO_MASTER_BYTES);
  const writer = makeR2SongVideoOutputWriter(input.bucket);
  const pcmReader = makeR2SongVideoPcmRangeReader(input.bucket);

  const cleanup = makeCloudConvertRenderCleanup({ repository: repo, bucket: input.bucket, jobs });
  const expire = async (attemptId: string): Promise<void> => {
    await repo.requireReconciliation(attemptId);
    console.error(
      JSON.stringify({
        event: "song_video_provider_reconciliation",
        attemptId,
        reason: "provider_wait_expired",
      }),
    );
    await cleanup(attemptId);
  };

  const renderer: SongVideoRenderer = {
    identity: CLOUDCONVERT_SONG_VIDEO_RENDERER_IDENTITY,
    policyRevision: 1,
    reconcile: expire,
    async submit(request) {
      const attempt = await repo.read(request.attemptId);
      if (attempt === null || attempt.outputObjectKey !== request.outputObjectKey)
        throw new Error("CloudConvert attempt binding absent");
      if (attempt.reconciliationRequired || now() >= attempt.deadlineMs) {
        await expire(request.attemptId);
        return { status: "submitted" };
      }
      if (attempt.createStarted) return { status: "submitted" };
      const reference = await repo.reference({
        songAssetId: request.song.assetRef,
        canonicalAudioSha256: request.song.sha256,
        songDurationSamples: request.song.durationSamples,
      });
      if (reference === null) return { status: "refused", reason: "pcm_reference_unavailable" };
      const excerpt = await makeSongVideoPcmExcerpt({
        reference,
        reader: pcmReader,
        clipStartSamples: request.clipStartSamples,
        clipDurationSamples: request.clipDurationSamples,
      });
      await repo.bindPcm(request.attemptId, excerpt.pcmSha256);
      const key = `song-video-excerpts/${request.attemptId}.wav`;
      const object = await input.bucket.put(key, excerpt.wav, {
        onlyIf: new Headers({ "if-none-match": "*" }),
        sha256: excerpt.wavSha256,
        httpMetadata: { contentType: "audio/wav" },
      });
      if (object === null) throw new Error("CloudConvert excerpt write refused");
      const check = await input.bucket.get(key, { onlyIf: { etagMatches: object.etag } });
      if (check === null || !("body" in check))
        throw new Error("CloudConvert excerpt readback unavailable");
      if (
        check.version !== object.version ||
        check.etag !== object.etag ||
        check.size !== excerpt.wav.byteLength
      ) {
        await check.body.cancel();
        await input.bucket.delete(key);
        throw new Error("CloudConvert excerpt identity changed");
      }
      const reread = new Uint8Array(await check.arrayBuffer());
      const digest = await videoSourceCapabilityDigestBytes(reread);
      if (
        check.version !== object.version ||
        check.etag !== object.etag ||
        reread.byteLength !== excerpt.wav.byteLength ||
        digest !== excerpt.wavSha256
      ) {
        await input.bucket.delete(key);
        throw new Error("CloudConvert excerpt readback changed");
      }
      const capability = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");
      const expiresAtMs = Math.min(attempt.deadlineMs, now() + 15 * 60_000);
      try {
        await repo.grant({
          digest: await videoSourceCapabilityDigest(capability),
          attemptId: request.attemptId,
          key,
          version: object.version,
          etag: object.etag,
          sha256: excerpt.wavSha256,
          byteLength: excerpt.wav.byteLength,
          expiresAtMs,
        });
      } catch (error) {
        await input.bucket.delete(key);
        throw error;
      }
      const mediaType = await repo.sourceMediaType(
        request.source.immutableRef,
        request.source.sha256,
        request.source.byteLength,
      );
      if (mediaType === null) {
        await cleanup(request.attemptId);
        return { status: "refused", reason: "sealed_source_unavailable" };
      }
      const source = await input.sourceGrants.issue({
        requestId: request.attemptId,
        objectKey: mediaProcessingPhysicalObjectKey(request.source.immutableRef),
        sha256: request.source.sha256,
        byteLength: request.source.byteLength,
        mediaType,
        expiresAtMs,
      });
      const job = makeSongVideoCloudConvertJob({
        attemptId: request.attemptId,
        sourceUrl: source.url,
        excerptUrl: makeVideoSourceUrl(input.gatewayOrigin, capability),
        clipDurationSamples: request.clipDurationSamples,
      });
      if (!(await repo.beginCreate(request.attemptId))) {
        const current = await repo.read(request.attemptId);
        if (current?.createStarted) return { status: "submitted" };
        await cleanup(request.attemptId);
        return { status: "refused", reason: "provider_capacity_or_deadline" };
      }
      try {
        const created = await makeSongVideoCloudConvertTransport({
          apiKey: input.apiKey,
          fetch: send,
          deadlineMs: attempt.deadlineMs,
          now,
        }).create(job);
        await repo.attachJob(request.attemptId, created.id);
      } catch (error) {
        if (!(error instanceof CloudConvertTransportError)) throw error;
        if (error.outcome === "rejected") {
          await cleanup(request.attemptId);
          await repo.cleaned(request.attemptId);
          return { status: "refused", reason: "provider_rejected" };
        }
        // The create intent already exists. Observation searches by exact tag;
        // neither this helper nor a Workflow retry may send another POST.
      }
      return { status: "submitted" };
    },
    async observe(request) {
      const attempt = await repo.read(request.attemptId);
      if (attempt === null || attempt.outputObjectKey !== request.outputObjectKey)
        throw new Error("CloudConvert attempt binding absent");
      if (attempt.reconciliationRequired || now() >= attempt.deadlineMs) {
        await expire(request.attemptId);
        return { status: "pending" };
      }
      if (!attempt.createStarted || attempt.pcmSha256 === null) return { status: "pending" };
      const evidence = await input.store.executionEvidence(request.outputObjectKey);
      if (evidence?.kind === "refused") {
        await cleanup(request.attemptId);
        return { status: "refused", reason: evidence.reason };
      }
      if (evidence?.kind === "output") {
        const stored = await output.read(request.outputObjectKey);
        if (
          stored !== null &&
          (await videoSourceCapabilityDigestBytes(stored.bytes)) === evidence.sha256 &&
          stored.bytes.byteLength === evidence.byteLength
        )
          return { status: "completed" };
      }
      let observation: CloudConvertRenderObservation;
      try {
        observation = await reconcileCloudConvertRender({
          tag: request.attemptId,
          nowMs: now(),
          now,
          providerWaitDeadlineMs: attempt.deadlineMs,
          expectedSamples: attempt.clipDurationSamples,
          expectedPcmSha256: attempt.pcmSha256,
          jobs: {
            findByTag: async (tag) => {
              const found = await makeSongVideoCloudConvertTransport({
                apiKey: input.apiKey,
                fetch: send,
                deadlineMs: attempt.deadlineMs,
                now,
              }).findByTag(tag);
              if (found !== null) await repo.attachJob(request.attemptId, found.id);
              return found;
            },
            show: makeSongVideoCloudConvertTransport({
              apiKey: input.apiKey,
              fetch: send,
              deadlineMs: attempt.deadlineMs,
              now,
            }).show,
          },
          fetch: send,
        });
      } catch (error) {
        if (now() >= attempt.deadlineMs) {
          await expire(request.attemptId);
          return { status: "pending" };
        }
        throw error;
      }
      if (observation.status === "pending") return { status: "pending" };
      if (observation.status === "operator_reconciliation") {
        await expire(request.attemptId);
        return { status: "pending" };
      }
      if (observation.status === "refused") {
        await input.store.recordExecution(request.outputObjectKey, {
          kind: "refused",
          reason: observation.reason,
        });
        await cleanup(request.attemptId);
        return observation;
      }
      await repo.attachJob(request.attemptId, observation.jobId);
      await input.store.recordExecution(request.outputObjectKey, {
        kind: "output",
        sha256: observation.master.sha256,
        byteLength: observation.master.byteLength,
      });
      await writer.writeOnce(
        request.outputObjectKey,
        observation.master.bytes,
        observation.master.sha256,
      );
      const stored = await output.read(request.outputObjectKey);
      if (
        stored === null ||
        stored.bytes.byteLength !== observation.master.byteLength ||
        (await videoSourceCapabilityDigestBytes(stored.bytes)) !== observation.master.sha256
      )
        throw new Error("CloudConvert master readback changed");
      // Verification at download and sealing both use the admitted PCM oracle.
      if (now() >= attempt.deadlineMs) {
        await expire(request.attemptId);
        return { status: "pending" };
      }
      return { status: "completed" };
    },
  };
  return { renderer, cleanup, expire };
}

async function videoSourceCapabilityDigestBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Cleanup follows durable seal/refusal; replay can finish a lost delete. */
export function withCloudConvertCleanup(
  services: SongVideoRenderServices,
  cleanup: (attemptId: string) => Promise<void>,
  expire: (attemptId: string) => Promise<void>,
): SongVideoRenderServices {
  return {
    renderer: services.renderer,
    store: {
      ...services.store,
      acceptedMaster: async (planId) => {
        const master = await services.store.acceptedMaster(planId);
        if (master !== null) await cleanup(master.attemptId);
        return master;
      },
      sealAndAccept: async (request) => {
        const outcome = await services.store.sealAndAccept(request);
        if (outcome.status === "refused" && outcome.reason === "provider_wait_expired") {
          await expire(request.attempt.attemptId);
        } else await cleanup(request.attempt.attemptId);
        return outcome;
      },
    },
  };
}
