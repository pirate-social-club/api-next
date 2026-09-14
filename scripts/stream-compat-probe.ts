/**
 * Cloudflare Stream compatibility probe for song-backed video masters.
 *
 * Authorized by the workspace_owner on 2026-09-10 with a bounded scope: at most
 * two synthetic, rights-safe clips of at most ten seconds (the actual
 * FLAC-in-MP4 renderer output and a PCM-in-MOV equivalent), existing staging
 * capacity only, signed playback, a $1 incremental spending ceiling, and
 * deletion with verification within one hour. It selects no production master
 * format and authorizes no substitute AAC input. Feature flags stay disabled.
 *
 * Phases are separate so nothing is repeated on uncertainty:
 *   prepare      render and prove the inputs locally (no network)
 *   capacity     read-only account and Stream capacity checks
 *   upload       record the intent, create each upload with signed URLs
 *                required, record its id, then send the bytes once
 *   investigate  find probe uploads by name when a creation outcome was lost
 *   observe      poll encoding state
 *   decode       mint a signed token; FFmpeg decodes the delivered HLS
 *   browser      headless Chromium plays the signed HLS through hls.js
 *   delete       delete each video and confirm Stream reports it not found
 *
 * FFmpeg decoding establishes that the delivery decodes and where its samples
 * and frames fall. It does not establish browser or phone playback; the browser
 * phase checks a desktop browser, and a phone remains a separate check.
 *
 * The Stream token is `VIDEO_STREAM_API_TOKEN` from the environment
 * (`infisical run`) and is never printed. Tool errors never carry stderr, which
 * can contain a signed playback URL; a redacted copy goes to the probe
 * directory. The state file records only identifiers, digests and measurements.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mediaSha256Bytes } from "@pirate/application/media/submission-service";
import {
  makeLocalPinnedFfmpegSongVideoEngine,
  SONG_VIDEO_DECODE_CHAIN,
} from "./song-video-ffmpeg.ts";

const CANONICAL_ACCOUNT_ID = "08a4c22cf52e2ecae883e36f80a33f4a";
const SECOND = 48_000;
const FPS = 30;
const CLIP_START = 2 * SECOND + 123;
const CLIP_DURATION = 6 * SECOND + 777;
/** Master-time markers: a white frame and a click at the same instant. */
const MARKER_FRAMES = [30, 120] as const;
const MAX_UPLOADS = 2;

type ProbeFile = {
  label: "flac-mp4" | "pcm-mov";
  path: string;
  sha256: string;
  byteLength: number;
  contentType: string;
  proof: InputProof;
  /**
   * The creation of the Stream upload, recorded before the request. Only a
   * definite refusal lets it be created again; an intended or uncertain
   * creation is investigated by name first.
   */
  creation?: {
    state: "intended" | "created" | "refused" | "uncertain" | "adopted";
    at: string;
    status?: number;
  };
  uid?: string;
  uploadStatus?: number | "uncertain";
  browser?: Record<string, unknown>;
  encoding?: Record<string, unknown>;
  delivered?: Record<string, unknown>;
  deleted?: {
    status: number;
    afterStatus: number;
    afterErrors: unknown;
    verifiedGone: boolean;
    at: string;
  };
};

type InputProof = {
  videoCodec: string;
  audioCodec: string;
  videoDurationSamples: number | null;
  audioDurationSamples: number | null;
  decodedAudioSamples: number;
  decodedAudioSha256: string;
  canonicalIntervalSha256: string;
  videoFrames: number;
};

type State = {
  directory: string;
  createdAt: string;
  files: ProbeFile[];
  log: string[];
};

const directory = process.env.PROBE_DIR ?? "";
if (directory === "") throw new Error("PROBE_DIR is required");
const statePath = join(directory, "state.json");

/** Any URL, signed playback tokens included, is removed from diagnostics. */
const redact = (text: string) => text.replaceAll(/https?:\/\/\S+/gu, "<url>");

async function run(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) {
    // stderr can name a signed playback URL; it never reaches an error.
    await appendFile(
      join(directory, "tool-errors.log"),
      `${new Date().toISOString()} ${command[0]} exit ${code}\n${redact(err).slice(0, 2_000)}\n`,
    ).catch(() => undefined);
    throw new Error(`${command[0]} failed with exit ${code}; redacted detail in tool-errors.log`);
  }
  return out;
}

