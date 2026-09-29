import { downloadSongVideoCloudConvertMaster } from "./song-video-cloudconvert-download.ts";
import { verifySongVideoMasterAudio } from "./song-video-master-verifier/master-audio.ts";

export type VerifiedCloudConvertMaster = Readonly<{
  bytes: Uint8Array;
  sha256: string;
  byteLength: number;
  soundtrackSha256: string;
}>;

/**
 * Provider completion is not sealing evidence. Inspect the exact downloaded
 * master against the frozen PCM excerpt before it can enter the output store.
 * The export URL is never included in an error or returned to the caller.
 */
export async function verifyCloudConvertExport(
  input: Readonly<{
    exportUrl: string;
    expectedSamples: number;
    expectedPcmSha256: string;
    fetch: (url: string, init: RequestInit) => Promise<Response>;
  }>,
): Promise<VerifiedCloudConvertMaster> {
  const downloaded = await downloadSongVideoCloudConvertMaster(input);
  const soundtrack = await verifySongVideoMasterAudio(
    downloaded.bytes,
    input.expectedSamples,
    input.expectedPcmSha256,
  );
  return {
    bytes: downloaded.bytes,
    sha256: downloaded.sha256,
    byteLength: downloaded.bytes.byteLength,
    soundtrackSha256: soundtrack.pcmSha256,
  };
}
