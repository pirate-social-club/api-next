import {
  CloudConvertMasterRejection,
  inspectCloudConvertMasterStructure,
} from "./master-structure.ts";

/** Exact stereo s16le soundtrack verification without a codec decoder. */
export async function verifyCloudConvertMasterAudio(
  master: Uint8Array,
  expectedSamples: number,
  expectedPcmSha256: string,
): Promise<{ readonly pcmSha256: string; readonly sampleCount: number }> {
  if (!/^[a-f0-9]{64}$/.test(expectedPcmSha256)) {
    throw new CloudConvertMasterRejection("invalid_expected_pcm_digest");
  }
  const structure = inspectCloudConvertMasterStructure(master, expectedSamples);
  const pcm = new Uint8Array(expectedSamples * 4);
  let offset = 0;
  for (const chunk of structure.audioChunks) {
    if (offset + chunk.byteLength > pcm.byteLength) {
      throw new CloudConvertMasterRejection("decoded_audio_shape");
    }
    pcm.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== pcm.byteLength) throw new CloudConvertMasterRejection("decoded_audio_shape");
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", pcm));
  const pcmSha256 = Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (pcmSha256 !== expectedPcmSha256) {
    throw new CloudConvertMasterRejection("soundtrack_digest_mismatch");
  }
  return { pcmSha256, sampleCount: expectedSamples };
}
