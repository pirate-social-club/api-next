import { describe, expect, test } from "bun:test";
import type { SongVideoExecutionEvidenceStore } from "@pirate/application/video/song-render";
import type { Client } from "pg";
import {
  makeWorkerSongVideoRenderer,
  makeWorkerSongVideoRenderServices,
} from "./song-video-worker-render.ts";

const request = {
  outputObjectKey: "media://immutable/song-video-masters/plan:submission/g1",
  source: {
    immutableRef: "media://immutable/op/video/1",
    sha256: "a".repeat(64),
    byteLength: 1_024,
  },
  song: {
    assetRef: "media://immutable/song/audio/1",
    sha256: "b".repeat(64),
    durationSamples: 480_000,
  },
  clipStartSamples: 0,
  clipDurationSamples: 240_000,
};

function evidenceStore(
  records: Readonly<
    Record<string, Awaited<ReturnType<SongVideoExecutionEvidenceStore["executionEvidence"]>>>
  >,
): SongVideoExecutionEvidenceStore {
  return {
    recordExecution: async () => undefined,
    executionEvidence: async (key) => records[key] ?? null,
  };
}

describe("worker song-video renderer", () => {
  test("acknowledges submission without touching the evidence store", async () => {
    const renderer = makeWorkerSongVideoRenderer(evidenceStore({}));
    expect(await renderer.submit(request)).toEqual({ status: "submitted" });
  });

  test("observes a refusal only from persisted evidence and stays pending otherwise", async () => {
    const renderer = makeWorkerSongVideoRenderer(
      evidenceStore({
        refused: { kind: "refused", reason: "master_not_exact" },
        output: { kind: "output", sha256: "c".repeat(64), byteLength: 2_048 },
      }),
    );
    expect(await renderer.observe({ outputObjectKey: "refused" })).toEqual({
      status: "refused",
      reason: "master_not_exact",
    });
    // A recorded output is not the Worker's to verify: only the accepted master
    // completes the stage, and the workflow checks that before observing.
    expect(await renderer.observe({ outputObjectKey: "output" })).toEqual({ status: "pending" });
    expect(await renderer.observe({ outputObjectKey: "absent" })).toEqual({ status: "pending" });
  });
});

type RecordedQuery = Readonly<{ text: string; values: readonly unknown[] | undefined }>;

function recordingClient() {
  const queries: RecordedQuery[] = [];
  const client = {
    query: async (
      first: string | Readonly<{ text: string; values?: readonly unknown[] }>,
      values?: readonly unknown[],
    ) => {
      const text = typeof first === "string" ? first : first.text;
      const bound = typeof first === "string" ? values : first.values;
      queries.push({ text, values: bound });
      return { rows: [], rowCount: 0 };
    },
    end: async () => undefined,
  } as unknown as Client;
  return {
    queries,
    connect: async () => client,
  };
}

describe("worker render store transaction search path", () => {
  test("selects the schema inside every transaction the store opens", async () => {
    const { connect, queries } = recordingClient();
    const { store } = makeWorkerSongVideoRenderServices({
      connect,
      output: { read: async () => null, readVersion: async () => null },
      transactionSearchPath: "api_next,pg_catalog",
    });
    expect(await store.executionEvidence(request.outputObjectKey)).toBeNull();
    expect(queries.map((entry) => entry.text.replace(/\s+/gu, " ").trim())).toEqual([
      "BEGIN",
      "SELECT set_config('search_path', $1, true)",
      "SELECT expected_output_sha256, expected_output_byte_length::text, execution_refusal_reason FROM media_song_video_render_attempts WHERE dispatch_output_key = $1",
      "COMMIT",
    ]);
    expect(queries[1]?.values).toEqual(["api_next,pg_catalog"]);
  });
});
