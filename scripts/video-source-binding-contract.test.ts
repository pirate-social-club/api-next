import { expect, test } from "bun:test";
import * as BunRuntime from "bun";

import type { VideoSourceGatewayEnv } from "../apps/video-source-gateway/src/index.ts";

const BINDING_KINDS = {
  CONTROL_PLANE: "platform",
  MEDIA_IMMUTABLE_ORIGINALS: "platform",
} as const satisfies { [K in keyof VideoSourceGatewayEnv]-?: "platform" | "secret" | "var" };
type GatewayConfig = {
  hyperdrive?: readonly { binding: string }[];
  r2_buckets?: readonly { binding: string }[];
  vars?: unknown;
  secrets?: unknown;
  workflows?: unknown;
  observability?: unknown;
};
const config = BunRuntime.JSONC.parse(
  await BunRuntime.file(
    new URL("../apps/video-source-gateway/wrangler.jsonc", import.meta.url),
  ).text(),
) as GatewayConfig & { env: Record<string, GatewayConfig> };

test("video source gateway has only its two bindings and never persists invocation URLs or traces", () => {
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
    expect(block.observability).toEqual({
      enabled: true,
      logs: { enabled: true, head_sampling_rate: 1, invocation_logs: false, persist: true },
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
        : ["name", "workers_dev", "preview_urls", "hyperdrive", "r2_buckets", "observability"]
      ).sort(),
    );
  }
});
