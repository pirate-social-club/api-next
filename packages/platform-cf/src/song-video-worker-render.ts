import type {
  SongVideoExecutionEvidenceStore,
  SongVideoRenderer,
  SongVideoRenderServices,
} from "@pirate/application/video/song-render";
import type { Client } from "pg";
import type { QencodeSourceGrantIssuer } from "./qencode-media-transform.ts";
import {
  makeCloudConvertSongVideoRenderer,
  withCloudConvertCleanup,
} from "./song-video-cloudconvert-renderer.ts";
import { makeCloudConvertRenderRepository } from "./song-video-cloudconvert-repository.ts";
import { makeR2SongVideoOutputStore } from "./song-video-master-store.ts";
import { hashSongVideoMasterAudio } from "./song-video-master-verifier/master-audio.ts";
import { MAX_SONG_VIDEO_MASTER_BYTES } from "./song-video-master-verifier/master-structure.ts";
import type {
  SongVideoOutputProbe,
  SongVideoOutputStore,
} from "./song-video-output-verification.ts";
import { makeSongVideoPcmExcerpt } from "./song-video-pcm-excerpt.ts";
import { pcmSongVideoMasterProbe } from "./song-video-pcm-master-probe.ts";
import { makeR2SongVideoPcmRangeReader } from "./song-video-pcm-r2-range.ts";
import type { SongVideoSoundtrackVerifier } from "./song-video-render-repository.ts";
import { makeSongVideoRenderStore } from "./song-video-render-store.ts";

/**
 * The default Worker path observes the supervised host and refuses fresh seals.
 * Explicit staging CloudConvert configuration instead supplies bounded PCM
 * verification and the database seal. That branch owns its create intent,
 * output transfer and provider cleanup in the existing video Workflow.
 */

export const WORKER_SONG_VIDEO_RENDERER_IDENTITY = "worker-song-video-observer-v1";
export const WORKER_SONG_VIDEO_RENDERER_POLICY_REVISION = 1;

const refusingProbe: SongVideoOutputProbe = { probe: async () => null };
const refusingSoundtrack: SongVideoSoundtrackVerifier = {
  canonicalIntervalDigest: async () => null,
  decodedSoundtrackDigest: async () => null,
};

/**
 * The Worker renderer: submit acknowledges the recorded request, and observe
 * reports a refusal only from persisted refusal evidence. Anything else stays
 * pending until the accepted master is observable, which the workflow checks
 * before it observes.
 */
export function makeWorkerSongVideoRenderer(
  evidence: SongVideoExecutionEvidenceStore,
): SongVideoRenderer {
  return {
    identity: WORKER_SONG_VIDEO_RENDERER_IDENTITY,
    policyRevision: WORKER_SONG_VIDEO_RENDERER_POLICY_REVISION,
    submit: async () => ({ status: "submitted" }),
    observe: async ({ outputObjectKey }) => {
      const record = await evidence.executionEvidence(outputObjectKey);
      return record?.kind === "refused"
        ? { status: "refused", reason: record.reason }
        : { status: "pending" };
    },
  };
}

export function makeWorkerSongVideoRenderServices(
  input: Readonly<{
    connect: () => Promise<Client>;
    output: SongVideoOutputStore;
    transactionSearchPath?: string;
    cloudConvert?: Readonly<{
      bucket: R2Bucket;
      apiKey: string;
      sourceGrants: QencodeSourceGrantIssuer;
      gatewayOrigin: string;
    }>;
  }>,
): SongVideoRenderServices {
  const cloud = input.cloudConvert;
  const repository = makeCloudConvertRenderRepository(input);
  const soundtrack: SongVideoSoundtrackVerifier =
    cloud === undefined
      ? refusingSoundtrack
      : {
          canonicalIntervalDigest: async (interval) => {
            const reference = await repository.reference(interval);
            if (reference === null) return null;
            return (
              await makeSongVideoPcmExcerpt({
                reference,
                reader: makeR2SongVideoPcmRangeReader(cloud.bucket),
                clipStartSamples: interval.clipStartSamples,
                clipDurationSamples: interval.clipDurationSamples,
              })
            ).pcmSha256;
          },
          decodedSoundtrackDigest: async (bytes, samples) => {
            try {
              return (await hashSongVideoMasterAudio(bytes, samples)).pcmSha256;
            } catch {
              return null;
            }
          },
        };
  const store = makeSongVideoRenderStore({
    connect: input.connect,
    output:
      cloud === undefined
        ? input.output
        : makeR2SongVideoOutputStore(cloud.bucket, MAX_SONG_VIDEO_MASTER_BYTES),
    prober: cloud === undefined ? refusingProbe : pcmSongVideoMasterProbe,
    soundtrack,
    ...(input.transactionSearchPath === undefined
      ? {}
      : { transactionSearchPath: input.transactionSearchPath }),
  });
  if (cloud !== undefined) {
    const { renderer, cleanup, expire } = makeCloudConvertSongVideoRenderer({
      ...cloud,
      repository,
      store,
    });
    return withCloudConvertCleanup({ store, renderer }, cleanup, expire);
  }
  return { store, renderer: makeWorkerSongVideoRenderer(store) };
}
