import { expect, test } from "bun:test";
import * as BunRuntime from "bun";

test("media keeps operational logs and disables traces carrying private object and capability metadata", async () => {
  const config = BunRuntime.JSONC.parse(
    await BunRuntime.file(
      new URL("../apps/media-processor-worker/wrangler.jsonc", import.meta.url),
    ).text(),
  );
  for (const environment of [config, config.env.staging, config.env.production]) {
    expect(environment.observability).toEqual({
      enabled: true,
      logs: { enabled: true, head_sampling_rate: 1, persist: true },
      traces: { enabled: false, head_sampling_rate: 0, persist: false },
    });
  }
});