const ffmpeg = (args: string[]) => run(["ffmpeg", "-v", "error", "-nostdin", "-y", ...args]);

async function loadState(): Promise<State> {
  return JSON.parse(await readFile(statePath, "utf8")) as State;
}
async function saveState(state: State): Promise<void> {
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function streamsOf(path: string) {
  const out = await run([
    "ffprobe",
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type,codec_name,time_base,duration_ts,nb_frames,sample_rate,channels",
    "-of",
    "json",
    path,
  ]);
  return (JSON.parse(out) as { streams: Record<string, string | number>[] }).streams;
}

function samples(stream: Record<string, string | number> | undefined): number | null {
  if (stream === undefined) return null;
  const match = /^(\d+)\/(\d+)$/u.exec(String(stream.time_base));
  if (match === null) return null;
  const value = (Number(stream.duration_ts) * Number(match[1]) * SECOND) / Number(match[2]);
  return Number.isSafeInteger(value) ? value : null;
}

async function decodedAudio(path: string, filter: string | null, out: string) {
  await ffmpeg([
    "-i",
    path,
    "-map",
    "0:a:0",
    ...(filter === null ? [] : ["-af", filter]),
    "-c:a",
    "pcm_s16le",
    "-f",
    "s16le",
    out,
  ]);
  const bytes = new Uint8Array(await readFile(out));
  return { samples: bytes.byteLength / 4, sha256: await mediaSha256Bytes(bytes) };
}

async function prepare(): Promise<void> {
  await mkdir(directory, { recursive: true });
  const song = join(directory, "song.mp3");
  const capture = join(directory, "capture.mp4");
  // Song: a quiet tone with full-scale 2 ms clicks at the markers' song times.
  const clicks = MARKER_FRAMES.map((frame) => {
    const t = (CLIP_START + (frame * SECOND) / FPS) / SECOND;
    return `between(t,${t.toFixed(6)},${(t + 0.002).toFixed(6)})`;
  }).join("+");
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `aevalsrc='0.05*sin(2*PI*440*t)+0.9*(${clicks})':s=44100:d=12`,
    "-ac",
    "2",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "192k",
    song,
  ]);
  // Capture: a test pattern with white frames at the markers, and its own tone,
  // which the master must not carry.
  const flash = MARKER_FRAMES.map((frame) => `eq(n,${frame})`).join("+");
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=360x640:rate=30:duration=8",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:duration=8",
    "-vf",
    `drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='${flash}'`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    capture,
  ]);
  const media = new Map<string, Uint8Array>([
    ["song", new Uint8Array(await readFile(song))],
    ["capture", new Uint8Array(await readFile(capture))],
  ]);
  const engine = makeLocalPinnedFfmpegSongVideoEngine({
    mediaReader: {
      read: async (reference) => {
        const bytes = media.get(reference);
        if (bytes === undefined) throw new Error("missing probe media");
        return bytes;
      },
    },
  });
  const songBytes = media.get("song") as Uint8Array;
  const captureBytes = media.get("capture") as Uint8Array;
  const songSha256 = await mediaSha256Bytes(songBytes);
  const measured = await engine.prober.measure({
    songPostId: "probe-song",
    audioRevision: 1,
    canonicalAudioSha256: songSha256,
    audioAssetRef: "song",
  });
  if (!measured.ok) throw new Error(`song measurement refused: ${measured.failureCode}`);
  const rendered = await engine.render({
    source: {
      reference: "capture",
      sha256: await mediaSha256Bytes(captureBytes),
      byteLength: captureBytes.byteLength,
    },
    song: { reference: "song", sha256: songSha256, durationSamples: measured.durationSamples },
    clipStartSamples: CLIP_START,
    clipDurationSamples: CLIP_DURATION,
  });
  if (!rendered.ok) throw new Error(`render refused: ${rendered.reason}`);
  const flacPath = join(directory, "master-flac.mp4");
  await writeFile(flacPath, rendered.masterBytes);
  // The same samples, uncompressed, in QuickTime; the video is copied.
  const movPath = join(directory, "master-pcm.mov");
  await ffmpeg([
    "-i",
    flacPath,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-c:v",
    "copy",
    "-c:a",
    "pcm_s16le",
    "-video_track_timescale",
    String(SECOND),
    "-f",
    "mov",
    movPath,
  ]);
  const canonical = await decodedAudio(
    join(directory, "song.mp3"),
    `${SONG_VIDEO_DECODE_CHAIN},atrim=start_sample=${CLIP_START}:end_sample=${CLIP_START + CLIP_DURATION}`,
    join(directory, "canonical.pcm"),
  );
  const files: ProbeFile[] = [];
  for (const [label, path, contentType] of [
    ["flac-mp4", flacPath, "video/mp4"],
    ["pcm-mov", movPath, "video/quicktime"],
  ] as const) {
    const bytes = new Uint8Array(await readFile(path));
    const streams = await streamsOf(path);
    const video = streams.find((stream) => stream.codec_type === "video");
    const audio = streams.find((stream) => stream.codec_type === "audio");
    const decoded = await decodedAudio(path, null, join(directory, `${label}.pcm`));
    files.push({
      label,
      path,
      sha256: await mediaSha256Bytes(bytes),
      byteLength: bytes.byteLength,
      contentType,
      proof: {
        videoCodec: String(video?.codec_name),
        audioCodec: String(audio?.codec_name),
        videoDurationSamples: samples(video),
        audioDurationSamples: samples(audio),
        decodedAudioSamples: decoded.samples,
        decodedAudioSha256: decoded.sha256,
        canonicalIntervalSha256: canonical.sha256,
        videoFrames: Number(video?.nb_frames),
      },
    });
  }
  const state: State = {
    directory,
    createdAt: new Date().toISOString(),
    files,
    log: [`prepared ${files.length} inputs; interval ${CLIP_DURATION} samples`],
  };
  await saveState(state);
  console.log(
    JSON.stringify(
      files.map(({ label, sha256, byteLength, proof }) => ({ label, sha256, byteLength, proof })),
      null,
      2,
    ),
  );
}

