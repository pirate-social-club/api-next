import type { SongVideoRenderer } from "@pirate/application/video/song-render";
import type { SongVideoOutputStore } from "../packages/platform-cf/src/song-video-output-verification.ts";
import type { LocalSongVideoEngine } from "./song-video-ffmpeg.ts";

/**
 * Local composition of the render stage: the pinned FFmpeg engine as the
 * renderer, and a versioned object store for its output.
 *
 * This is the Bun-side counterpart of a render host, for local runs and the
 * composed test. It is not a deployment path: U.2 selected a pinned FFmpeg
 * container, but its host, cost and execution are not approved, and nothing
 * here is wired into a Worker.
 */

export type LocalVersionedMasterStore = SongVideoOutputStore &
  Readonly<{
    /** Stores a new immutable version under `key` and returns its version id. */
    write: (key: string, bytes: Uint8Array) => string;
  }>;

/** Every write is a new version; a recorded version always resolves to its own bytes. */
export function makeLocalVersionedMasterStore(): LocalVersionedMasterStore {
  const objects = new Map<string, { version: string; bytes: Uint8Array }[]>();
  let written = 0;
  return {
    write: (key, bytes) => {
      written += 1;
      const version = `local-v${written}`;
      const versions = objects.get(key) ?? [];
      versions.push({ version, bytes: bytes.slice() });
      objects.set(key, versions);
      return version;
    },
    read: async (key) => {
      const latest = objects.get(key)?.at(-1);
      return latest === undefined
        ? null
        : { bytes: latest.bytes.slice(), objectVersion: latest.version };
    },
    readVersion: async (key, version) => {
      const found = objects.get(key)?.find((entry) => entry.version === version);
      return found === undefined ? null : found.bytes.slice();
    },
  };
}

/**
 * The engine as the render stage's renderer. It writes the master to the
 * attempt's dispatched output address and reports only completion; whether
 * that output becomes a master is decided by sealing, from the bytes.
 */
export function makeLocalSongVideoRenderer(
  input: Readonly<{ engine: LocalSongVideoEngine; output: LocalVersionedMasterStore }>,
): SongVideoRenderer {
  return {
    identity: input.engine.identity,
    policyRevision: input.engine.policyRevision,
    render: async (request) => {
      const result = await input.engine.render({
        source: {
          reference: request.source.immutableRef,
          sha256: request.source.sha256,
          byteLength: request.source.byteLength,
        },
        song: {
          reference: request.song.assetRef,
          sha256: request.song.sha256,
          durationSamples: request.song.durationSamples,
        },
        clipStartSamples: request.clipStartSamples,
        clipDurationSamples: request.clipDurationSamples,
      });
      if (!result.ok) return { status: "refused", reason: result.reason };
      input.output.write(request.outputObjectKey, result.masterBytes);
      return { status: "completed" };
    },
  };
}
