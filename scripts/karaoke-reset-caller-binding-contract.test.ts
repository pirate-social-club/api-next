import { expect, test } from "bun:test";
import * as BunRuntime from "bun";
import { Schema } from "effect";
import type { StagingKaraokeResetCallerEnv } from "../apps/staging-karaoke-reset-caller/worker-configuration.d.ts";
import type { KaraokeResetCallerBindings } from "../packages/platform-cf/src/karaoke-reset-caller.ts";

const kinds = {
  API_NEXT_ENV: "var",
  KARAOKE_RESET_ENABLED: "var",
  KARAOKE_RESET_CALLER_ORIGIN: "var",
  KARAOKE_RESET_ACCESS_ISSUER: "secret",
  KARAOKE_RESET_ACCESS_AUDIENCE: "secret",
  KARAOKE_RESET_ACCESS_SUBJECT: "secret",
  RESET_OPERATOR: "platform",
} as const satisfies { [K in keyof KaraokeResetCallerBindings]-?: "var" | "secret" | "platform" };

const generatedKeys = {
  API_NEXT_ENV: true,
  KARAOKE_RESET_ENABLED: true,
  RESET_OPERATOR: true,
} satisfies { [K in keyof StagingKaraokeResetCallerEnv]: true };

const blockFields = {
  name: Schema.String,
  workers_dev: Schema.Boolean,
  preview_urls: Schema.Boolean,
  vars: Schema.Record(Schema.String, Schema.String),
  observability: Schema.Unknown,
};
const Configuration = Schema.Struct({
  ...blockFields,
  $schema: Schema.String,
  main: Schema.String,
  compatibility_date: Schema.String,
  compatibility_flags: Schema.Array(Schema.String),
  env: Schema.Struct({
    staging: Schema.Struct({
      ...blockFields,
      services: Schema.Array(
        Schema.Struct({
          binding: Schema.String,
          service: Schema.String,
          entrypoint: Schema.String,
        }),
      ),
    }),
  }),
});
// Closed shape also rejects routes, storage, queues, cron and extra environments.
const config = Schema.decodeUnknownSync(Configuration, { onExcessProperty: "error" })(
  BunRuntime.JSONC.parse(
    await BunRuntime.file(
      new URL("../apps/staging-karaoke-reset-caller/wrangler.jsonc", import.meta.url),
    ).text(),
  ),
);

test("reset caller is disabled, staging-only and has exactly one named service binding", () => {
  expect(Object.keys(generatedKeys).sort()).toEqual(
    [
      ...Object.keys(config.env.staging.vars),
      ...config.env.staging.services.map((service: { binding: string }) => service.binding),
    ].sort(),
  );
  expect(Object.keys(config.env)).toEqual(["staging"]);
  for (const block of [config, config.env.staging]) {
    expect(block.workers_dev).toBe(false);
    expect(block.preview_urls).toBe(false);
    expect(block.vars.KARAOKE_RESET_ENABLED).toBe("false");
    expect(Object.keys(block.vars).sort()).toEqual(["API_NEXT_ENV", "KARAOKE_RESET_ENABLED"]);
    expect(block.observability).toEqual({
      enabled: false,
      logs: { enabled: false, invocation_logs: false, persist: false },
      traces: { enabled: false, persist: false },
    });
  }
  expect(config.env.staging.vars.API_NEXT_ENV).toBe("staging");
  expect(config.env.staging.services).toEqual([
    {
      binding: "RESET_OPERATOR",
      service: "pirate-http-worker-staging",
      entrypoint: "KaraokeResetOperatorEntrypoint",
    },
  ]);
  expect(
    Object.entries(kinds)
      .filter(([, value]) => value === "platform")
      .map(([name]) => name),
  ).toEqual(["RESET_OPERATOR"]);
});