function credentials() {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const token = process.env.VIDEO_STREAM_API_TOKEN ?? "";
  if (account !== CANONICAL_ACCOUNT_ID) throw new Error("account is not the canonical account");
  if (token === "") throw new Error("VIDEO_STREAM_API_TOKEN is not in the environment");
  return { account, token };
}

async function api(path: string, init: RequestInit = {}) {
  const { account, token } = credentials();
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let body: { success?: boolean; result?: unknown; errors?: { code: number; message: string }[] };
  try {
    body = JSON.parse(text);
  } catch {
    body = { success: false, errors: [{ code: response.status, message: "non-JSON response" }] };
  }
  return { status: response.status, body };
}

async function capacity(): Promise<void> {
  credentials();
  const usage = await api("/stream/storage-usage");
  const listing = await api("/stream?limit=1");
  console.log(
    JSON.stringify({
      account: "canonical",
      storageUsage: {
        status: usage.status,
        success: usage.body.success,
        result: usage.body.result,
        errors: usage.body.errors,
      },
      listing: {
        status: listing.status,
        success: listing.body.success,
        errors: listing.body.errors,
      },
    }),
  );
}

async function upload(): Promise<void> {
  const state = await loadState();
  if (state.files.length > MAX_UPLOADS) throw new Error("more than two uploads");
  for (const file of state.files) {
    if (file.uid !== undefined) continue;
    if (file.creation !== undefined && file.creation.state !== "refused") {
      // A creation that may have happened is found by name, never repeated.
      state.log.push(
        `${file.label}: creation ${file.creation.state}; investigate, not created again`,
      );
      await saveState(state);
      throw new Error(`${file.label} creation is ${file.creation.state}: run investigate`);
    }
    file.creation = { state: "intended", at: new Date().toISOString() };
    state.log.push(`${file.label}: creation intended`);
    await saveState(state);
    let created: Awaited<ReturnType<typeof api>>;
    try {
      created = await api("/stream/direct_upload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          maxDurationSeconds: 10,
          requireSignedURLs: true,
          meta: { name: `pirate-stream-compat-probe-${file.label}` },
        }),
      });
    } catch {
      file.creation = { state: "uncertain", at: new Date().toISOString() };
      state.log.push(`${file.label}: creation response lost`);
      await saveState(state);
      throw new Error(`${file.label} creation is uncertain: run investigate`);
    }
    const result = created.body.result as { uid?: string; uploadURL?: string } | undefined;
    if (
      created.body.success === true &&
      result?.uid !== undefined &&
      result.uploadURL !== undefined
    ) {
      file.creation = { state: "created", at: new Date().toISOString(), status: created.status };
      file.uid = result.uid;
      file.uploadStatus = "uncertain";
      state.log.push(`${file.label}: created ${file.uid}`);
      await saveState(state);
    } else {
      // A definite client-side refusal created nothing. Anything else might have.
      const definite =
        created.body.success === false && created.status >= 400 && created.status < 500;
      file.creation = {
        state: definite ? "refused" : "uncertain",
        at: new Date().toISOString(),
        status: created.status,
      };
      state.log.push(`${file.label}: creation ${file.creation.state} (${created.status})`);
      await saveState(state);
      throw new Error(
        `${file.label} creation ${file.creation.state}: ${JSON.stringify(created.body.errors)}`,
      );
    }
    try {
      const form = new FormData();
      form.append(
        "file",
        new Blob([new Uint8Array(await readFile(file.path))], { type: file.contentType }),
        file.label === "flac-mp4" ? "master-flac.mp4" : "master-pcm.mov",
      );
      const sent = await fetch(result.uploadURL, { method: "POST", body: form });
      file.uploadStatus = sent.status;
      state.log.push(`${file.label}: bytes sent (${sent.status})`);
    } catch {
      state.log.push(`${file.label}: transfer uncertain; observe by id, do not resend`);
    }
    await saveState(state);
  }
  console.log(
    JSON.stringify(
      state.files.map(({ label, creation, uid, uploadStatus }) => ({
        label,
        creation,
        uid,
        uploadStatus,
      })),
    ),
  );
}

