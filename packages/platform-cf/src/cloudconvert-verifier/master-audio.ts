// The package entrypoint loads a browser Worker class in workerd. Its pinned
// main-thread decoder has no public subpath export, so this import is explicit.
import FLACDecoder, {
  _FLACDecoder,
} from "../../../../node_modules/@wasm-audio-decoders/flac/src/FLACDecoder.js";
import {
  CloudConvertMasterRejection,
  inspectCloudConvertMasterStructure,
} from "./master-structure.ts";
import flacModule from "./vendor/flac-decoder.wasm";

type DecodedAudio = {
  readonly errors: readonly unknown[];
  readonly sampleRate: number;
  readonly bitDepth: number;
  readonly channelData: readonly Float32Array[];
  readonly samplesDecoded: number;
};

type Decoder = {
  readonly ready: Promise<void>;
  decodeFrames(frames: readonly Uint8Array[]): Promise<DecodedAudio>;
  free(): void;
};

(_FLACDecoder as { module?: WebAssembly.Module }).module = flacModule as WebAssembly.Module;

/** Verifies exact decoded stereo PCM; container metadata alone is insufficient. */
export async function verifyCloudConvertMasterAudio(
  master: Uint8Array,
  expectedSamples: number,
  expectedPcmSha256: string,
): Promise<{ readonly pcmSha256: string; readonly sampleCount: number }> {
  if (!/^[a-f0-9]{64}$/.test(expectedPcmSha256)) {
    throw new CloudConvertMasterRejection("invalid_expected_pcm_digest");
  }
  const structure = inspectCloudConvertMasterStructure(master, expectedSamples);
  const decoder = new FLACDecoder() as Decoder;
  let decoded: DecodedAudio;
  try {
    await decoder.ready;
    decoded = await decoder.decodeFrames(structure.audioPackets);
  } catch {
    throw new CloudConvertMasterRejection("flac_decode_failed");
  } finally {
    decoder.free();
  }
  if (
    decoded.errors.length !== 0 ||
    decoded.sampleRate !== 48_000 ||
    decoded.bitDepth !== 16 ||
    decoded.channelData.length !== 2 ||
    decoded.samplesDecoded !== expectedSamples ||
    decoded.channelData[0]?.length !== expectedSamples ||
    decoded.channelData[1]?.length !== expectedSamples
  )
    throw new CloudConvertMasterRejection("decoded_audio_shape");
  const pcm = new Uint8Array(expectedSamples * 4);
  const view = new DataView(pcm.buffer);
  for (let index = 0; index < expectedSamples; index++) {
    for (let channel = 0; channel < 2; channel++) {
      const value = decoded.channelData[channel]?.[index];
      if (value === undefined || !Number.isFinite(value) || value < -1 || value > 1) {
        throw new CloudConvertMasterRejection("decoded_audio_sample");
      }
      view.setInt16((index * 2 + channel) * 2, Math.round(value * 32_768), true);
    }
  }
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", pcm));
  const pcmSha256 = Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (pcmSha256 !== expectedPcmSha256) {
    throw new CloudConvertMasterRejection("soundtrack_digest_mismatch");
  }
  return { pcmSha256, sampleCount: expectedSamples };
}
