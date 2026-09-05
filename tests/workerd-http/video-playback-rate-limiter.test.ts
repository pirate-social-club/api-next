/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { runInDurableObject, env as testEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { VideoPlaybackRateLimiterDO } from "../../packages/platform-cf/src/video-playback-rate-limiter-do.ts";

const env = testEnv as unknown as {
  VIDEO_PLAYBACK_RATE_LIMITER: DurableObjectNamespace<VideoPlaybackRateLimiterDO>;
};
describe("video limiter SQLite objects", () => {
  it("admits only six concurrent source/post attempts and retains one durable row", async () => {
    const stub = env.VIDEO_PLAYBACK_RATE_LIMITER.getByName(crypto.randomUUID());
    const results = await Promise.all(Array.from({ length: 12 }, () => stub.check("source-post")));
    expect(results.filter((result) => result.allowed)).toHaveLength(6);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT count FROM video_rate_window").toArray()).toEqual([
        { count: 6 },
      ]);
    });
    await runInDurableObject(stub, async (instance: VideoPlaybackRateLimiterDO) => {
      expect(() => instance.check("post")).toThrow("state mismatch");
    });
  });
  it("rolls an expired window without retaining a history of counters", async () => {
    const stub = env.VIDEO_PLAYBACK_RATE_LIMITER.getByName(crypto.randomUUID());
    await stub.check("source");
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("UPDATE video_rate_window SET window_start_ms=0,count=120 WHERE id=1");
    });
    expect(await stub.check("source")).toEqual({ allowed: true, retryAfterSeconds: 0 });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT count FROM video_rate_window").toArray()).toEqual([
        { count: 1 },
      ]);
    });
  });
});
