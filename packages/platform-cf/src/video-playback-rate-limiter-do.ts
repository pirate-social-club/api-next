// biome-ignore lint/suspicious/noTsIgnore: cloudflare:workers exists only in the Workers runtime
// @ts-ignore cloudflare:workers exists only in the Workers runtime
import { DurableObject } from "cloudflare:workers";
import { VIDEO_PLAYBACK_ACCESS_POLICY as policy } from "../../application/src/video/playback-access.ts";
import type { VideoRateBucket, VideoRateDecision } from "./video-playback-rate-limiter.ts";

type State = {
  readonly storage: {
    readonly sql: {
      readonly exec: <T>(
        query: string,
        ...bindings: readonly (string | number)[]
      ) => { toArray(): T[] };
    };
  };
  readonly blockConcurrencyWhile: (fn: () => Promise<void>) => unknown;
};
type Row = { bucket: string; window_start_ms: number; count: number };

/** One bounded row per source, source/post or post coordination object. */
export class VideoPlaybackRateLimiterDO extends DurableObject {
  private readonly state: State;
  constructor(ctx: State, env: unknown) {
    super(ctx as never, env as never);
    this.state = ctx;
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS video_rate_window (
        id INTEGER PRIMARY KEY CHECK(id=1), bucket TEXT NOT NULL,
        window_start_ms INTEGER NOT NULL, count INTEGER NOT NULL CHECK(count>=0)
      )`);
    });
  }
  check(bucket: VideoRateBucket): VideoRateDecision {
    const limit =
      bucket === "source"
        ? policy.sourceLimit
        : bucket === "source-post"
          ? policy.sourcePostLimit
          : bucket === "post"
            ? policy.postLimit
            : 0;
    if (!limit) throw new Error("Invalid video rate bucket");
    const windowMs = policy.rateWindowSeconds * 1000;
    const now = Date.now();
    const start = Math.floor(now / windowMs) * windowMs;
    const sql = this.state.storage.sql;
    const current = sql
      .exec<Row>("SELECT bucket,window_start_ms,count FROM video_rate_window WHERE id=1")
      .toArray()[0];
    if (current && (current.bucket !== bucket || current.window_start_ms > start))
      throw new Error("Video rate bucket state mismatch");
    if (current?.window_start_ms === start && current.count >= limit)
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((start + windowMs - now) / 1000)),
      };
    sql.exec(
      `INSERT INTO video_rate_window(id,bucket,window_start_ms,count) VALUES(1,?,?,1)
      ON CONFLICT(id) DO UPDATE SET window_start_ms=excluded.window_start_ms,
        count=CASE WHEN video_rate_window.window_start_ms=excluded.window_start_ms THEN video_rate_window.count+1 ELSE 1 END`,
      bucket,
      start,
    );
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
