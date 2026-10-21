import { describe, expect, test } from "bun:test";
import { moderatedDanceIntakeFacts } from "../../testing/src/moderated-dance-intake-fixture.ts";
import { makeModeratedDanceReferenceRuntime } from "./moderated-dance-reference-runtime.ts";
import { makeDirectPostgresControlPlaneLayer, type PostgresClientLike } from "./postgres.ts";
import { makeSongVideoCloudConvertTransport } from "./song-video-cloudconvert-transport.ts";

function fixture() {
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
    providerJobId: null,
    normalizationClaimed: false,
    deadlineMs: 61000,
  };
  const providerCalls: string[] = [],
    observations: unknown[] = [];
  let consumed = false,
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
      } else if (q.text.includes("record_moderated_dance_reference_provider_v1"))
        observations.push(JSON.parse(String(q.values?.[2])));
      else if (
        q.text.startsWith("SELECT ") &&
        !/set_config\(|issue_moderated_dance_reference_source_v1/u.test(q.text)
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
        return new Response(JSON.stringify({ data: [] }));
      },
    }),
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
    loseCommit: () => {
      lostCommit = true;
    },
  };
}

describe("canonical reference production with offline SQL/provider ports", () => {
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
