import { describe, expect, test } from "bun:test";

type WranglerEnvironment = Readonly<{
  readonly vars?: Readonly<Record<string, unknown>>;
  readonly secrets?: Readonly<{ readonly required?: readonly string[] }>;
}>;

type WranglerConfig = WranglerEnvironment &
  Readonly<{
    readonly env?: Readonly<Record<string, WranglerEnvironment>>;
    readonly durable_objects?: Readonly<{
      readonly bindings?: readonly Readonly<{
        readonly name: string;
        readonly class_name: string;
      }>[];
    }>;
    readonly migrations?: readonly Readonly<{
      readonly new_sqlite_classes?: readonly string[];
    }>[];
  }>;

const config = Bun.JSONC.parse(
  await Bun.file(new URL("../apps/http-worker/wrangler.jsonc", import.meta.url)).text(),
) as WranglerConfig;

const environment = (name: "development" | "staging" | "production"): WranglerEnvironment =>
  name === "development" ? config : (config.env?.[name] ?? {});

describe("staging song playback configuration", () => {
  test("enables only the reviewed staging playback posture", () => {
    const staging = environment("staging");
    expect(staging.vars?.API_NEXT_ENV).toBe("staging");
    expect(staging.vars?.SONG_PLAYBACK_ENABLED).toBe("true");
    expect(staging.vars?.SONG_PLAYBACK_R2_ACCOUNT_ID).toBe("08a4c22cf52e2ecae883e36f80a33f4a");
    expect(staging.vars?.SONG_PLAYBACK_R2_BUCKET).toBe("pirate-media-immutable-staging");
    expect(staging.vars?.MEGAPOT_REWARDS_ENABLED).toBe("false");
    expect(staging.secrets?.required).toEqual(
      expect.arrayContaining([
        "SONG_PLAYBACK_R2_ACCESS_KEY_ID",
        "SONG_PLAYBACK_R2_SECRET_ACCESS_KEY",
        "SONG_PLAYBACK_SOURCE_HMAC_BASE64",
      ]),
    );
  });

  test("prepares production playback while keeping development disabled", () => {
    const production = environment("production");
    expect(production.vars?.SONG_PLAYBACK_ENABLED).toBe("true");
    expect(production.vars?.MEGAPOT_REWARDS_ENABLED).toBe("false");
    const development = environment("development");
    expect(development.vars?.SONG_PLAYBACK_ENABLED).toBe("false");
    expect(development.vars?.SONG_PLAYBACK_R2_ACCOUNT_ID).toBe("");
    expect(development.vars?.SONG_PLAYBACK_R2_BUCKET).toBe("");
    expect(development.secrets?.required ?? []).not.toContain("SONG_PLAYBACK_R2_ACCESS_KEY_ID");
  });

  test("reuses the existing isolated limiter and migration", () => {
    expect(config.durable_objects?.bindings).toEqual(
      expect.arrayContaining([
        { name: "SONG_PLAYBACK_RATE_LIMITER", class_name: "VideoPlaybackRateLimiterDO" },
      ]),
    );
    expect(config.migrations).toEqual(
      expect.arrayContaining([{ tag: "v6", new_sqlite_classes: ["VideoPlaybackRateLimiterDO"] }]),
    );
  });
});
