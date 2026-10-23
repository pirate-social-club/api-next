import { Schema } from "effect";
import { ModeratedDanceIntakeProfile } from "../../application/src/use-cases/dance/moderated-intake.ts";
import { CLOUDCONVERT_STORAGE_HOSTS } from "./cloudconvert-storage-hosts.ts";
import { hmac, sha256Hex } from "./r2-upload-signing.ts";
import { SONG_VIDEO_CLOUDCONVERT_FFMPEG_VERSION } from "./song-video-cloudconvert-recipe.ts";

/** Deterministic body-only image identity. It is replay friction, never a
 * biometric, liveness or near-copy detector. The assigned cue is excluded so
 * copying the same body with a different cue cannot evade this identity.
 * FFmpeg framehash semantics: https://ffmpeg.org/ffmpeg-formats.html#framehash
 */
export function makeModeratedDanceNormalizationJob(
  input: Readonly<{
    tag: string;
    sourceUrl: string;
    bodyStartMs: number;
    bodyEndMs: number;
    profile: ModeratedDanceIntakeProfile;
  }>,
) {
  const p = Schema.decodeUnknownSync(ModeratedDanceIntakeProfile, { onExcessProperty: "error" })(
    input.profile,
  );
  const url = new URL(input.sourceUrl);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(input.tag) ||
    !Number.isSafeInteger(input.bodyStartMs) ||
    input.bodyStartMs < 0 ||
    !Number.isSafeInteger(input.bodyEndMs) ||
    input.bodyEndMs - input.bodyStartMs < 6000 ||
    input.bodyEndMs - input.bodyStartMs > 30000
  )
    throw new TypeError("Invalid private normalization binding");
  const seconds = (ms: number) => (ms / 1000).toFixed(3);
  const body = `trim=start=${seconds(input.bodyStartMs)}:end=${seconds(input.bodyEndMs)},setpts=PTS-STARTPTS,fps=fps=${p.normalizationFps}:start_time=0:round=up:eof_action=pass,scale=${p.normalizationWidth}:${p.normalizationHeight}:flags=bilinear+bitexact,format=gray,settb=expr=1/${p.normalizationFps},setpts=N`;
  const command = (arguments_: string) => ({
    operation: "command",
    input: "import-recording",
    engine: "ffmpeg",
    engine_version: SONG_VIDEO_CLOUDCONVERT_FFMPEG_VERSION,
    command: "ffmpeg",
    arguments: arguments_,
    capture_output: false,
    timeout: p.normalizationTimeoutSeconds,
  });
  // These three full-recording sample positions are part of this versioned
  // recipe, not an automated cue/movement judgment. Every frame is moderated.
  const offsets = [
    0,
    Math.floor(input.bodyStartMs / 2),
    Math.floor((input.bodyStartMs + input.bodyEndMs) / 2),
  ];
  return {
    tag: input.tag,
    tasks: {
      "import-recording": { operation: "import/url", url: input.sourceUrl, filename: "source.mp4" },
      "body-identity": command(
        `-nostdin -v error -fflags +bitexact -i /input/import-recording/source.mp4 -map 0:v:0 -an -vf ${body} -flags:v +bitexact -f framehash -hash SHA256 /output/recording.framehash`,
      ),
      "sample-0": command(
        `-nostdin -v error -i /input/import-recording/source.mp4 -ss ${seconds(offsets[0] ?? 0)} -map 0:v:0 -an -frames:v 1 -vf scale=${p.normalizationWidth}:${p.normalizationHeight}:flags=bilinear -q:v 2 /output/frame-0.jpg`,
      ),
      "sample-1": command(
        `-nostdin -v error -i /input/import-recording/source.mp4 -ss ${seconds(offsets[1] ?? 0)} -map 0:v:0 -an -frames:v 1 -vf scale=${p.normalizationWidth}:${p.normalizationHeight}:flags=bilinear -q:v 2 /output/frame-1.jpg`,
      ),
      "sample-2": command(
        `-nostdin -v error -i /input/import-recording/source.mp4 -ss ${seconds(offsets[2] ?? 0)} -map 0:v:0 -an -frames:v 1 -vf scale=${p.normalizationWidth}:${p.normalizationHeight}:flags=bilinear -q:v 2 /output/frame-2.jpg`,
      ),
      "export-dance": {
        operation: "export/url",
        input: ["body-identity", "sample-0", "sample-1", "sample-2"],
      },
    },
  } as const;
}

/** Reject truncated bodies, extra streams, incompatible dimensions/timebase,
 * malformed hashes and unbounded output BEFORE claiming any replay identity.
 * The provider conformance gate must establish this pinned recipe's actual
 * output format; this parser never invents a successful observation. */