/** Probe uploads found by name; one match for an unresolved creation is adopted. */
async function investigate(): Promise<void> {
  const state = await loadState();
  const listed = await api("/stream?search=pirate-stream-compat-probe");
  const videos = ((listed.body.result as Record<string, unknown>[] | undefined) ?? []).map(
    (video) => ({
      uid: String(video.uid),
      name: String((video.meta as Record<string, unknown> | undefined)?.name ?? ""),
      created: video.created,
      state: (video.status as Record<string, unknown> | undefined)?.state,
    }),
  );
  for (const file of state.files) {
    if (file.uid !== undefined || file.creation === undefined) continue;
    if (file.creation.state !== "intended" && file.creation.state !== "uncertain") continue;
    const matches = videos.filter(
      (video) => video.name === `pirate-stream-compat-probe-${file.label}`,
    );
    if (matches.length === 1 && matches[0] !== undefined) {
      file.uid = matches[0].uid;
      file.creation = { state: "adopted", at: new Date().toISOString() };
      state.log.push(`${file.label}: adopted ${file.uid} found by name`);
    } else {
      state.log.push(`${file.label}: ${matches.length} uploads found by name; left unresolved`);
    }
  }
  await saveState(state);
  console.log(
    JSON.stringify({
      status: listed.status,
      videos,
      files: state.files.map(({ label, creation, uid }) => ({ label, creation, uid })),
    }),
  );
}

async function observe(): Promise<void> {
  const state = await loadState();
  for (const file of state.files) {
    if (file.uid === undefined) continue;
    const found = await api(`/stream/${file.uid}`);
    const video = found.body.result as Record<string, unknown> | undefined;
    file.encoding = {
      at: new Date().toISOString(),
      status: found.status,
      readyToStream: video?.readyToStream,
      state: (video?.status as Record<string, unknown> | undefined)?.state,
      errorReasonCode: (video?.status as Record<string, unknown> | undefined)?.errorReasonCode,
      errorReasonText: (video?.status as Record<string, unknown> | undefined)?.errorReasonText,
      duration: video?.duration,
      size: video?.size,
      input: video?.input,
      requireSignedURLs: video?.requireSignedURLs,
      allowedOrigins: video?.allowedOrigins,
      errors: found.body.errors,
    };
  }
  await saveState(state);
  console.log(
    JSON.stringify(state.files.map(({ label, uid, encoding }) => ({ label, uid, encoding }))),
  );
}

