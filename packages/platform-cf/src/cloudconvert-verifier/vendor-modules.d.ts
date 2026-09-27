declare module "*@wasm-audio-decoders/flac/src/FLACDecoder.js" {
  export const _FLACDecoder: { module?: WebAssembly.Module };
  export default class FLACDecoder {
    readonly ready: Promise<void>;
    decodeFrames(frames: readonly Uint8Array[]): Promise<{
      readonly errors: readonly unknown[];
      readonly sampleRate: number;
      readonly bitDepth: number;
      readonly channelData: readonly Float32Array[];
      readonly samplesDecoded: number;
    }>;
    free(): void;
  }
}

declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
