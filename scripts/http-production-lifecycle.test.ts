import { expect, test } from "bun:test";
import * as BunRuntime from "bun";

type Migration = Readonly<{ tag: string }>;
type Environment = Readonly<{
  migrations?: readonly Migration[];
  vars?: Readonly<Record<string, unknown>>;
  durable_objects: Readonly<{
    bindings: readonly Readonly<{ name: string; class_name: string }>[];
  }>;
}>;
type Configuration = Environment &
  Readonly<{
    migrations: readonly Migration[];
    env: Readonly<{ production: Environment; staging: Environment }>;
  }>;

const config = BunRuntime.JSONC.parse(
  await BunRuntime.file(new URL("../apps/http-worker/wrangler.jsonc", import.meta.url)).text(),
) as Configuration;

test("production v1 includes the complete HTTP lifecycle for the coordinator's full deploy", () => {
  const production = config.env.production;
  expect(production.vars?.VIDEO_DELIVERY_ENABLED).toBe("true");
  expect(production.migrations?.map(({ tag }) => tag)).toEqual([
    "v1",
    "v2",
    "v3",
    "v4",
    "v5",
    "v6",
  ]);
  expect(production.migrations).toEqual(config.migrations);
  expect(production.durable_objects.bindings).toEqual(config.durable_objects.bindings);
  for (const name of ["SONG_PLAYBACK_RATE_LIMITER", "VIDEO_PLAYBACK_RATE_LIMITER"]) {
    expect(production.durable_objects.bindings.find((binding) => binding.name === name)).toEqual({
      name,
      class_name: "VideoPlaybackRateLimiterDO",
    });
  }
});

test("development and staging retain the video limiter lifecycle and binding", () => {
  for (const environment of [config, config.env.staging]) {
    expect((environment.migrations ?? config.migrations).map(({ tag }) => tag)).toContain("v6");
    expect(environment.durable_objects.bindings.map(({ name }) => name)).toContain(
      "VIDEO_PLAYBACK_RATE_LIMITER",
    );
  }
});
