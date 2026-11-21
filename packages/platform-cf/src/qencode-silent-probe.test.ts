import { expect, test } from "bun:test";
import { Effect } from "effect";
import { makeQencodeMediaTransform } from "./qencode-media-transform.ts";

for (const audioCodec of [null, "aac", "opus"] as const) {
  test(`completed H264 probe reports ${audioCodec ?? "absent"} audio without starting another job`, async () => {
    let creates = 0,
      starts = 0,
      observes = 0,
      reads = 0;
    const service = makeQencodeMediaTransform({
      enabled: true,
      apiKey: "test-key-not-live",
      clock: () => 2000,
      transport: {
        createTask: async () => {
          creates++;
          throw Error("create_forbidden");
        },
        startTask: async () => {
          starts++;
          throw Error("start_forbidden");
        },
        getStatus: async () => {
          observes++;
          return {
            state: "completed",
            outputs: [
              {
                kind: "metadata",
                userTag: "pirate-probe-v1",
                systemTag: "metadata-0-0",
                url: "https://test.qencode.com/probe.json",
                outputFormat: "metadata",
                mediaFacts: {
                  codec: null,
                  sampleRateHz: null,
                  channels: null,
                  width: null,
                  height: null,
                },
              },
            ],
          };
        },
      },
      sourceGateway: {
        issue: async () => {
          throw Error("source_grant_forbidden");
        },
      },
      artifacts: {
        readJson: async () => {
          reads++;
          return {
            format: { duration: "15" },
            streams: [
              {
                codec_type: "video",
                codec_name: "h264",
                width: 720,
                height: 1280,
                avg_frame_rate: "30/1",
              },
              ...(audioCodec === null ? [] : [{ codec_type: "audio", codec_name: audioCodec }]),
            ],
          };
        },
        seal: async () => {
          throw Error("seal_forbidden");
        },
      },
    });
    const result = await Effect.runPromise(
      service.observe({
        version: "media-transform-video-probe-input-v1",
        binding: {
          operationId: "operation",
          videoRevision: 1,
          analysisRevision: 1,
          creationRevision: 1,
          canonicalVideoSha256: "a".repeat(64),
          requestId: "probe-request",
        },
        source: {
          objectKey: "sealed/input.mp4",
          sha256: "a".repeat(64),
          byteLength: 7776548,
          mediaType: "video/mp4",
        },
        attempt: {
          version: "media-transform-attempt-v1",
          providerJobId: "b".repeat(32),
          providerJobPhase: "started",
          runtimeFence: { submittedAtMs: 1000, runtimeDeadlineMs: 60000 },
        },
      }),
    );
    expect(result.status).toBe(audioCodec === "opus" ? "malformed_response" : "completed");
    expect({ creates, starts, observes, reads }).toEqual({
      creates: 0,
      starts: 0,
      observes: 1,
      reads: 1,
    });
    if (audioCodec === "opus") return;
    if (result.status !== "completed") throw Error("expected completion");
    expect(result.probe).toMatchObject({
      durationMs: 15000,
      width: 720,
      height: 1280,
      frameRateMillihertz: 30000,
      videoCodec: "h264",
      hasAudio: audioCodec !== null,
      audioCodec,
    });
    expect({ creates, starts, observes, reads }).toEqual({
      creates: 0,
      starts: 0,
      observes: 1,
      reads: 1,
    });
  });
}
