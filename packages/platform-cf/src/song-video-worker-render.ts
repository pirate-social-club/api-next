import type {
  SongVideoExecutionEvidenceStore,
  SongVideoRenderer,
  SongVideoRenderServices,
} from "@pirate/application/video/song-render";
import type { Client } from "pg";
import type {
  SongVideoOutputProbe,
  SongVideoOutputStore,
} from "./song-video-output-verification.ts";
import type { SongVideoSoundtrackVerifier } from "./song-video-render-repository.ts";
import { makeSongVideoRenderStore } from "./song-video-render-store.ts";

/**
 * The media-processor Worker's side of the render stage.
 *
 * The Worker cannot run FFmpeg, so it does not render. Its renderer
 * acknowledges the submission, whose request the attempt row already records,
 * and observes only the execution evidence a host writes. The host claims that
 * same attempt row, renders the frozen interval, writes the output, seals and
 * accepts; the Worker's polling loop sees the accepted master through the
 * store. Nothing here starts another queue or orchestration service.
 *
 * The prober and soundtrack verifier refuse rather than approximate, so a seal
 * attempted through this store can only succeed by replaying a seal the host
 * already persisted. A fresh seal fails closed here, which keeps the Worker
 * from turning unverified bytes into a master if that boundary is ever
 * reached.
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
  }>,
): SongVideoRenderServices {
  const store = makeSongVideoRenderStore({
    connect: input.connect,
    output: input.output,
    prober: refusingProbe,
    soundtrack: refusingSoundtrack,
    ...(input.transactionSearchPath === undefined
      ? {}
      : { transactionSearchPath: input.transactionSearchPath }),
  });
  return { store, renderer: makeWorkerSongVideoRenderer(store) };
}
