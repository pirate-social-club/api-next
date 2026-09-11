import type {
  SongVideoOutputWriter,
  SongVideoRenderer,
} from "@pirate/application/video/song-render";
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
 *
 * Its output address is written once. A repeated execution at the same address
 * never replaces bytes: it reconciles what the store holds against what this
 * execution produced, and only identical output counts as this attempt's.
 */

export type LocalVersionedMasterStore = SongVideoOutputStore & SongVideoOutputWriter;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A write counts only for the first writer; later writes report `occupied`. */
export function makeLocalVersionedMasterStore(): LocalVersionedMasterStore {
  const objects = new Map<string, { version: string; etag: string; bytes: Uint8Array }>();
  let written = 0;
  return {
    writeOnce: async (key, bytes) => {
      if (objects.has(key)) return { status: "occupied" };
      written += 1;
      objects.set(key, {
        version: `local-v${written}`,
        etag: `local-etag-${written}`,
        bytes: bytes.slice(),
      });
      return { status: "written" };
    },
    read: async (key) => {
      const found = objects.get(key);
      return found === undefined
        ? null
        : { bytes: found.bytes.slice(), objectVersion: found.version, etag: found.etag };
    },
    readVersion: async (key, version) => {
      const found = objects.get(key);
      return found === undefined || found.version !== version ? null : found.bytes.slice();
    },
  };
}

type LocalRenderEngine = Pick<LocalSongVideoEngine, "identity" | "policyRevision" | "render">;

/**
 * The engine as the render stage's renderer. Locally a submission renders to
 * completion before it returns; the stage still observes the outcome from the
 * output store, exactly as it would a remote render host, so a lost response
 * is resolved by what was written rather than by rendering again. Refusals are
 * kept per output address so an observation after a lost refusal reports it.
 */
export function makeLocalSongVideoRenderer(
  input: Readonly<{ engine: LocalRenderEngine; output: LocalVersionedMasterStore }>,
): SongVideoRenderer {
  const refusals = new Map<string, string>();
  return {
    identity: input.engine.identity,
    policyRevision: input.engine.policyRevision,
    submit: async (request) => {
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
      if (!result.ok) {
        refusals.set(request.outputObjectKey, result.reason);
        return { status: "refused", reason: result.reason };
      }
      const write = await input.output.writeOnce(
        request.outputObjectKey,
        result.masterBytes,
        result.masterSha256,
      );
      if (write.status === "occupied") {
        // The address already holds bytes: a lost acknowledgement or a crossed
        // attempt. Nothing is replaced. Only identical output is this
        // execution's, and its identity is established from the stored bytes.
        const stored = await input.output.read(request.outputObjectKey);
        if (stored === null) throw new Error("song video output is occupied but unreadable");
        if (
          stored.bytes.byteLength !== result.masterBytes.byteLength ||
          (await sha256Hex(stored.bytes)) !== result.masterSha256
        ) {
          refusals.set(request.outputObjectKey, "output_conflict");
          return { status: "refused", reason: "output_conflict" };
        }
      }
      return { status: "submitted" };
    },
    observe: async ({ outputObjectKey }) => {
      // A recorded refusal names this address, so it outranks an object that
      // appeared there afterwards.
      const reason = refusals.get(outputObjectKey);
      if (reason !== undefined) return { status: "refused", reason };
      if ((await input.output.read(outputObjectKey)) !== null) return { status: "completed" };
      return { status: "pending" };
    },
  };
}
