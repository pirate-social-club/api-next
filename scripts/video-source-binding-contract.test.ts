import { expect, test } from "bun:test";
import * as BunRuntime from "bun";

import type { VideoSourceGatewayEnv } from "../apps/video-source-gateway/src/index.ts";

const BINDING_KINDS = {
  CONTROL_PLANE: "platform",
  MEDIA_IMMUTABLE_ORIGINALS: "platform",
} as const satisfies { [K in keyof VideoSourceGatewayEnv]-?: "platform" | "secret" | "var" };
type GatewayConfig = {
  name?: string;
  workers_dev?: boolean;
  preview_urls?: boolean;
  hyperdrive?: readonly { binding: string }[];
  r2_buckets?: readonly { binding: string }[];
  vars?: unknown;
  secrets?: unknown;
  workflows?: unknown;
  observability?: unknown;
  routes?: unknown;
};
const config = BunRuntime.JSONC.parse(
  await BunRuntime.file(
    new URL("../apps/video-source-gateway/wrangler.jsonc", import.meta.url),
  ).text(),
) as GatewayConfig & { env: Record<string, GatewayConfig> };

test("the staging provider source origin has a reachable Worker route", async () => {
  const media = BunRuntime.JSONC.parse(
    await BunRuntime.file(
      new URL("../apps/media-processor-worker/wrangler.jsonc", import.meta.url),
    ).text(),
  ) as { env: { staging: { vars: { VIDEO_SOURCE_GATEWAY_ORIGIN: string } } } };
  const staging = config.env.staging;
  expect(media.env.staging.vars.VIDEO_SOURCE_GATEWAY_ORIGIN).toBe(
    `https://${staging?.name}.piratesocialclub.workers.dev`,
  );
  expect(staging?.workers_dev).toBe(true);
  expect(staging?.preview_urls).toBe(false);
  expect(config.workers_dev).toBe(false);
  expect(config.env.production?.workers_dev).toBe(false);
});

test("video source gateway has only its two bindings and disables request-context persistence for capability URLs", () => {
  for (const environment of ["development", "staging", "production"] as const) {
    const block = environment === "development" ? config : config.env[environment];
    if (block === undefined) throw new Error("missing gateway environment");
    expect(block.hyperdrive?.map((x: { binding: string }) => x.binding)).toEqual(["CONTROL_PLANE"]);
    expect(block.r2_buckets?.map((x: { binding: string }) => x.binding)).toEqual([
      "MEDIA_IMMUTABLE_ORIGINALS",
    ]);
    expect(Object.keys(BINDING_KINDS).sort()).toEqual(
      [...(block.hyperdrive ?? []), ...(block.r2_buckets ?? [])]
        .map((x: { binding: string }) => x.binding)
        .sort(),
    );
    expect(block.vars).toBeUndefined();
    expect(block.secrets).toBeUndefined();
    expect(block.workflows).toBeUndefined();
    expect(block.routes).toEqual(
      environment === "production"
        ? [{ pattern: "video-source.pirate.sc", custom_domain: true }]
        : undefined,
    );
    expect(block.observability).toEqual({
      enabled: false,
      logs: { enabled: false, head_sampling_rate: 1, invocation_logs: false, persist: false },
      traces: { enabled: false, persist: false },
    });
    expect(Object.keys(block).sort()).toEqual(
      (environment === "development"
        ? [
            "$schema",
            "main",
            "account_id",
            "compatibility_date",
            "compatibility_flags",
            "env",
            "name",
            "workers_dev",
            "preview_urls",
            "hyperdrive",
            "r2_buckets",
            "observability",
          ]
        : [
            "name",
            "workers_dev",
            "preview_urls",
            "hyperdrive",
            "r2_buckets",
            "observability",
            ...(environment === "production" ? ["routes"] : []),
          ]
      ).sort(),
    );
  }
});
