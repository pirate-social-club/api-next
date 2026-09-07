import { expect, test } from "bun:test";
import * as BunRuntime from "bun";

type Migration = Readonly<{ tag: string }>;
type Environment = Readonly<{
  migrations?: readonly Migration[];
  vars?: Readonly<Record<string, unknown>>;
  durable_objects: Readonly<{ bindings: readonly Readonly<{ name: string }>[] }>;
}>;
type Configuration = Environment &
  Readonly<{
    migrations: readonly Migration[];
    env: Readonly<{ production: Environment; staging: Environment }>;
  }>;

const config = BunRuntime.JSONC.parse(
  await BunRuntime.file(new URL("../apps/http-worker/wrangler.jsonc", import.meta.url)).text(),
) as Configuration;

test("disabled production video preserves the deployed HTTP class lifecycle for gradual release", () => {
  const production = config.env.production;
  expect(production.vars?.VIDEO_DELIVERY_ENABLED).toBe("false");
  expect(production.migrations?.map(({ tag }) => tag)).toEqual(["v1", "v2", "v3", "v4", "v5"]);
  expect(production.migrations).toEqual(config.migrations.slice(0, 5));
  expect(production.durable_objects.bindings.map(({ name }) => name)).not.toContain(
    "VIDEO_PLAYBACK_RATE_LIMITER",
  );
});

test("development and staging retain the video limiter lifecycle and binding", () => {
  for (const environment of [config, config.env.staging]) {
    expect((environment.migrations ?? config.migrations).map(({ tag }) => tag)).toContain("v6");
    expect(environment.durable_objects.bindings.map(({ name }) => name)).toContain(
      "VIDEO_PLAYBACK_RATE_LIMITER",
    );
  }
});
