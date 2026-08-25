import { Predicate } from "effect";
import {
  ELEVENLABS_ASR_HARD_MAX_AUDIO_BYTES,
  ELEVENLABS_ASR_HARD_MAX_MULTIPART_BYTES,
  type ElevenLabsAsrAudioSource,
  type ElevenLabsAsrRandomBytes,
  type ElevenLabsAsrRequestBody,
} from "./elevenlabs-asr-types.ts";

const BOUNDARY_PREFIX = "pirate-elevenlabs-asr-" as const;
const BOUNDARY_RANDOM_BYTES = 18 as const;

export class ElevenLabsAsrBodyError extends Error {
  readonly reason: "audio_length_mismatch" | "boundary_collision" | "invalid_audio_chunk";

  constructor(reason: ElevenLabsAsrBodyError["reason"]) {
    super(reason);
    this.name = "ElevenLabsAsrBodyError";
    this.reason = reason;
  }
}

function cryptographicRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function makeBoundary(randomBytes: ElevenLabsAsrRandomBytes): string | null {
  let bytes: Uint8Array;
  try {
    bytes = randomBytes(BOUNDARY_RANDOM_BYTES);
  } catch {
    return null;
  }
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== BOUNDARY_RANDOM_BYTES) return null;
  return `${BOUNDARY_PREFIX}${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.byteLength === 0 || needle.byteLength > haystack.byteLength) return false;
  outer: for (let offset = 0; offset <= haystack.byteLength - needle.byteLength; offset += 1) {
    for (let index = 0; index < needle.byteLength; index += 1) {
      if (haystack[offset + index] !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}

function prefixTable(pattern: Uint8Array): Uint32Array {
  const table = new Uint32Array(pattern.byteLength);
  for (let index = 1, matched = 0; index < pattern.byteLength; index += 1) {
    while (matched > 0 && pattern[index] !== pattern[matched]) matched = table[matched - 1] ?? 0;
    if (pattern[index] === pattern[matched]) matched += 1;
    table[index] = matched;
  }
  return table;
}

function boundaryMatch(
  chunk: Uint8Array,
  boundary: Uint8Array,
  table: Uint32Array,
  startingMatch: number,
): { readonly collision: boolean; readonly match: number } {
  let matched = startingMatch;
  for (const byte of chunk) {
    while (matched > 0 && byte !== boundary[matched]) matched = table[matched - 1] ?? 0;
    if (byte === boundary[matched]) matched += 1;
    if (matched === boundary.byteLength) return { collision: true, match: matched };
  }
  return { collision: false, match: matched };
}

function validFilename(value: string | undefined): value is string | undefined {
  return (
    value === undefined ||
    (value.length > 0 &&
      value.length <= 128 &&
      !value.includes("/") &&
      !value.includes("\\") &&
      !value.includes('"') &&
      value.trim() === value &&
      [...value].every((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint >= 0x20 && !(codePoint >= 0x7f && codePoint <= 0x9f);
      }))
  );
}

/** Encodes the fixed synchronous STT request without retaining a second audio copy. */
export function encodeElevenLabsAsrMultipart(
  input: Readonly<{
    readonly audio: ElevenLabsAsrAudioSource;
    readonly model: string;
    readonly random_bytes?: ElevenLabsAsrRandomBytes;
  }>,
): ElevenLabsAsrRequestBody | null {
  if (
    !Predicate.isObject(input.audio) ||
    !Predicate.isFunction(input.audio.open) ||
    !Number.isSafeInteger(input.audio.byteLength) ||
    input.audio.byteLength <= 0 ||
    input.audio.byteLength > ELEVENLABS_ASR_HARD_MAX_AUDIO_BYTES ||
    !/^audio\/[a-z0-9][a-z0-9.+-]*$/u.test(input.audio.mime_type) ||
    !validFilename(input.audio.filename)
  ) {
    return null;
  }
  const boundary = makeBoundary(input.random_bytes ?? cryptographicRandomBytes);
  if (boundary === null) return null;
  const encoder = new TextEncoder();
  const boundaryBytes = encoder.encode(boundary);
  const fields = [
    ["model_id", input.model],
    ["tag_audio_events", "true"],
    ["timestamps_granularity", "word"],
    ["diarize", "false"],
    ["webhook", "false"],
    ["temperature", "0"],
    ["use_multi_channel", "false"],
  ] as const;
  const filename = input.audio.filename ?? "song-audio.bin";
  const fileHeader = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${input.audio.mime_type}\r\n\r\n`,
  );
  const fieldChunks = fields.map(([name, value]) =>
    encoder.encode(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}`,
    ),
  );
  const closing = encoder.encode(`\r\n--${boundary}--\r\n`);
  if (containsBytes(encoder.encode(input.model), boundaryBytes)) return null;
  const byteLength =
    fileHeader.byteLength +
    input.audio.byteLength +
    fieldChunks.reduce((total, chunk) => total + chunk.byteLength, 0) +
    closing.byteLength;
  if (byteLength > ELEVENLABS_ASR_HARD_MAX_MULTIPART_BYTES) return null;

  const source = input.audio;
  return {
    byteLength,
    contentType: `multipart/form-data; boundary=${boundary}`,
    open: async function* (signal?: AbortSignal) {
      if (signal?.aborted) throw new DOMException("cancelled", "AbortError");
      yield fileHeader;
      let actualAudioBytes = 0;
      const table = prefixTable(boundaryBytes);
      let matched = 0;
      for await (const chunk of source.open(signal)) {
        if (signal?.aborted) throw new DOMException("cancelled", "AbortError");
        if (!(chunk instanceof Uint8Array)) throw new ElevenLabsAsrBodyError("invalid_audio_chunk");
        actualAudioBytes += chunk.byteLength;
        if (actualAudioBytes > source.byteLength) {
          throw new ElevenLabsAsrBodyError("audio_length_mismatch");
        }
        const boundary = boundaryMatch(chunk, boundaryBytes, table, matched);
        if (boundary.collision) throw new ElevenLabsAsrBodyError("boundary_collision");
        matched = boundary.match;
        yield chunk;
      }
      if (actualAudioBytes !== source.byteLength) {
        throw new ElevenLabsAsrBodyError("audio_length_mismatch");
      }
      for (const chunk of fieldChunks) yield chunk;
      yield closing;
    },
  };
}