export function decodeModeratedDanceFramehash(
  bytes: Uint8Array,
  profile: ModeratedDanceIntakeProfile,
  bodyDurationMs: number,
): readonly string[] {
  if (bytes.byteLength < 1 || bytes.byteLength > 1024 * 1024)
    throw new TypeError("Invalid framehash bound");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    lines = text.split(/\r?\n/u);
  const frames: string[] = [];
  let timebase = false,
    dimensions = false,
    algorithm = false;
  for (const line of lines) {
    if (line === "") continue;
    if (line.startsWith("#")) {
      if (/^#tb\s+0:\s+1\//u.test(line))
        timebase = line.trim() === `#tb 0: 1/${profile.normalizationFps}`;
      if (/^#dimensions\s+0:/u.test(line))
        dimensions =
          line.trim() ===
          `#dimensions 0: ${profile.normalizationWidth}x${profile.normalizationHeight}`;
      if (/^#hash:/u.test(line)) algorithm = line.trim() === "#hash: SHA256";
      continue;
    }
    const parts = line.split(",").map((s) => s.trim()),
      i = frames.length;
    if (
      parts.length !== 6 ||
      parts[0] !== "0" ||
      parts[1] !== String(i) ||
      parts[2] !== String(i) ||
      parts[3] !== "1" ||
      parts[4] !== String(profile.normalizationWidth * profile.normalizationHeight) ||
      !/^[a-f0-9]{64}$/u.test(parts[5] ?? "")
    )
      throw new TypeError("Invalid normalized frame sequence");
    frames.push(parts[5] ?? "");
  }
  if (
    !timebase ||
    !dimensions ||
    !algorithm ||
    frames.length !== Math.ceil((bodyDurationMs * profile.normalizationFps) / 1000)
  )
    throw new TypeError("Incomplete normalized body");
  return frames;
}

/** Keys are purpose-specific configured secrets. The global scope and raw/body
 * domains exclude all account/persona/session/policy/cue identifiers. Comparing
 * all admitted compatible epochs prevents a key rotation from granting reuse. */
export async function moderatedDanceReplayDigests(
  input: Readonly<{
    scope: string;
    sourceSha256: string;
    frames: readonly string[];
    keys: ReadonlyMap<string, Uint8Array>;
  }>,
) {
  if (
    input.scope.trim() === "" ||
    !/^[a-f0-9]{64}$/u.test(input.sourceSha256) ||
    input.frames.length === 0 ||
    input.frames.some((h) => !/^[a-f0-9]{64}$/u.test(h)) ||
    input.keys.size === 0
  )
    throw new TypeError("Replay evidence unavailable");
  const result: Array<{ epoch: string; kind: "raw" | "body"; digest: string }> = [];
  for (const [epoch, key] of input.keys) {
    if (key.byteLength < 32 || epoch.trim() === "") throw new TypeError("Replay key unavailable");
    for (const kind of ["raw", "body"] as const) {
      const preimage = JSON.stringify([
        "pirate.private-dance-replay.v1",
        input.scope,
        kind,
        kind === "raw" ? input.sourceSha256 : input.frames,
      ]);
      const digest = Array.from(await hmac(key, preimage), (n) =>
        n.toString(16).padStart(2, "0"),
      ).join("");
      result.push({ epoch, kind, digest });
    }
  }
  return {
    claims: result,
    bodyContentDigest: await sha256Hex(new TextEncoder().encode(JSON.stringify(input.frames))),
  };
}

/** Bounded export reader with exact provider host allowlist; no provider bearer,
 * redirect, arbitrary URL, unbounded response.text or silent length mismatch. */
export async function readModeratedDanceExport(
  urlValue: string,
  maximumBytes: number,
  signal: AbortSignal,
  send: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<Uint8Array> {
  const url = new URL(urlValue);
  if (
    url.protocol !== "https:" ||
    !CLOUDCONVERT_STORAGE_HOSTS.includes(url.hostname) ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1
  )
    throw new TypeError("Invalid private export target");
  const response = await send(urlValue, { method: "GET", redirect: "manual", signal });
  const declared = response.headers.get("content-length");
  if (
    response.status !== 200 ||
    response.body === null ||
    (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes))
  ) {
    await response.body?.cancel();
    throw new Error("Private export unavailable");
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximumBytes) throw new Error("Private export exceeds bound");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (size === 0 || (declared !== null && Number(declared) !== size))
    throw new Error("Private export incomplete");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
