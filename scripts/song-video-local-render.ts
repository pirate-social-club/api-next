import type {
  SongVideoExecutionEvidenceStore,
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
 * completion before it returns; the stage still observes the outcome from
 * retained evidence and the output store, exactly as it would a remote render
 * host, so a lost response is resolved by identity rather than by rendering
 * again. Nothing stateful lives in this object: a recreated renderer reads the
 * same evidence and reaches the same conclusion.
 */
export function makeLocalSongVideoRenderer(
  input: Readonly<{
    engine: LocalRenderEngine;
    output: LocalVersionedMasterStore;
    evidence: SongVideoExecutionEvidenceStore;
  }>,
): SongVideoRenderer {
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
        await input.evidence.recordExecution(request.outputObjectKey, {
          kind: "refused",
          reason: result.reason,
        });
        return { status: "refused", reason: result.reason };
      }
      // The measured output is recorded against the attempt before any byte is
      // written, so a lost acknowledgement is later resolved by identity.
      await input.evidence.recordExecution(request.outputObjectKey, {
        kind: "output",
        sha256: result.masterSha256,
        byteLength: result.masterBytes.byteLength,
      });
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
          return { status: "refused", reason: "output_conflict" };
        }
      }
      return { status: "submitted" };
    },
    observe: async ({ outputObjectKey }) => {
      const record = await input.evidence.executionEvidence(outputObjectKey);
      // Without a recorded execution there is nothing to compare against:
      // presence alone never establishes that these bytes are this attempt's.
      if (record === null) return { status: "pending" };
      if (record.kind === "refused") return { status: "refused", reason: record.reason };
      const stored = await input.output.read(outputObjectKey);
      if (stored === null) return { status: "pending" };
      if (
        stored.bytes.byteLength !== record.byteLength ||
        (await sha256Hex(stored.bytes)) !== record.sha256
      ) {
        return { status: "refused", reason: "output_conflict" };
      }
      return { status: "completed" };
    },
  };
}
