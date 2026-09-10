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
 *   prepare   render and prove the inputs locally (no network)
 *   capacity  read-only account and Stream capacity checks
 *   upload    create each upload with signed URLs required, then send bytes once
 *   observe   poll encoding state
 *   play      mint a signed token, decode the delivered HLS, measure
 *   delete    delete each video and verify it is gone
 *
 * Credentials come from the environment (`infisical run`) and are never
 * printed. The state file records only identifiers, digests and measurements.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  uid?: string;
  uploadStatus?: number | "uncertain";
  encoding?: Record<string, unknown>;
  delivered?: Record<string, unknown>;
  deleted?: { status: number; verifiedGone: boolean; at: string };
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

async function run(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`${command[0]} failed: ${err.slice(0, 400)}`);
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
  const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
  if (account !== CANONICAL_ACCOUNT_ID) throw new Error("account is not the canonical account");
  if (token === "") throw new Error("no Cloudflare API token in the environment");
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
  const pending = state.files.filter((file) => file.uid === undefined);
  const already = state.files.length - pending.length;
  if (already + pending.length > MAX_UPLOADS) throw new Error("more than two uploads");
  for (const file of pending) {
    // The upload is created, and its id recorded, before any bytes are sent, so
    // an uncertain transfer is investigated by id rather than repeated.
    const created = await api("/stream/direct_upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        maxDurationSeconds: 10,
        requireSignedURLs: true,
        meta: { name: `pirate-stream-compat-probe-${file.label}` },
      }),
    });
    const result = created.body.result as { uid?: string; uploadURL?: string } | undefined;
    if (!created.body.success || result?.uid === undefined || result.uploadURL === undefined) {
      state.log.push(`${file.label}: direct upload not created (${created.status})`);
      await saveState(state);
      throw new Error(`direct upload refused: ${JSON.stringify(created.body.errors)}`);
    }
    file.uid = result.uid;
    file.uploadStatus = "uncertain";
    state.log.push(`${file.label}: created ${file.uid}`);
    await saveState(state);
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
    } catch (error) {
      state.log.push(`${file.label}: transfer uncertain (${String(error).slice(0, 120)})`);
    }
    await saveState(state);
  }
  console.log(
    JSON.stringify(
      state.files.map(({ label, uid, uploadStatus }) => ({ label, uid, uploadStatus })),
    ),
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

async function play(): Promise<void> {
  const state = await loadState();
  for (const file of state.files) {
    if (file.uid === undefined) continue;
    const details = await api(`/stream/${file.uid}`);
    const video = details.body.result as
      | { playback?: { hls?: string }; readyToStream?: boolean }
      | undefined;
    if (!video?.readyToStream || video.playback?.hls === undefined) {
      file.delivered = { playable: false, reason: "not ready to stream" };
      continue;
    }
    const minted = await api(`/stream/${file.uid}/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 1_800 }),
    });
    const token = (minted.body.result as { token?: string } | undefined)?.token;
    if (token === undefined) {
      file.delivered = { playable: false, reason: `token refused (${minted.status})` };
      continue;
    }
    const manifestUrl = video.playback.hls.replace(`/${file.uid}/`, `/${token}/`);
    // Unsigned playback must be refused for a signed-URL video.
    const unsigned = await fetch(video.playback.hls);
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
    const base = join(state.directory, `delivered-${file.label}`);
    const audioSource = audioUrl ?? videoUrl;
    if (audioSource === undefined || videoUrl === undefined) {
      file.delivered = {
        playable: false,
        reason: "manifest without renditions",
        unsignedStatus: unsigned.status,
      };
      continue;
    }
    // Played by FFmpeg's HLS client over the signed URL: every segment is
    // fetched and decoded, audio to PCM and video to per-frame luma.
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
    // Frame timestamps on the delivered timeline, then per-frame mean luma.
    const frameTimes = (
      await run([
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "frame=best_effort_timestamp_time",
        "-of",
        "csv=p=0",
        videoUrl,
      ])
    )
      .split("\n")
      .map((line) => Number(line.trim().replace(/,$/u, "")))
      .filter((value) => Number.isFinite(value) && value >= 0);
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
    const pcm = new Uint8Array(await readFile(`${base}.pcm`));
    const audioStart = Number(audioProbe.streams?.[0]?.start_time ?? Number.NaN);
    const firstFrame = frameTimes[0] ?? Number.NaN;
    const lastFrame = frameTimes.at(-1) ?? Number.NaN;
    const round = (value: number) => Math.round(value * 1e6) / 1e6;
    // Everything relative to the first delivered video frame.
    const clicks = clickOnsets(pcm, SECOND).map((onset) => round(audioStart + onset - firstFrame));
    const flashTimes = flashes.map((time) => round(time - firstFrame));
    file.delivered = {
      playable: true,
      unsignedStatus: unsigned.status,
      signedManifestStatus: master.status,
      renditions: variants.length,
      separateAudioRendition: audioUri !== undefined,
      audio: audioProbe.streams?.[0],
      video: videoProbe.streams?.[0],
      decodedAudioSamples: pcm.byteLength / 4,
      decodedVideoFrames: frameCount,
      audioStartSeconds: round(audioStart - firstFrame),
      audioEndSeconds: round(audioStart + pcm.byteLength / 4 / SECOND - firstFrame),
      videoEndSeconds: round(lastFrame + 1 / FPS - firstFrame),
      clickSeconds: clicks,
      flashSeconds: flashTimes,
      syncErrorMs: flashTimes.map((flash, index) =>
        clicks[index] === undefined ? null : round((clicks[index] - flash) * 1_000),
      ),
      expectedMarkerSeconds: MARKER_FRAMES.map((frame) => round(frame / FPS)),
      inputDurationSeconds: round(CLIP_DURATION / SECOND),
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

async function remove(): Promise<void> {
  const state = await loadState();
  for (const file of state.files) {
    if (file.uid === undefined) continue;
    const deleted = await api(`/stream/${file.uid}`, { method: "DELETE" });
    const after = await api(`/stream/${file.uid}`);
    file.deleted = {
      status: deleted.status,
      verifiedGone: after.status === 404 || after.body.success === false,
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
  observe,
  play,
  delete: remove,
};
const selected = phase === undefined ? undefined : phases[phase];
if (selected === undefined)
  throw new Error(`phase must be one of ${Object.keys(phases).join(", ")}`);
await selected();