/** Onsets of full-scale clicks, in seconds, from interleaved stereo s16le. */
function clickOnsets(pcm: Uint8Array, rate: number): number[] {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const onsets: number[] = [];
  let quietUntil = 0;
  for (let frame = 0; frame * 4 + 3 < pcm.byteLength; frame += 1) {
    const left = Math.abs(view.getInt16(frame * 4, true));
    if (frame >= quietUntil && left > 16_000) {
      onsets.push(frame / rate);
      quietUntil = frame + rate / 4;
    }
  }
  return onsets;
}

/**
 * FFmpeg's HLS client over a manifest URL: every segment of the lowest
 * rendition is fetched and decoded, audio to PCM and video to per-frame luma.
 * This establishes decoding and timing, not browser or phone playback.
 */
async function measureDelivered(
  manifestUrl: string,
  base: string,
): Promise<Record<string, unknown>> {
  const master = await fetch(manifestUrl);
  const masterText = await master.text();
  const lines = masterText.split("\n");
  const audioUri = /TYPE=AUDIO[^\n]*URI="([^"]+)"/u.exec(masterText)?.[1];
  const variants = lines
    .map((line, index) => ({ line, next: lines[index + 1] ?? "" }))
    .filter(({ line }) => line.startsWith("#EXT-X-STREAM-INF"))
    .map(({ line, next }) => ({
      bandwidth: Number(/BANDWIDTH=(\d+)/u.exec(line)?.[1] ?? 0),
      uri: next.trim(),
    }))
    .sort((left, right) => left.bandwidth - right.bandwidth);
  const resolve = (uri: string) => new URL(uri, manifestUrl).toString();
  const variant = variants[0];
  const audioUrl = audioUri === undefined ? undefined : resolve(audioUri);
  const videoUrl = variant === undefined ? undefined : resolve(variant.uri);
  const audioSource = audioUrl ?? videoUrl;
  if (audioSource === undefined || videoUrl === undefined) {
    return { decoded: false, reason: "manifest without renditions" };
  }
  // FFmpeg's HLS client fetches every segment over the signed URL and decodes
  // it, audio to PCM and video to per-frame luma.
  await ffmpeg([
    "-i",
    audioSource,
    "-map",
    "0:a:0",
    "-ac",
    "2",
    "-ar",
    "48000",
    "-c:a",
    "pcm_s16le",
    "-f",
    "s16le",
    `${base}.pcm`,
  ]);
  const audioProbe = JSON.parse(
    await run([
      "ffprobe",
      "-v",
      "error",
      "-show_entries",
      "stream=codec_name,sample_rate,channels,start_time,duration:format=start_time,duration",
      "-select_streams",
      "a:0",
      "-of",
      "json",
      audioSource,
    ]),
  );
  const videoProbe = JSON.parse(
    await run([
      "ffprobe",
      "-v",
      "error",
      "-show_entries",
      "stream=codec_name,width,height,start_time,duration,avg_frame_rate",
      "-select_streams",
      "v:0",
      "-of",
      "json",
      videoUrl,
    ]),
  );
  // Frame timestamps and durations on the delivered timeline, then per-frame
  // mean luma. Blank lines are dropped before parsing: Number("") is zero.
  const frameRows = (
    await run([
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "frame=best_effort_timestamp_time,duration_time",
      "-of",
      "csv=p=0",
      videoUrl,
    ])
  )
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const [time, duration] = line.split(",");
      return {
        time: Number(time),
        duration: duration === undefined ? Number.NaN : Number(duration),
      };
    });
  if (frameRows.some((row) => !Number.isFinite(row.time)))
    throw new Error("a delivered frame has no timestamp");
  const frameTimes = frameRows.map((row) => row.time);
  await ffmpeg([
    "-i",
    videoUrl,
    "-map",
    "0:v:0",
    "-vf",
    "scale=8:8,format=gray",
    "-f",
    "rawvideo",
    `${base}.gray`,
  ]);
  const gray = new Uint8Array(await readFile(`${base}.gray`));
  const frameCount = gray.byteLength / 64;
  const flashes: number[] = [];
  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0;
    for (let pixel = 0; pixel < 64; pixel += 1) sum += gray[frame * 64 + pixel] ?? 0;
    if (sum / 64 > 230) flashes.push(frameTimes[frame] ?? Number.NaN);
  }
  if (frameCount !== frameRows.length)
    throw new Error("decoded frames and frame timestamps disagree");
  const pcm = new Uint8Array(await readFile(`${base}.pcm`));
  const audioStart = Number(audioProbe.streams?.[0]?.start_time ?? Number.NaN);
  const firstFrame = frameTimes[0] ?? Number.NaN;
  const last = frameRows.at(-1);
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  // Everything relative to the first delivered video frame.
  const clicks = clickOnsets(pcm, SECOND).map((onset) => round(audioStart + onset - firstFrame));
  const flashTimes = flashes.map((time) => round(time - firstFrame));
  return {
    decoded: true,
    signedManifestStatus: master.status,
    renditions: variants.length,
    separateAudioRendition: audioUri !== undefined,
    audio: audioProbe.streams?.[0],
    video: videoProbe.streams?.[0],
    decodedAudioSamples: pcm.byteLength / 4,
    decodedVideoFrames: frameCount,
    audioStartSeconds: round(audioStart - firstFrame),
    audioEndSeconds: round(audioStart + pcm.byteLength / 4 / SECOND - firstFrame),
    // The delivered final frame's own duration, not an assumed frame rate.
    videoEndSeconds:
      last === undefined || !Number.isFinite(last.duration)
        ? null
        : round(last.time + last.duration - firstFrame),
    clickSeconds: clicks,
    flashSeconds: flashTimes,
    syncErrorMs: flashTimes.map((flash, index) =>
      clicks[index] === undefined ? null : round((clicks[index] - flash) * 1_000),
    ),
    expectedMarkerSeconds: MARKER_FRAMES.map((frame) => round(frame / FPS)),
    inputDurationSeconds: round(CLIP_DURATION / SECOND),
  };
}

