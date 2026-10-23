import { describe, expect, test } from "bun:test";
import { moderatedDanceIntakeFacts } from "../../testing/src/moderated-dance-intake-fixture.ts";
import { makeModeratedDanceReferenceRuntime } from "./moderated-dance-reference-runtime.ts";
import { makeDirectPostgresControlPlaneLayer, type PostgresClientLike } from "./postgres.ts";
import { makeSongVideoCloudConvertTransport } from "./song-video-cloudconvert-transport.ts";

function fixture(finished = false, failed = false) {
  const { profile } = moderatedDanceIntakeFacts();
  const hash = "a".repeat(64);
  const work = {
    choreographyId: "choreo",
    segmentId: `seg-${hash}`,
    token: "observation",
    state: "normalizing",
    communityId: "community",
    songPostId: "song",
    referencePostId: "reference",
    masterRevisionId: "master",
    profile,
    normalizationHash: hash,
    source: { key: "public-master", version: "v1", etag: "etag", size: 100, sha256: hash },
    pcm: {
      songPostId: "song",
      audioRevision: 1,
      canonicalAudioSha256: hash,
      durationSamples: 480000,
      objectKey: "pcm",
      objectVersion: "v1",
      objectEtag: "etag",
      pcmSha256: hash,
      byteLength: 1920000,
      decoderRecipe: "test-pcm",
    },
    songSubmissionId: "song-submission",
    clipStartSamples: 0,
    clipDurationSamples: 288000,
    segmentIdentity: {
      segmentId: `seg-${hash}`,
      segmentTermsHash: hash,
      key: `moderated-dance/segments/${hash}/canonical.wav`,
      version: "v1",
      etag: "etag",
      size: 1152044,
      sha256: hash,
    },
    providerTag: "private-reference-choreo",
    providerJobId: finished || failed ? "job-known" : null,
    normalizationClaimed: false,
    deadlineMs: 61000,
  };
  const providerCalls: string[] = [],
    observations: unknown[] = [];
  const publications: unknown[] = [];
  let consumed = finished || failed,
    lostCommit = false,
    pendingLostCommit = false;
  const driver: PostgresClientLike = {
    connect: async () => {},
    end: async () => {},
    query: async (q) => {
      if (q.text === "COMMIT" && pendingLostCommit) {
        pendingLostCommit = false;
        throw new Error("offline purpose COMMIT response lost");
      }
      let packet: unknown = null;
      if (q.text.includes("claim_moderated_dance_reference_media_v1")) packet = work;
      else if (q.text.includes("claim_moderated_dance_reference_normalization_v1")) {
        packet = !consumed;
        consumed = true;
        if (lostCommit) {
          lostCommit = false;
          pendingLostCommit = true;
        }
      } else if (q.text.includes("publish_moderated_dance_reference_v1"))
        publications.push({
          document: JSON.parse(String(q.values?.[2])),
          claims: JSON.parse(String(q.values?.[3])),
        });
      else if (q.text.includes("record_moderated_dance_reference_provider_v1"))
        observations.push(JSON.parse(String(q.values?.[2])));
      else if (
        q.text.startsWith("SELECT ") &&
        !/set_config\(|bind_moderated_dance_replay_keys_v1|issue_moderated_dance_reference_source_v1/u.test(
          q.text,
        )
      )
        throw new Error(`unexpected offline query ${q.text}`);
      return q.text.startsWith("SELECT ")
        ? { rows: [{ packet }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    },
  };
  const forbidden = async () => {
    throw new Error("Retained segment needs no object re-creation");
  };
  const processor = makeModeratedDanceReferenceRuntime({
    runtime: makeDirectPostgresControlPlaneLayer("postgres://offline.invalid/unused", {
      clientFactory: () => driver,
      logger: { info: () => {}, error: () => {} },
    }),
    bucket: { head: forbidden, get: forbidden, put: forbidden },
    transform: makeSongVideoCloudConvertTransport({
      apiKey: "test-only",
      fetch: async (url, init) => {
        providerCalls.push(`${init.method} ${url}`);
        if (init.method === "POST")
          throw new Error("offline response lost; provider may have accepted");
        return new Response(
          JSON.stringify({
            data: failed
              ? {
                  id: "job-known",
                  tag: work.providerTag,
                  status: "error",
                  tasks: [
                    {
                      name: "import-recording",
                      operation: "import/url",
                      status: "error",
                      code: "OPEN_FAILED",
                      message: "HTTP 404 fetching https://source.test/private-object?cap=secret",
                    },
                  ],
                }
              : finished
                ? {
                    id: "job-known",
                    tag: work.providerTag,
                    status: "finished",
                    tasks: [
                      {
                        name: "export-dance",
                        operation: "export/url",
                        status: "finished",
                        result: {
                          files: [
                            "recording.framehash",
                            "frame-0.jpg",
                            "frame-1.jpg",
                            "frame-2.jpg",
                          ].map((filename) => ({
                            filename,
                            url: `https://storage.cloudconvert.com/${filename}`,
                          })),
                        },
                      },
                    ],
                  }
                : [],
          }),
        );
      },
    }),
    send: async () =>
      new Response(
        [
          "#hash: SHA256",
          `#tb 0: 1/${profile.normalizationFps}`,
          `#dimensions 0: ${profile.normalizationWidth}x${profile.normalizationHeight}`,
          ...Array.from(
            { length: 6 * profile.normalizationFps },
            (_, i) =>
              `0, ${i}, ${i}, 1, ${profile.normalizationWidth * profile.normalizationHeight}, ${"d".repeat(64)}`,
          ),
          "",
        ].join("\n"),
      ),
    replayKeys: new Map([[profile.replayKeyEpoch, new Uint8Array(32).fill(1)]]),
    gatewayOrigin: "https://source.test",
    runtimeRevision: profile.mediaRuntimeRevision,
    now: () => 2000,
    randomId: () => "observation",
  });
  return {
    processor,
    providerCalls,
    observations,
    publications,
    loseCommit: () => {
      lostCommit = true;
    },
  };
}

describe("canonical reference production with offline SQL/provider ports", () => {
  test("persists safe provider failure detail before terminal reference cleanup can run", async () => {
    const f = fixture(false, true);
    expect(await f.processor.run()).toEqual({ outcome: "failed" });
    expect(f.observations).toEqual([
      {
        status: "error",
        id: "job-known",
        tag: "private-reference-choreo",
        taskFailures: [{ task: "import-recording", code: "OPEN_FAILED", reportedHttpStatus: 404 }],
      },
    ]);
    expect(f.providerCalls).toEqual(["GET https://api.cloudconvert.com/v2/jobs/job-known"]);
    expect(f.publications).toEqual([]);
    expect(JSON.stringify(f.observations)).not.toContain("private-object");
    expect(JSON.stringify(f.observations)).not.toContain("cap=secret");
  });
  test("validated public frame hashes reach the immutable descriptor publication with both matching claims", async () => {
    const f = fixture(true);
    expect(await f.processor.run()).toEqual({ outcome: "ready" });
    expect(f.providerCalls.every((c) => c.startsWith("GET"))).toBe(true);
    expect(f.publications).toEqual([
      {
        document: expect.objectContaining({
          publicFrames: Array.from({ length: 60 }, () => "d".repeat(64)),
        }),
        claims: [
          expect.objectContaining({ kind: "raw", epoch: "test-epoch" }),
          expect.objectContaining({ kind: "body", epoch: "test-epoch" }),
        ],
      },
    ]);
  });
  test("ambiguous POST is durably unknown; repeated absent lookup never creates a second job or segment", async () => {
    const f = fixture();
    expect(await f.processor.run()).toEqual({ outcome: "unknown" });
    expect(await f.processor.run()).toEqual({ outcome: "unknown" });
    expect(f.providerCalls.filter((x) => x.startsWith("POST"))).toHaveLength(1);
    expect(f.providerCalls.filter((x) => x.startsWith("GET"))).toHaveLength(1);
    expect(f.observations).toEqual([{ status: "unknown" }, { status: "unknown" }]);
  });
  test("unknown purpose COMMIT stops before external I/O; recovery does not restore authorization", async () => {
    const f = fixture();
    f.loseCommit();
    await expect(f.processor.run()).rejects.toMatchObject({
      _tag: "ControlPlaneTransactionOutcomeUnknown",
      phase: "commit",
    });
    expect(f.providerCalls).toEqual([]);
    expect(await f.processor.run()).toEqual({ outcome: "unknown" });
    expect(f.providerCalls.filter((x) => x.startsWith("POST"))).toHaveLength(0);
    expect(f.providerCalls.filter((x) => x.startsWith("GET"))).toHaveLength(1);
  });
});
