import {
  inspectSongVideoMasterStructure,
  SongVideoMasterRejection,
} from "./song-video-master-verifier/master-structure.ts";
import type { SongVideoOutputProbe } from "./song-video-output-verification.ts";

/** The Worker's independent probe over the R2 bytes sealing actually reads. */
export const pcmSongVideoMasterProbe: SongVideoOutputProbe = {
  async probe(bytes, expectedSamples) {
    try {
      inspectSongVideoMasterStructure(bytes, expectedSamples);
      return {
        videoDurationSamples: expectedSamples,
        audioDurationSamples: expectedSamples,
        audioSampleRateHz: 48_000,
        audioChannels: 2,
        hasVideoTrack: true,
      };
    } catch (error) {
      if (error instanceof SongVideoMasterRejection) return null;
      throw error;
    }
  },
};