async function decode(): Promise<void> {
  const state = await loadState();
  for (const file of state.files) {
    if (file.uid === undefined) continue;
    const signed = await signedManifest(file.uid);
    if ("reason" in signed) {
      file.delivered = { decoded: false, reason: signed.reason };
      continue;
    }
    // Unsigned playback must be refused for a signed-URL video.
    const unsigned = await fetch(signed.unsignedUrl);
    file.delivered = {
      unsignedStatus: unsigned.status,
      ...(await measureDelivered(
        signed.manifestUrl,
        join(state.directory, `delivered-${file.label}`),
      )),
    };
  }
  await saveState(state);
  console.log(
    JSON.stringify(
      state.files.map(({ label, delivered }) => ({ label, delivered })),
      null,
      2,
    ),
  );
}

/** A signed manifest URL for a ready video; the token lives for 30 minutes. */
async function signedManifest(
  uid: string,
): Promise<{ manifestUrl: string; unsignedUrl: string } | { reason: string }> {
  const details = await api(`/stream/${uid}`);
  const video = details.body.result as
    | { playback?: { hls?: string }; readyToStream?: boolean }
    | undefined;
  if (!video?.readyToStream || video.playback?.hls === undefined)
    return { reason: "not ready to stream" };
  const minted = await api(`/stream/${uid}/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 1_800 }),
  });
  const token = (minted.body.result as { token?: string } | undefined)?.token;
  if (token === undefined) return { reason: `token refused (${minted.status})` };
  return {
    manifestUrl: video.playback.hls.replace(`/${uid}/`, `/${token}/`),
    unsignedUrl: video.playback.hls,
  };
}

/**
 * Desktop browser playback, delegated to `stream-compat-probe-browser.mjs`
 * under Node: headless Chromium plays the HLS through hls.js with sound. The
 * signed URL is passed in the environment, never in argv, and nothing the
 * helper prints carries a URL. A phone is not covered.
 */
async function playInBrowser(
  manifestUrl: string,
  origin: string,
  localDelivery: boolean,
): Promise<Record<string, unknown>> {
  const playwrightModule = process.env.PLAYWRIGHT_MODULE ?? "";
  const hlsPath = process.env.HLS_JS_PATH ?? "";
  if (playwrightModule === "" || hlsPath === "")
    throw new Error("PLAYWRIGHT_MODULE and HLS_JS_PATH are required");
  const child = Bun.spawn(["node", join(import.meta.dir, "stream-compat-probe-browser.mjs")], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      PROBE_MANIFEST_URL: manifestUrl,
      PROBE_PAGE_ORIGIN: origin,
      PLAYWRIGHT_MODULE: playwrightModule,
      HLS_JS_PATH: hlsPath,
      ...(localDelivery ? { PROBE_LOCAL_DELIVERY: "1" } : {}),
    },
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (err.trim() !== "")
    await appendFile(
      join(directory, "tool-errors.log"),
      `${new Date().toISOString()} browser exit ${code}\n${redact(err).slice(0, 2_000)}\n`,
    ).catch(() => undefined);
  const line = out.trim().split("\n").at(-1) ?? "";
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { played: false, reason: `browser helper exit ${code}` };
  }
}

async function browser(): Promise<void> {
  const state = await loadState();
  for (const file of state.files) {
    if (file.uid === undefined) continue;
    const signed = await signedManifest(file.uid);
    file.browser =
      "reason" in signed
        ? { played: false, reason: signed.reason }
        : await playInBrowser(signed.manifestUrl, "https://probe.invalid/", false);
  }
  await saveState(state);
  console.log(
    JSON.stringify(
      state.files.map(({ label, browser: seen }) => ({ label, browser: seen })),
      null,
      2,
    ),
  );
}

/**
 * Offline rehearsal of the measuring tools, with no upload: the proven FLAC
 * master is packaged locally as HLS with AAC audio, served on localhost with
 * permissive cross-origin headers, then measured by FFmpeg and played in the
 * browser exactly as the live phases do. It checks the tools, not Stream.
 */
async function rehearse(): Promise<void> {
  const state = await loadState();
  const master = state.files.find((file) => file.label === "flac-mp4");
  if (master === undefined) throw new Error("prepare first");
  const hlsDirectory = join(state.directory, "rehearsal");
  await mkdir(hlsDirectory, { recursive: true });
  await ffmpeg([
    "-i",
    master.path,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-f",
    "hls",
    "-hls_time",
    "2",
    "-hls_playlist_type",
    "vod",
    "-hls_segment_filename",
    join(hlsDirectory, "segment%03d.ts"),
    join(hlsDirectory, "media.m3u8"),
  ]);
  await writeFile(
    join(hlsDirectory, "manifest.m3u8"),
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000,CODECS="avc1.64001e,mp4a.40.2"\nmedia.m3u8\n',
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const name = new URL(request.url).pathname.split("/").pop() ?? "";
      if (!/^[a-z0-9]+\.(m3u8|ts)$/u.test(name)) return new Response(null, { status: 404 });
      const file = Bun.file(join(hlsDirectory, name));
      if (!(await file.exists())) return new Response(null, { status: 404 });
      return new Response(file, {
        headers: {
          "access-control-allow-origin": "*",
          "content-type": name.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t",
        },
      });
    },
  });
  const manifestUrl = `http://127.0.0.1:${server.port}/manifest.m3u8`;
  try {
    const delivered = await measureDelivered(
      manifestUrl,
      join(state.directory, "rehearsal-delivered"),
    );
    const played = await playInBrowser(manifestUrl, "http://probe.invalid/", true);
    const report = { delivered, browser: played };
    await writeFile(
      join(state.directory, "rehearsal.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    server.stop(true);
  }
}

async function remove(): Promise<void> {
  const state = await loadState();
  for (const file of state.files) {
    if (file.uid === undefined) continue;
    const deleted = await api(`/stream/${file.uid}`, { method: "DELETE" });
    const after = await api(`/stream/${file.uid}`);
    // Only an explicit not-found confirms deletion. A 403, a server failure or
    // any other refusal leaves the video unaccounted for.
    const notFound =
      after.status === 404 &&
      after.body.success === false &&
      (after.body.errors ?? []).some((error) => /not found/iu.test(error.message));
    file.deleted = {
      status: deleted.status,
      afterStatus: after.status,
      afterErrors: after.body.errors,
      verifiedGone: notFound,
      at: new Date().toISOString(),
    };
    state.log.push(`${file.label}: delete ${deleted.status}, afterwards ${after.status}`);
  }
  await saveState(state);
  console.log(
    JSON.stringify(state.files.map(({ label, uid, deleted }) => ({ label, uid, deleted }))),
  );
}

const phase = process.argv[2];
const phases: Record<string, () => Promise<void>> = {
  prepare,
  capacity,
  upload,
  investigate,
  observe,
  decode,
  browser,
  rehearse,
  delete: remove,
};
const selected = phase === undefined ? undefined : phases[phase];
if (selected === undefined)
  throw new Error(`phase must be one of ${Object.keys(phases).join(", ")}`);
await selected();
